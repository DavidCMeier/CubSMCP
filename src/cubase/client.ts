import { AsyncLocalStorage } from 'node:async_hooks';
import { CubaseBridge, isTimeout, type RequestOptions } from '../bridge/midiBridge.js';
import {
  curveForKey,
  defaultTolerance,
  displayMatches,
  displayResolution,
  formatTimeDisplay,
  isNumericDisplay,
  parseDisplay,
  parseSwitch,
  parseTimeDisplay,
  type ValueCurve,
} from './display.js';
import {
  applyBankAction,
  describeEntry,
  matchChannelName,
  parseChannelRef,
  planBankMoves,
  type BankAction,
  type BankEntry,
  type ChannelRef,
  type MatchKind,
  type NameMatch,
} from './bank.js';

export type { BankAction, ChannelRef } from './bank.js';

/**
 * A bridge value as the script reports it: v normalized 0..1, d display, u units, t the title of the object
 * that owns the parameter (the channel for volume, "Standard Panner" for pan, the send for send levels), n the
 * parameter name, ch the channel the key belongs to (raw reads only), stale when the value belongs to no
 * channel (an empty bank slot, a send without destination, a selection that moved to a track without mixer channel).
 */
export interface ValueState {
  v: number | null;
  d: string | null;
  u: string | null;
  t?: string;
  n?: string;
  ch?: string;
  stale?: boolean;
  /** Meter keys (ch.N.meter): peak since the last meter reset, and the RMS of the level over the time the transport played. */
  max?: number;
  avg?: number | null;
}

export interface ChannelInfo {
  index: number;
  title: string;
  color: number[] | null;
  active: boolean;
  sendTitles: string[];
  /** Cubase unique id (state.channels with uids; older scripts leave it out). */
  uid?: string | null;
  values?: Record<string, ValueState>;
}

/** A channel a tool acts on, with what identifies it beyond its (possibly repeated) name. */
export interface ResolvedChannel extends ChannelInfo {
  uid: string | null;
  matchedBy: MatchKind;
  /** 0-based position in MixConsole bank order, when known. */
  position?: number;
  /** 1-based bank page (counted from the first channel) the channel is on, when known. */
  page?: number;
}

export interface BankMove {
  action: BankAction | 'goToPage' | 'showChannel';
  /** False when the action was not sent because the bank is already at that end. */
  sent: boolean;
  moved: boolean;
  bankSize: number;
  count: number;
  /** The page is not full: it is the last one. */
  atEnd: boolean;
  /** The page only repeats the last channel (a next from a full last page). */
  repeatsLastChannel: boolean;
  /** Position of the first slot in MixConsole bank order, null when unknown. */
  position: number | null;
  /** The bank starts at the first channel. */
  atStart: boolean;
  /** 1-based bank page (counted from the first channel) that index 0 is on; null when the position is unknown. After a shift the bank straddles two pages. */
  page: number | null;
  channels: BankSlot[];
}

/** DirectAccess tag of a mixer channel's name ("Nombre"/"Name"): writing its display renames the channel. */
export const NAME_TAG = 1024;

/** DirectAccess tag of a mixer channel's output ("Salida"/"Output"): readable, but Cubase ignores writes to it. */
export const OUTPUT_TAG = 4102;

/** A channel the DirectAccess mixer tree reports hidden in the MixConsole. */
export interface HiddenChannel {
  title: string;
  uid: string | null;
  uniqueName?: string | null;
}

/** The DirectAccess mixer tree as 'mixer.channels' reports it: the bank channels of the page shown now, and the hidden ones. */
export interface MixerState {
  channels: Map<number, MixerChannelInfo>;
  /** null when the bridge script or Cubase does not report visibility. */
  hidden: HiddenChannel[] | null;
}

export interface BankSlot {
  index: number;
  title: string;
  uid: string | null;
}

interface BankPage {
  size: number;
  /** Named slots only. */
  slots: BankSlot[];
  firstUid: string | null;
  lastUid: string | null;
}

/** What a pass over the bank learnt: every channel in order and where the bank is. */
interface BankScan {
  size: number;
  /** Indexed by position. */
  entries: BankEntry[];
  /** First uid of each page (enough to find pages with scripts that do not report every uid). */
  pageFirst: Map<string, number>;
  pages: number;
  /** Offset the bank shows now. */
  offset: number;
  /** Offset of the page the work started from, null when unknown. */
  start: number | null;
  startUid: string | null;
}

/** Visits a bank page; returns true when the page is the last one. skip(page) lets a later pass leave out pages it has nothing to do on (the bank does not move there). */
export type PageVisit = ((page: number) => Promise<boolean | void>) & { skip?: (page: number) => boolean };

const BANK_NOT_RESTORED =
  'The mixer bank could not be put back on the page it was on, so it shows its first page now: check bank indexes with cubase_list_channels.';

const pagesLookedAt = (pages: number) => `any mixer bank page (${pages} ${pages === 1 ? 'page' : 'pages'} looked at)`;

function locate(scan: BankScan, uid: string | null): number | null {
  if (!uid) return null;
  const entry = scan.entries.find((e) => e.uid === uid);
  return entry ? entry.position : (scan.pageFirst.get(uid) ?? null);
}

function uidAt(scan: BankScan, offset: number): string | null {
  const uid = scan.entries[offset]?.uid;
  if (uid) return uid;
  for (const [first, at] of scan.pageFirst) if (at === offset) return first;
  return null;
}

function slotsAt(scan: BankScan, offset: number): BankSlot[] {
  return scan.entries.slice(offset, offset + scan.size).map((e, i) => ({ index: i, title: e.title, uid: e.uid }));
}

function sameSlots(a: BankSlot[], b: BankSlot[]): boolean {
  return a.length === b.length && a.every((s, i) => s.index === b[i].index && s.title === b[i].title && (!s.uid || !b[i].uid || s.uid === b[i].uid));
}

const pageSignature = (page: BankPage) => [page.firstUid, ...page.slots.map((s) => `${s.index}:${s.title}:${s.uid}`)].join('\n');

export interface PluginIdentity {
  name: string;
  vendor: string;
  version: string;
  format: string;
}

/**
 * A plugin slot of the selected track as 'plugins.selected' reports it: empty when no plugin is named, missing
 * when a plugin is named but has no plugin object (not installed: Cubase keeps a placeholder, and reports its own
 * vendor for it); null when the script could not tell.
 */
export interface PluginPresence extends PluginIdentity {
  slot: string;
  empty?: boolean;
  missing?: boolean | null;
  on: number | null;
  bypass: number | null;
  edit?: number | null;
}

export interface SelectedInfo {
  title: string;
  /** Unique id of the selected mixer channel, when Cubase gives one. */
  uid?: string | null;
  color: number[] | null;
  sendTitles: string[];
  /** Selected flag of the selection object itself (null/undefined with older bridge scripts). */
  selectedFlag?: number | null;
  /** Bank channels whose own selected flag is on. */
  bankSelected?: Array<{ index: number; title: string }>;
  plugins: Record<string, PluginIdentity>;
  values: Record<string, ValueState>;
}

/**
 * DirectAccess tags of the transport object (scope "transport"), from the live read of Cubase 13 (14 Oct 2026, 101
 * parameters, none of them the tempo): the cursor time, the cycle locators, "return to start position on stop",
 * the time signature, and the buttons that act when written 1 (then 0): step a bar, nudge the cursor.
 */
export const TRANSPORT_TAGS = {
  time: 4023,
  left: 4030,
  right: 4031,
  returnOnStop: 4148,
  signature: 4027,
  timeFormat: 4025,
  stepBar: 5,
  stepBackBar: 6,
  nudgeUp: 4096,
  nudgeDown: 4097,
} as const;

/** The normalized value of the transport's primary time format that shows seconds ("Segundos"; 0 is bars and beats). */
const SECONDS_TIME_FORMAT = 0.25;

/** What a transport button (or the key command tried after it) did to the cursor. */
export interface TransportStep {
  /** directAccess: the DirectAccess button moved the cursor; command: the key command did; null: nothing moved (or unknown). */
  via: 'directAccess' | 'command' | null;
  moved: boolean | null;
  before: TransportPosition | null;
  position: TransportPosition | null;
  note?: string;
}

/** Positions where "Locate Next Marker" stopped, from the project start. */
export interface MarkerScan {
  markers: Array<{ number: number; time: string | null; seconds: number | null }>;
  projectEnd: { time: string | null; seconds: number | null } | null;
  cursorRestored: boolean;
  complete: boolean;
}

/** Cursor and cycle locators as DirectAccess shows them; seconds are null when Cubase shows another time format. */
export interface TransportPosition {
  time: number | null;
  timeDisplay: string | null;
  left?: number | null;
  leftDisplay?: string | null;
  right?: number | null;
  rightDisplay?: string | null;
}

/** What a marker command did, checked against the cursor (and the locators for cycle markers). */
export interface MarkerLocation {
  command: string;
  /** False when DirectAccess gave no position: nothing could be checked. */
  verified: boolean;
  /** null when it could not be told. */
  markerFound: boolean | null;
  /** The cursor or the locators ended somewhere else than before. */
  moved: boolean | null;
  before: TransportPosition | null;
  position: TransportPosition | null;
  note?: string;
}

/** Kind of a mixer channel, from its DirectAccess internal name ("Audio 14", "GroupChannel 3", "OutputChannel"...). */
export type ChannelKind = 'audio' | 'instrument' | 'sampler' | 'midi' | 'group' | 'fx' | 'vca' | 'output' | 'input' | 'unknown';

export function channelKind(uniqueName: string | null | undefined, typeName?: string | null): ChannelKind {
  const name = `${uniqueName ?? ''}`.trim();
  const rules: Array<[RegExp, ChannelKind]> = [
    [/^audio/i, 'audio'],
    // Live (15 Oct 2026): Cubase names instrument outputs (Superior Drummer's multi-out) "Synth" and MIDI tracks "MidiChannel".
    [/^(instrument|vsti|inst\b|rack|synth)/i, 'instrument'],
    [/^sampler/i, 'sampler'],
    [/^midi/i, 'midi'],
    [/^group/i, 'group'],
    [/^(fx|effect)/i, 'fx'],
    [/^vca/i, 'vca'],
    [/^(output|master|stereo ?out)/i, 'output'],
    [/^input/i, 'input'],
  ];
  for (const [pattern, kind] of rules) if (pattern.test(name)) return kind;
  for (const [pattern, kind] of rules) if (typeName && pattern.test(typeName)) return kind;
  return 'unknown';
}

/** A bank channel in the DirectAccess mixer tree (see 'mixer.channels'). */
export interface MixerChannelInfo {
  index: number;
  /** Unique id (bridge scripts from this version on). */
  uid?: string | null;
  /** DirectAccess object id: valid until tracks are added or removed, never keep it across calls. */
  objectId: number;
  uniqueName: string | null;
  typeName: string | null;
  kind: ChannelKind;
  params?: Record<string, { value: number | null; display: string | null }>;
}

export interface SnapshotPage {
  fields: string[];
  /** Bank size: a page with fewer named channels is the last one. */
  size: number;
  /** kind: set for channels whose kind lacks some fields (see MISSING_FIELDS); those values are null. */
  channels: Array<{ index: number; title: string; uid: string | null; values: Array<number | null>; kind?: ChannelKind }>;
}

/**
 * Fields a channel kind does not have, by DirectAccess kind: a MIDI channel has no Pre section and no sends, a
 * VCA fader has no pan either. Cubase never updates those values for such a channel, so its bank slot keeps the
 * ones of the channel it showed before (or none at all): they are read as null, whatever the slot showed before.
 */
export const MISSING_FIELDS: Partial<Record<ChannelKind, RegExp>> = { midi: /^(pre|send)\./, vca: /^(pan$|pre\.|send\.)/ };

/** Mix fields (as snapshots name them) whose writes the client remembers, to tell which change an undo reverted. */
const MIX_WRITE_FIELD = /^(volume|pan|mute|solo|pre\.(gain|phase|lowCutOn|lowCutFreq)|send\.\d+\.(level|on|prePost))$/;
/** How many recent writes the client remembers. */
const KEPT_WRITES = 20;

/** A mix value this server wrote (see CubaseClient.recentWrites). */
export interface WriteRecord {
  /** Channel the bank slot (or the selection) showed when the write was sent; null when the server had not read it. */
  channel: string | null;
  uid: string | null;
  /** Bank index on the page shown then; null for the selected track (sel.* keys). */
  index: number | null;
  /** Field as snapshots name it: volume, pan, pre.gain, send.0.level... */
  field: string;
  /** Date.now() of the last write to it. */
  at: number;
}

export type SelectionInfo = Pick<SelectedInfo, 'title' | 'uid' | 'selectedFlag' | 'bankSelected'>;

/** The channel selected before a tool selected another one: index and uid on the bank page shown when the call began. */
export interface PreviousSelection {
  title: string | null;
  index: number | null;
  uid: string | null;
  /** Its record switch before (null when unknown): selecting it again arms it, so restoreSelection puts this back. */
  recordEnabled?: boolean | null;
}

/**
 * What selecting a channel changed besides the selection. With Cubase's preference "Enable Record on Selected
 * Audio Track" selecting a track record-arms it (and Cubase creates an empty take file in Audio/ each time).
 */
export interface SelectionSideEffects {
  /** The channel selected before (null: none, or a track without mixer channel). */
  previousSelection: string | null;
  /** False when the channel was already selected (then nothing was written). */
  selectionChanged: boolean;
  /** Record enable of the channel after selecting it (null when unknown). */
  recordEnabled: boolean | null;
  /** Record was off before the selection and on after it. */
  armedBySelection: boolean;
  /** Record switched off again (disarm option). */
  disarmed?: Applied;
  /** The previous selection restored (restoreSelection option). */
  restoredSelection?: { channel: string; applied: Applied; disarmed?: Applied } | { skipped: string } | { error: string };
}

/** A DirectAccess parameter as the script describes it. */
export interface DirectParameter {
  tag: number;
  title: string | null;
  value: number | null;
  display: string | null;
  units: string | null;
  [key: string]: unknown;
}

/** Verdict on a display write: Cubase ignores a text it does not understand, without an error. */
export interface DisplayVerdict {
  /** Value or display moved (null when the script did not report the value before). */
  changed: boolean | null;
  /** Cubase shows what was asked for (the same text, or the same number at its display resolution). */
  matches: boolean;
  /** For a number: matches; for a word: matches or changed. */
  applied: boolean;
}

export function judgeDisplayWrite(
  requested: string,
  before: { value: number | null; display: string | null } | null | undefined,
  after: { value: number | null; display: string | null; units: string | null },
): DisplayVerdict {
  const changed = before
    ? before.display !== after.display || (before.value !== null && after.value !== null && Math.abs(before.value - after.value) > 1e-6)
    : null;
  const matches = displayMatches(requested, after.display, after.units);
  return { changed, matches, applied: isNumericDisplay(requested) ? matches : matches || changed === true };
}

/**
 * Verdict on a normalized write: Cubase ignores some writes without an error (a read-only parameter, a tag of
 * another object) and snaps others to its grid (a mode list, a switch). matches: Cubase holds the value asked
 * for (float32 precision); changed: the value moved from before; applied: either of them.
 */
export function judgeNormalizedWrite(
  requested: number,
  before: { value: number | null; display: string | null } | null | undefined,
  after: { value: number | null; display: string | null },
): DisplayVerdict {
  const changed = before
    ? before.display !== after.display || (before.value !== null && after.value !== null && Math.abs(before.value - after.value) > 1e-6)
    : null;
  const matches = after.value !== null && Math.abs(after.value - requested) < 1e-4;
  return { changed, matches, applied: matches || changed === true };
}

export interface Selection {
  /** Title of the selected track, or null when it has no mixer channel. */
  title: string | null;
  hasMixerChannel: boolean;
  bankSelected: Array<{ index: number; title: string }>;
}

export interface SeekResult {
  key: string;
  target: number;
  /** The value Cubase shows at the end (read back after the last write). */
  achieved: number | null;
  display: string | null;
  units: string | null;
  /** The normalized value Cubase applied (read back), not the one the search asked for. */
  normalized: number;
  /** Writes made (0 when the value already matched). */
  iterations: number;
  /** Whether the value Cubase shows at the end is within tolerance of the target. */
  withinTolerance: boolean;
  /** Only when the target was not reached because the control ends before it (e.g. a fader above +6.02 dB). */
  clamped?: true;
}

/** True when the selection object still points at a mixer channel that is no longer selected. */
export function isSelectionStale(selected: Pick<SelectedInfo, 'selectedFlag'>): boolean {
  return typeof selected.selectedFlag === 'number' && selected.selectedFlag < 0.5;
}

/**
 * Error for a stale selection: Cubase 13 empties the selection object's title, but the sel.* values keep the
 * object title of the channel they still belong to, so that is the channel named.
 */
export function staleSelectionMessage(selected: Pick<SelectedInfo, 'title'> & { values?: Record<string, ValueState> }): string {
  const bound = selected.title || selected.values?.['sel.selected']?.t || selected.values?.['sel.volume']?.t || '';
  const target = bound ? ` still points at "${bound}" (the sel.* values belong to that channel)` : ' is not bound to any channel';
  return `The selected track has no mixer channel (folder, MIDI, marker track...), so the channel strip${target}. Pass "channel" to choose one.`;
}

/** Whether the selection is this bank channel (by bank index too, because names repeat). */
function selectionIs(info: SelectionInfo, channel: { index: number; title: string }): boolean {
  // Scripts without bankSelected only give the title.
  const inBank = info.bankSelected ? info.bankSelected.some((b) => b.index === channel.index && b.title === channel.title) : true;
  return inBank && info.title === channel.title && !isSelectionStale(info);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SeekOptions {
  /**
   * Stop as soon as the display is this close to the target. Without it the search goes on until Cubase
   * shows the target at the resolution of its display ("-3.00", not the first "-3.14" within 0.15 dB),
   * or until no display lies between two neighbouring writes.
   */
  tolerance?: number;
  maxIterations?: number;
  /** What Cubase shows before the search: it starts from there and writes nothing when it already matches. */
  start?: ValueState;
  /** Known mapping from units to normalized (see curveForKey): the first write goes next to the target. */
  curve?: ValueCurve;
  /** Units of the target, for the tolerance (default: the curve's, else what the display shows). */
  unit?: string;
  /**
   * What to do when the value is a switch ("On"/"Off", "Activ."/"Desact."): "reject" (default) fails before
   * writing anything; "set" writes on for a target >= 0.5 and off below it.
   */
  switches?: 'reject' | 'set';
}

interface SeekPoint {
  n: number;
  value: number;
  state: ValueState;
}

/** Two writes closer than this are neighbours: nothing to find between them. */
const MIN_SEEK_WIDTH = 5e-5;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** A switch: one write (none when it is already there), on for targets >= 0.5. */
async function seekSwitch(
  probe: (normalized: number) => Promise<ValueState>,
  target: number,
  start: ValueState,
): Promise<Omit<SeekResult, 'key'>> {
  const on = target >= 0.5;
  let state = start;
  let iterations = 0;
  if (parseSwitch(start.d) !== on) {
    state = await probe(on ? 1 : 0);
    iterations = 1;
  }
  const now = parseSwitch(state.d);
  if (now === null) throw new Error(`Cubase shows "${state.d}" after the write: this is not a switch. Write it with display or normalized instead.`);
  return { target, achieved: now ? 1 : 0, display: state.d, units: state.u, normalized: state.v ?? (on ? 1 : 0), iterations, withinTolerance: now === on };
}

/**
 * Searches the normalized value whose display matches a target in real units, over a monotonic mapping.
 * It starts from the current value (options.start) or, with a known curve, next to the target, and widens
 * its steps only as far as needed: the extremes of a live parameter are written only when the target lies
 * beyond them. Then it narrows the bracket (interpolating, every other step bisecting) until Cubase shows the
 * target at its display resolution, the two sides are neighbouring displays, or maxIterations. It ends on the
 * closest value seen and reports what Cubase shows and applied there.
 */
export async function seekMonotonic(
  probe: (normalized: number) => Promise<ValueState>,
  target: number,
  options: SeekOptions = {},
): Promise<Omit<SeekResult, 'key'>> {
  const maxIterations = options.maxIterations ?? 24;
  const curve = options.curve;
  const start = options.start && options.start.v !== null ? options.start : undefined;

  const startSwitch = start ? parseSwitch(start.d) : null;
  if (!curve && start && startSwitch !== null) {
    if (options.switches !== 'set') {
      throw new Error(`This value is a switch (Cubase shows "${start.d}"): write it as normalized 0 (off) or 1 (on) instead of searching units`);
    }
    // "Off" can also be the bottom of a continuous control (a filter switched off): only 0..1 targets switch it.
    if (startSwitch || (target >= 0 && target <= 1)) return seekSwitch(probe, target, start);
  }
  const startParsed = start ? parseDisplay(start.d, start.u) : null;
  if (start && start.d && !startParsed) {
    throw new Error(`Cannot read the display "${start.d}" as a number: write this value with display (the text Cubase shows) or normalized instead`);
  }

  const unit = options.unit ?? curve?.unit ?? startParsed?.unit ?? '';
  const tolerance = options.tolerance ?? defaultTolerance(target, unit);
  // Two equal infinities ("-oo" for -Infinity) are a hit.
  const errorOf = (value: number) => (value === target ? 0 : Math.abs(value - target));
  const matches = (p: SeekPoint) => {
    if (options.tolerance !== undefined) return errorOf(p.value) <= options.tolerance;
    const resolution = displayResolution(p.state.d, p.state.u);
    return p.value === target || (resolution !== null && errorOf(p.value) <= resolution / 2 + 1e-9);
  };
  // Interpolation runs on the curve's scale when there is one (log frequency, fader law), where the mapping is nearly straight.
  const position = (value: number) => (curve ? curve.toNormalized(value) : value);

  const points: SeekPoint[] = [];
  if (start && startParsed) points.push({ n: start.v as number, value: startParsed.value, state: start });
  let last: SeekPoint | null = points[0] ?? null;
  let iterations = 0;
  let increasing = true;
  let step = curve ? 0.02 : 0.05;
  let bracketSteps = 0;
  let edgeReached = false;

  const next = (): number | null => {
    if (curve && iterations === 0) return clamp01(curve.toNormalized(target));
    if (points.length === 0) return 0.5;
    if (!curve) {
      // Direction from the two points furthest apart (most controls grow with the normalized value).
      const sorted = [...points].sort((a, b) => a.n - b.n);
      const [first, end] = [sorted[0], sorted[sorted.length - 1]];
      if (end.n > first.n && end.value !== first.value) increasing = end.value > first.value;
    }
    const below = points.filter((p) => p.value < target);
    const above = points.filter((p) => p.value > target);
    const nearest = (list: SeekPoint[], highest: boolean) => list.reduce((a, b) => ((highest ? b.n > a.n : b.n < a.n) ? b : a));
    if (below.length > 0 && above.length > 0) {
      const lo = nearest(below, increasing);
      const hi = nearest(above, !increasing);
      const width = Math.abs(hi.n - lo.n);
      if (width < MIN_SEEK_WIDTH) return null;
      if (Number.isFinite(lo.value) && Number.isFinite(hi.value)) {
        const resolution = Math.max(displayResolution(lo.state.d, lo.state.u) ?? 0, displayResolution(hi.state.d, hi.state.u) ?? 0);
        // Neighbouring displays: Cubase shows nothing in between.
        if (resolution > 0 && hi.value - lo.value <= resolution * 1.001) return null;
      }
      const mid = (lo.n + hi.n) / 2;
      bracketSteps++;
      // Interpolation alone can crawl along one side: every other step bisects.
      if (bracketSteps % 2 === 0) return mid;
      const [pl, ph, pt] = [position(lo.value), position(hi.value), position(target)];
      if (![pl, ph, pt].every(Number.isFinite) || ph === pl) return mid;
      const x = lo.n + ((pt - pl) / (ph - pl)) * (hi.n - lo.n);
      const from = Math.min(lo.n, hi.n);
      return Math.min(Math.max(x, from + width * 0.05), from + width * 0.95);
    }
    // Everything seen is on one side of the target: step further that way, doubling the step.
    const side = below.length > 0 ? below : above;
    const up = below.length > 0 === increasing;
    const edge = nearest(side, up).n;
    if (up ? edge >= 1 : edge <= 0) {
      edgeReached = true;
      return null;
    }
    const x = clamp01(edge + (up ? step : -step));
    step *= 2;
    return x;
  };

  if (!last || !matches(last)) {
    while (iterations < maxIterations) {
      const n = next();
      if (n === null) break;
      const state = await probe(n);
      iterations++;
      const parsed = parseDisplay(state.d, state.u);
      if (!parsed) {
        if (parseSwitch(state.d) !== null) throw new Error(`Cubase shows "${state.d}": this value is a switch, write it as normalized 0 (off) or 1 (on)`);
        if (points.length > 0) break;
        throw new Error(`Cannot read the display "${state.d}" as a number: write this value with display or normalized instead`);
      }
      last = { n, value: parsed.value, state };
      points.push(last);
      if (matches(last)) break;
    }
  }
  if (!last) throw new Error('Cubase reported no value to search from');

  // The closest value seen (the one Cubase shows now on a tie); written again when it is not the last one.
  let final = points.reduce((best, p) => {
    const [e, b] = [errorOf(p.value), errorOf(best.value)];
    return e < b || (e === b && p === last) ? p : best;
  });
  if (final !== last) {
    const state = await probe(final.n);
    iterations++;
    final = { n: final.n, value: parseDisplay(state.d, state.u)?.value ?? final.value, state };
  }
  const withinTolerance = errorOf(final.value) <= tolerance;
  return {
    target,
    achieved: final.value,
    display: final.state.d,
    units: final.state.u,
    normalized: final.state.v ?? final.n,
    iterations,
    withinTolerance,
    ...(edgeReached && !withinTolerance ? { clamped: true as const } : {}),
  };
}

/** Simple FIFO mutex so multi-step operations (seek, focus) do not interleave. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export interface ClientOptions {
  /** How long to wait for Cubase to move the mixer bank (default 3000 ms). */
  bankTimeoutMs?: number;
  /**
   * How long a switch or a normalized write waits for Cubase to report the new value (default 4000 ms).
   * Cubase applies them through callbacks that arrive 1-8 s late; past this the result says "unconfirmed".
   */
  confirmMs?: number;
  /** How long selecting a channel waits for the selection to follow (default 10000 ms). */
  selectionTimeoutMs?: number;
}

/** Whether Cubase reported the value a write asked for before the wait ran out. */
export type Applied = 'confirmed' | 'unconfirmed';

export interface BoolResult {
  key: string;
  on: boolean;
  /** What Cubase reports afterwards (null when unknown). */
  state: boolean | null;
  verified: boolean;
  applied: Applied;
}

/** Fields of a bank channel (ch.N.<field>) besides its sends. */
export const CHANNEL_FIELDS = [
  'volume',
  'pan',
  'mute',
  'solo',
  'monitor',
  'record',
  'selected',
  'editorOpen',
  'instrumentOpen',
  'autoRead',
  'autoWrite',
  'meter',
  'meterMax',
  'meterClip',
  'pre.gain',
  'pre.phase',
  'pre.lowCutOn',
  'pre.lowCutFreq',
];

/** Send slots the bridge script exposes per bank channel, and the fields of each one. */
export const SEND_SLOTS = 8;
export const SEND_FIELDS = ['level', 'on', 'prePost'];

export const sendFields = (slot: number) => SEND_FIELDS.map((f) => `send.${slot}.${f}`);

/** Every field of a bank channel, sends included. */
export const allChannelFields = () => [...CHANNEL_FIELDS, ...Array.from({ length: SEND_SLOTS }, (_, s) => sendFields(s)).flat()];

/** Value keys per value.get request: small answers (a whole bank page with values is ~150 KB and stalls MIDI Remote). */
const VALUE_BATCH = 96;

/** Whether a cursor read is at `target`: exactly when stopped, or up to `elapsed` seconds past it while playing. */
function nearTime(actual: number, target: number, elapsed: number, playing: boolean): boolean {
  return playing ? actual >= target - 0.05 && actual <= target + elapsed + 0.5 : Math.abs(actual - target) <= 0.011;
}

/** The cursor left `reference` (allowing for playback), or a locator changed. */
function positionMoved(reference: TransportPosition, now: TransportPosition, elapsed: number, playing: boolean): boolean {
  if (reference.time !== null && now.time !== null && !nearTime(now.time, reference.time, elapsed, playing)) return true;
  const differs = (a: number | null | undefined, b: number | null | undefined) =>
    a !== undefined && b !== undefined && a !== b && (a === null || b === null || Math.abs(a - b) > 0.0005);
  return differs(reference.left, now.left) || differs(reference.right, now.right) || (reference.timeDisplay !== now.timeDisplay && (reference.time === null || now.time === null));
}

export class CubaseClient {
  private readonly lock = new Mutex();
  /** Transport and meter work (measurements): one at a time, since the transport and meter statistics are shared. */
  private readonly measureLock = new Mutex();
  private readonly measureContext = new AsyncLocalStorage<boolean>();
  private readonly confirmMs: number;
  private readonly selectionTimeoutMs: number;
  /** Bank moves are serialized separately from value writes (a lookup holds the bank while it writes). */
  private readonly bankLock = new Mutex();
  private readonly bankContext = new AsyncLocalStorage<boolean>();
  private readonly bankTimeoutMs: number;
  private readonly bankPollMs: number;
  /** Uid of the first channel of the bank after a reset (undefined until a reset was seen). */
  private homeUid: string | null | undefined;
  /** Bank offset the server knows, valid while the first slot shows `uid`. */
  private position: { offset: number; uid: string | null } | null = null;
  /** Channel each bank slot showed at the last read of the page (cleared when the bank moves or a command runs). */
  private readonly slotIds = new Map<number, { title: string; uid: string | null }>();
  /** Mixer channel of the selection at its last read. */
  private selectedId: { title: string; uid: string | null } | null = null;
  /** The last mix values this server wrote, oldest first. */
  private readonly writeLog: WriteRecord[] = [];
  /** DirectAccess kind of each channel seen (a channel keeps its kind); kindsAvailable false without DirectAccess. */
  private readonly kindByUid = new Map<string, ChannelKind>();
  private kindsAvailable = true;

  constructor(
    readonly bridge: CubaseBridge,
    private readonly settleMs: number,
    options: ClientOptions = {},
  ) {
    this.bankTimeoutMs = options.bankTimeoutMs ?? 3000;
    this.confirmMs = options.confirmMs ?? 4000;
    this.selectionTimeoutMs = options.selectionTimeoutMs ?? 10000;
    this.bankPollMs = Math.min(250, Math.max(10, settleMs * 2));
  }

  // ---------------------------------------------------------------------------
  // Raw protocol
  // ---------------------------------------------------------------------------

  /**
   * Sends a request. Reads and absolute writes wait out a MIDI Remote stall and are sent again (see
   * CubaseBridge.request); pulses, actions and commands are sent once.
   */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number, options?: RequestOptions): Promise<T> {
    return this.bridge.request<T>(method, params, timeoutMs, options);
  }

  ping(options?: RequestOptions) {
    return this.call<{ pong: boolean; version: string; activated: boolean; uptimeMs: number; startedAt?: number }>('ping', {}, undefined, options);
  }

  capabilities() {
    return this.call<Record<string, unknown>>('capabilities');
  }

  /**
   * Bank channels; with uids, each one carries its Cubase unique id (scripts older than this option ignore it).
   * includeValues sends every value of the 48 slots (~150 KB, enough to stall MIDI Remote): read values with
   * channelValues / readValues instead.
   */
  async channels(includeValues = false, includeEmpty = false, uids = false) {
    const page = await this.call<{ bankSize: number; channels: ChannelInfo[] }>('state.channels', { includeValues, includeEmpty, uids });
    this.noteSlots(page.channels);
    return page;
  }

  async selected(timeoutMs?: number) {
    const selected = await this.call<SelectedInfo>('state.selected', {}, timeoutMs);
    this.noteSelection(selected);
    return selected;
  }

  /** Title and selected flags only: a small answer for polling (state.selected carries the whole channel strip). */
  async selectionInfo(timeoutMs?: number, options?: RequestOptions): Promise<SelectionInfo> {
    try {
      const info = await this.call<SelectionInfo>('state.selection', {}, timeoutMs, options);
      this.noteSelection(info);
      return info;
    } catch (error) {
      // Bridge scripts older than state.selection.
      if (/Unknown method/.test((error as Error).message)) return this.selected(timeoutMs);
      throw error;
    }
  }

  /**
   * The selected track as far as the API can tell. When the selected track has no mixer channel
   * (folder, MIDI, marker track...) Cubase empties the selection object's title, but its values keep the
   * previous mixer channel: its own selected flag tells the two cases apart.
   */
  async selection(info?: SelectionInfo, timeoutMs?: number): Promise<Selection> {
    const selected = info ?? (await this.selectionInfo(timeoutMs));
    return {
      title: isSelectionStale(selected) || !selected.title ? null : selected.title,
      hasMixerChannel: !isSelectionStale(selected) && Boolean(selected.title),
      bankSelected: selected.bankSelected ?? [],
    };
  }

  getValues(keys: string[], options?: RequestOptions) {
    return this.call<Record<string, ValueState | null>>('value.get', { keys }, undefined, options);
  }

  async getValue(key: string, options?: RequestOptions): Promise<ValueState> {
    const result = await this.getValues([key], options);
    const value = result[key];
    if (!value) throw new Error(`Unknown value key: ${key}`);
    return value;
  }

  /**
   * Reads many values in small requests and without object titles (brief; older scripts add them).
   * Keys the script does not know are left out.
   */
  async readValues(keys: string[]): Promise<Record<string, ValueState>> {
    const out: Record<string, ValueState> = {};
    for (let i = 0; i < keys.length; i += VALUE_BATCH) {
      const part = await this.call<Record<string, ValueState | null>>('value.get', { keys: keys.slice(i, i + VALUE_BATCH), brief: true });
      for (const [key, value] of Object.entries(part)) if (value) out[key] = value;
    }
    return out;
  }

  /** Values of one bank slot (ch.N.<field>): every field by default, sends included. A few KB instead of the whole bank. */
  channelValues(index: number, fields: string[] = allChannelFields()): Promise<Record<string, ValueState>> {
    return this.readValues(fields.map((field) => this.channelKey(index, field)));
  }

  listKeys(prefix = '') {
    return this.call<{ keys: string[] }>('value.list', { prefix });
  }

  async setValue(key: string, value: number) {
    const result = await this.call<{ key: string; value: number }>('value.set', { key, value });
    this.noteWrite(key);
    return result;
  }

  async setValues(items: Array<{ key: string; value: number }>) {
    const result = await this.call<{ results: Array<{ key: string; value?: number; error?: string }> }>('value.setMany', { items });
    const failed = new Set((result.results ?? []).filter((r) => r.error).map((r) => r.key));
    for (const item of items) if (!failed.has(item.key)) this.noteWrite(item.key);
    return result;
  }

  pulse(key: string) {
    return this.call('value.pulse', { key });
  }

  runAction(key: string, timeoutMs?: number) {
    if (key.startsWith('bank.')) this.slotIds.clear();
    return this.call('action.run', { key }, timeoutMs);
  }

  runCommand(category: string, name: string) {
    // A command can add, remove or move channels: the slots are read again before the next write is named.
    this.slotIds.clear();
    return this.call<{ category: string; name: string }>('command.run', { category, name });
  }

  // ---------------------------------------------------------------------------
  // Writes this server made (to tell which change an undo reverted)
  // ---------------------------------------------------------------------------

  /** Remembers which channel each bank slot shows, from a read of the page (named slots; the others are empty). */
  private noteSlots(channels: Array<{ index: number; title: string; uid?: string | null }>): void {
    const old = new Map(this.slotIds);
    this.slotIds.clear();
    for (const channel of channels) {
      if (!channel.title) continue;
      const known = old.get(channel.index);
      const uid = channel.uid !== undefined ? channel.uid || null : known?.title === channel.title ? known.uid : null;
      this.slotIds.set(channel.index, { title: channel.title, uid });
    }
  }

  private noteSelection(selected: Pick<SelectedInfo, 'title' | 'uid' | 'selectedFlag'>): void {
    this.selectedId = selected.title && !isSelectionStale(selected) ? { title: selected.title, uid: selected.uid || null } : null;
  }

  /** Records a write to a mix field of a bank slot (ch.N.*) or of the selected track (sel.*). */
  private noteWrite(key: string): void {
    const bank = /^ch\.(\d+)\.(.+)$/.exec(key);
    const field = bank ? bank[2] : key.startsWith('sel.') ? key.slice(4) : null;
    if (!field || !MIX_WRITE_FIELD.test(field)) return;
    const index = bank ? Number(bank[1]) : null;
    const id = index === null ? this.selectedId : this.slotIds.get(index);
    const record: WriteRecord = { channel: id?.title ?? null, uid: id?.uid ?? null, index, field, at: Date.now() };
    // A search writes the same value many times: one record, at the time of the last write.
    const same = this.writeLog.findIndex((w) => w.field === field && w.index === index && w.channel === record.channel && w.uid === record.uid);
    if (same >= 0) this.writeLog.splice(same, 1);
    this.writeLog.push(record);
    if (this.writeLog.length > KEPT_WRITES) this.writeLog.shift();
  }

  /** The last mix values this server wrote (up to 20), oldest first. */
  recentWrites(): WriteRecord[] {
    return this.writeLog.slice();
  }

  /** Forgets a write (one an undo reverted). */
  forgetWrite(record: WriteRecord): void {
    const i = this.writeLog.indexOf(record);
    if (i >= 0) this.writeLog.splice(i, 1);
  }

  // ---------------------------------------------------------------------------
  // Value helpers
  // ---------------------------------------------------------------------------

  /** Delay before the Nth read of a value that has not arrived yet: settle, then 250, 500 and 1000 ms. */
  private backoff(attempt: number): number {
    return attempt === 0 ? this.settleMs : Math.min(1000, 250 * 2 ** (attempt - 1));
  }

  /**
   * Polls a value with backoff until `accept` takes it (it also gets the previous read) or the time is up.
   * Cubase reports switches and selection through callbacks that come 1-8 s after the write.
   */
  async waitForValue(
    key: string,
    accept: (state: ValueState, previous: ValueState | null) => boolean,
    timeoutMs = this.confirmMs,
  ): Promise<{ state: ValueState; confirmed: boolean }> {
    const deadline = Date.now() + timeoutMs;
    let previous: ValueState | null = null;
    let state: ValueState = { v: null, d: null, u: null };
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.min(this.backoff(attempt), Math.max(0, deadline - Date.now())));
      // Not resent here: this loop is the retry, and it must keep to its own deadline.
      const read = await this.getValue(key, { retry: false }).catch((error) => {
        if (isTimeout(error)) return null;
        throw error;
      });
      if (read) {
        state = read;
        if (accept(state, previous)) return { state, confirmed: true };
        previous = state;
      }
      if (Date.now() >= deadline) return { state, confirmed: false };
    }
  }

  /**
   * Switches a value on or off with an absolute write (never a toggle pulse: a late write plus a pulse
   * would switch it back) and waits for Cubase to report it. state is what Cubase reports at the end
   * (null when unknown); applied is "unconfirmed" when the new state did not arrive within confirmMs.
   * force writes even when Cubase already shows the wanted state (mute and solo: while a channel is soloed
   * Cubase shows solo-implied mutes, so a read that matches proves nothing); verify: false writes and
   * returns at once, unconfirmed, for a state that cannot be read back.
   */
  async setBool(key: string, on: boolean, options: { force?: boolean; verify?: boolean } = {}): Promise<BoolResult> {
    return this.lock.run(async () => {
      const current = await this.getValue(key);
      if (!options.force && current.v !== null && current.v > 0.5 === on) return { key, on, state: on, verified: true, applied: 'confirmed' };
      await this.setValue(key, on ? 1 : 0);
      if (options.verify === false) return { key, on, state: null, verified: false, applied: 'unconfirmed' };
      const { state: after, confirmed } = await this.waitForValue(key, (s) => s.v !== null && s.v > 0.5 === on);
      const state = after.v === null ? null : after.v > 0.5;
      return { key, on, state, verified: confirmed, applied: confirmed ? 'confirmed' : 'unconfirmed' };
    });
  }

  /**
   * Writes a normalized value and returns what Cubase reports once it has applied it (not the old value).
   * Cubase snaps some values to its grid (a switch only takes 0 or 1, the fader has a detent at 0 dB), so a
   * value that moved and then held still counts as applied too: requested is what was asked for and
   * differsFromRequest says Cubase shows something else (snapped, ignored, or not reported yet).
   */
  writeAndRead(key: string, normalized: number): Promise<ValueState & { applied: Applied; requested: number; differsFromRequest: boolean }> {
    return this.lock.run(async () => {
      const before = await this.getValue(key);
      await this.setValue(key, normalized);
      const moved = (s: ValueState) => before.v !== null && s.v !== null && Math.abs(s.v - before.v) > 1e-6;
      const { state, confirmed } = await this.waitForValue(
        key,
        (s, previous) => (s.v !== null && Math.abs(s.v - normalized) < 0.01) || (moved(s) && previous !== null && previous.v === s.v),
      );
      // Float32 precision: Cubase stores values as 32-bit floats.
      const differsFromRequest = state.v === null || Math.abs(state.v - normalized) > 1e-6;
      return { ...state, applied: confirmed ? 'confirmed' : 'unconfirmed', requested: normalized, differsFromRequest };
    });
  }

  /**
   * Writes a normalized value and waits until Cubase reports it back: close to the request, or moved from
   * `before` and holding still (a snapped value, e.g. the fader detent at 0 dB moves 0.78125 to 0.7891).
   * Polling a snapped value for too long stalls the MIDI Remote script for ~10 s.
   */
  private async probe(key: string, normalized: number, before: number | null): Promise<ValueState> {
    await this.setValue(key, normalized);
    let state: ValueState = { v: null, d: null, u: null };
    let previous: number | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(this.settleMs * (attempt + 1));
      state = await this.getValue(key);
      if (state.v !== null && Math.abs(state.v - normalized) < 0.01) break;
      if (state.v !== null && previous === state.v && (before === null || Math.abs(state.v - before) > 1e-6)) break;
      previous = state.v;
    }
    return state;
  }

  /**
   * Finds the normalized value whose display matches a target in real units (dB, Hz, pan...): a search
   * against Cubase's display (see seekMonotonic), because Cubase only exposes normalized values. It starts
   * from the current value and, for the bank and selected-track keys, next to the target on a known curve,
   * so it does not write the extremes of the live parameter; Cubase still shows (and plays) the values it
   * passes through. On an error the value goes back to where it was.
   */
  async seekDisplay(key: string, target: number, options: SeekOptions = {}): Promise<SeekResult> {
    return this.lock.run(async () => {
      const start = await this.getValue(key);
      let current = start.v;
      const probe = async (n: number) => {
        const state = await this.probe(key, n, current);
        if (state.v !== null) current = state.v;
        return state;
      };
      try {
        return { ...(await seekMonotonic(probe, target, { curve: curveForKey(key), ...options, start })), key };
      } catch (error) {
        if (start.v !== null && current !== start.v) await this.setValue(key, start.v).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Same search for a DirectAccess parameter (plugin parameters, EQ of any object...). A switch ("On"/"Off",
   * "Activ."/"Desact.") is switched instead: on for a target >= 0.5. On an error the parameter goes back to
   * the value it had.
   */
  async seekDirectParameter(
    scope: string,
    selector: { objectId?: number; tag?: number; title?: string; resolvePlugin?: boolean; match?: string },
    target: number,
    options: SeekOptions = {},
  ): Promise<SeekResult> {
    return this.lock.run(async () => {
      const read = async (): Promise<ValueState> => {
        const { parameter } = await this.call<{ parameter: { value: number; display: string; units: string } }>('da.getParam', { scope, ...selector });
        return { v: parameter.value ?? null, d: parameter.display ?? null, u: parameter.units ?? null };
      };
      const start = await read();
      let written = false;
      const probe = async (n: number): Promise<ValueState> => {
        written = true;
        await this.call('da.setParam', { scope, ...selector, value: n });
        await sleep(this.settleMs);
        return read();
      };
      try {
        return { ...(await seekMonotonic(probe, target, { switches: 'set', ...options, start })), key: `${scope}:${selector.title ?? selector.tag}` };
      } catch (error) {
        if (written && start.v !== null) await this.call('da.setParam', { scope, ...selector, value: start.v }).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Types a display text into a DirectAccess parameter and says whether Cubase took it: Cubase 13 ignores a
   * text it does not understand without an error. The script reports the value before and after the write;
   * when the write does not show yet, the parameter is read once more after settleMs (no more: long polling
   * stalls the script).
   */
  async setDirectDisplay(
    scope: string,
    selector: { objectId?: number; tag?: number; title?: string; resolvePlugin?: boolean; match?: string },
    display: string,
  ): Promise<DisplayVerdict & { objectId: number; requested: string; before: { value: number | null; display: string | null } | null; parameter: DirectParameter }> {
    return this.lock.run(async () => {
      const written = await this.call<{ objectId: number; parameter: DirectParameter; before?: { value: number | null; display: string | null } }>('da.setParam', {
        scope,
        ...selector,
        display,
      });
      let parameter = written.parameter;
      let verdict = judgeDisplayWrite(display, written.before, parameter);
      if (!verdict.applied) {
        await sleep(Math.max(this.settleMs, 50));
        parameter = (await this.call<{ parameter: DirectParameter }>('da.getParam', { scope, objectId: written.objectId, tag: parameter.tag })).parameter;
        verdict = judgeDisplayWrite(display, written.before, parameter);
      }
      return { objectId: written.objectId, requested: display, before: written.before ?? null, parameter, ...verdict };
    });
  }

  /**
   * Writes a normalized value to a DirectAccess parameter and says whether Cubase took it (see
   * judgeNormalizedWrite): the script reports the value before and after; when the write does not show yet,
   * the parameter is read once more after settleMs.
   */
  async setDirectNormalized(
    scope: string,
    selector: { objectId?: number; tag?: number; title?: string; resolvePlugin?: boolean; match?: string },
    value: number,
  ): Promise<DisplayVerdict & { objectId: number; requested: number; before: { value: number | null; display: string | null } | null; parameter: DirectParameter }> {
    return this.lock.run(async () => {
      const written = await this.call<{ objectId: number; parameter: DirectParameter; before?: { value: number | null; display: string | null } }>('da.setParam', {
        scope,
        ...selector,
        value,
      });
      let parameter = written.parameter;
      let verdict = judgeNormalizedWrite(value, written.before, parameter);
      if (!verdict.matches) {
        await sleep(Math.max(this.settleMs, 50));
        parameter = (await this.call<{ parameter: DirectParameter }>('da.getParam', { scope, objectId: written.objectId, tag: parameter.tag })).parameter;
        verdict = judgeNormalizedWrite(value, written.before, parameter);
      }
      return { objectId: written.objectId, requested: value, before: written.before ?? null, parameter, ...verdict };
    });
  }

  /**
   * Same verdicts for the items of a da.setParams batch (results in item order): display items as
   * setDirectDisplay, normalized items as setDirectNormalized. Items that do not show the write yet are read
   * once more after settleMs. Failed items are left as they are.
   */
  async verifyDisplayItems<R extends { error?: string; tag?: number; value?: number | null; display?: string | null; units?: string | null; before?: { value: number | null; display: string | null } }>(
    scope: string,
    objectId: number,
    items: Array<{ display?: string; normalized?: number }>,
    results: R[],
  ): Promise<Array<R & Partial<DisplayVerdict> & { requested?: string | number }>> {
    const out: Array<R & Partial<DisplayVerdict> & { requested?: string | number }> = results.map((r) => ({ ...r }));
    const judge = (requested: string | number, before: R['before'], after: { value: number | null; display: string | null; units: string | null }) =>
      typeof requested === 'string' ? judgeDisplayWrite(requested, before, after) : judgeNormalizedWrite(requested, before, after);
    const pending: number[] = [];
    out.forEach((result, i) => {
      const requested = items[i]?.display ?? items[i]?.normalized;
      if (requested === undefined || result.error) return;
      const verdict = judge(requested, result.before, { value: result.value ?? null, display: result.display ?? null, units: result.units ?? null });
      Object.assign(result, { requested, ...verdict });
      if (typeof requested === 'string' ? !verdict.applied : !verdict.matches) pending.push(i);
    });
    if (pending.length > 0) {
      await sleep(Math.max(this.settleMs, 50));
      for (const i of pending) {
        const result = out[i];
        const { parameter } = await this.call<{ parameter: DirectParameter }>('da.getParam', { scope, objectId, tag: result.tag });
        Object.assign(result, parameter, judge(result.requested as string | number, result.before, parameter));
      }
    }
    return out;
  }

  /**
   * Named bank channels of the current page that Cubase shows soloed. While one is, Cubase shows
   * solo-implied states: the other channels read mute on, the soloed channel reads its own mute off and the
   * channels it feeds read solo on, so mute (and solo) reads are not the real switches.
   */
  async soloedChannels(): Promise<Array<{ index: number; title: string }>> {
    // Titles only (brief), named slots: an empty slot keeps the solo of the channel it showed before.
    const page = await this.call<{ channels: Array<{ index: number; title: string }> }>('state.channels', { includeValues: false, brief: true });
    this.noteSlots(page.channels);
    const channels = page.channels.filter((c) => c.title);
    const values = await this.readValues(channels.map((c) => this.channelKey(c.index, 'solo')));
    return channels.filter((c) => (values[this.channelKey(c.index, 'solo')]?.v ?? 0) > 0.5).map((c) => ({ index: c.index, title: c.title }));
  }

  /** Polls several values until every one is accepted or the time is up (switches arrive 1-8 s late). */
  async waitForValues(keys: string[], accept: (state: ValueState) => boolean, timeoutMs = this.confirmMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; keys.length > 0; attempt++) {
      await sleep(Math.min(this.backoff(attempt), Math.max(0, deadline - Date.now())));
      const values = await this.readValues(keys).catch(() => null);
      if (values && keys.every((key) => values[key] && accept(values[key]))) return true;
      if (Date.now() >= deadline) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Transport and meters
  // ---------------------------------------------------------------------------

  /**
   * Runs transport and meter work one call at a time: the transport, the meter statistics (one per bank
   * slot) and the bank page are shared, so concurrent measurements would reset or stop each other. A call
   * waits for the one before it. It also holds the bank, so no lookup moves it while meters are read.
   * Nested calls from the same task run directly.
   */
  measurement<T>(task: () => Promise<T>): Promise<T> {
    if (this.measureContext.getStore()) return task();
    return this.measureLock.run(() => this.measureContext.run(true, () => this.exclusiveBank(() => this.withSecondsTimeFormat(task))));
  }

  /**
   * Positions are read and written as the text of the transport time, which follows Cubase's primary time
   * format: with bars and beats ("80. 2. 3. 75") a time written as "0:01:54.816" lands on bar 3 (live, 15 Oct 2026).
   * When the time is not shown in seconds, the format is switched to seconds for the task and put back after it.
   */
  async withSecondsTimeFormat<T>(task: () => Promise<T>): Promise<T> {
    const time = await this.transportParam(TRANSPORT_TAGS.time).catch(() => null);
    if (!time || time.display === null || parseTimeDisplay(time.display) !== null) return task();
    const format = await this.transportParam(TRANSPORT_TAGS.timeFormat).catch(() => null);
    if (!format || format.value === null) return task();
    const set = (value: number) =>
      this.call('da.setParam', { scope: 'transport', tag: TRANSPORT_TAGS.timeFormat, resolvePlugin: false, value }).catch(() => undefined);
    await set(SECONDS_TIME_FORMAT);
    try {
      return await task();
    } finally {
      await set(format.value);
    }
  }

  /** Stops the transport and waits until Cubase reports it stopped; sends stop once more when it does not. */
  async stopTransport(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A pulse is not resent by the bridge; stopping twice is harmless, so it is resent here when needed.
      await this.pulse('tr.stop').catch(() => undefined);
      const stopped = await this.waitForValue('tr.start', (s) => s.v !== null && s.v < 0.5).catch(() => ({ confirmed: false }));
      if (stopped.confirmed) return true;
      await this.bridge.waitResponsive(this.confirmMs).catch(() => false);
    }
    return false;
  }

  async isPlaying(): Promise<boolean | null> {
    const state = await this.getValue('tr.start').catch(() => null);
    return !state || state.v === null ? null : state.v > 0.5;
  }

  private async transportParam(tag: number): Promise<{ value: number | null; display: string | null }> {
    const { parameter } = await this.call<{ parameter: DirectParameter }>('da.getParam', { scope: 'transport', tag, resolvePlugin: false });
    return { value: parameter.value ?? null, display: parameter.display ?? null };
  }

  /**
   * The cursor (and with locators, the cycle locators) from the DirectAccess transport object; null when it
   * cannot be read (DirectAccess off, an old Cubase). Times are seconds when Cubase shows them in seconds.
   */
  async transportPosition(locators = true): Promise<TransportPosition | null> {
    try {
      const time = await this.transportParam(TRANSPORT_TAGS.time);
      const position: TransportPosition = { time: parseTimeDisplay(time.display), timeDisplay: time.display };
      if (locators) {
        const left = await this.transportParam(TRANSPORT_TAGS.left);
        const right = await this.transportParam(TRANSPORT_TAGS.right);
        Object.assign(position, {
          left: parseTimeDisplay(left.display),
          leftDisplay: left.display,
          right: parseTimeDisplay(right.display),
          rightDisplay: right.display,
        });
      }
      return position;
    } catch {
      return null;
    }
  }

  /**
   * Puts the cursor at a time (seconds) by writing the DirectAccess transport time as text (a normalized write
   * loses the milliseconds), and reads it back. Playback goes on from there when it was playing.
   * applied is null when the time cannot be read back in seconds.
   */
  async locateTime(seconds: number): Promise<{ requested: string; applied: boolean | null; position: TransportPosition | null }> {
    const target = Math.max(0, Math.round(seconds * 1000) / 1000);
    const requested = formatTimeDisplay(target);
    await this.call('da.setParam', { scope: 'transport', tag: TRANSPORT_TAGS.time, resolvePlugin: false, display: requested });
    const playing = (await this.isPlaying()) === true;
    const sentAt = Date.now();
    const deadline = sentAt + Math.min(this.confirmMs, 2000);
    for (let attempt = 0; ; attempt++) {
      const position = await this.transportPosition(false);
      if (!position || position.time === null) return { requested, applied: null, position };
      if (nearTime(position.time, target, (Date.now() - sentAt) / 1000, playing)) return { requested, applied: true, position };
      if (Date.now() >= deadline) return { requested, applied: false, position };
      await sleep(this.backoff(attempt));
    }
  }

  /** Polls the position until the cursor (or a locator) leaves `reference`, or the time is up. */
  private async positionChange(reference: TransportPosition, sentAt: number, playing: boolean, locators: boolean) {
    const deadline = sentAt + Math.min(this.confirmMs, 2000);
    let position: TransportPosition | null = null;
    for (let attempt = 0; ; attempt++) {
      await sleep(this.backoff(attempt));
      position = await this.transportPosition(locators);
      if (position && positionMoved(reference, position, (Date.now() - sentAt) / 1000 + 0.3, playing)) return { changed: true, position };
      if (Date.now() >= deadline) return { changed: false, position };
    }
  }

  /**
   * Runs "To Marker N" (or "To Cycle Marker N" and "Recall Cycle Marker N") and checks with DirectAccess that the cursor (or the locators)
   * moved. Cubase does nothing for a marker that does not exist and says nothing: when nothing moved, the
   * cursor (and for a cycle marker the locators) are stepped 1 s away and the command sent again, to tell
   * "already there" from "no such marker"; they go back where they were when the marker is not found.
   */
  async locateMarker(cycle: boolean, number: number): Promise<MarkerLocation> {
    // "To Cycle Marker N" may only move the cursor; "Recall Cycle Marker N" sets the locators to it. Both are sent.
    const names = cycle ? [`To Cycle Marker ${number}`, `Recall Cycle Marker ${number}`] : [`To Marker ${number}`];
    const command = names.join(' + ');
    const send = async () => {
      for (const [i, name] of names.entries()) {
        // A bridge script built before "Recall Cycle Marker" was in the catalog does not bind it.
        await this.runCommand('Transport', name).catch((error) => {
          if (i === 0 || !/not bound/.test((error as Error).message)) throw error;
        });
      }
    };
    const before = await this.transportPosition(cycle);
    let sentAt = Date.now();
    await send();
    if (!before || before.time === null) {
      return {
        command,
        verified: false,
        markerFound: null,
        moved: null,
        before,
        position: await this.transportPosition(cycle),
        note: 'Cubase does not confirm marker commands and DirectAccess gave no time in seconds (an old bridge script, DirectAccess off, or a time format other than seconds), so it is not known whether the marker exists.',
      };
    }
    const playing = (await this.isPlaying()) === true;
    const first = await this.positionChange(before, sentAt, playing, cycle);
    if (first.changed) return { command, verified: true, markerFound: true, moved: true, before, position: first.position };
    const missing = (position: TransportPosition | null): MarkerLocation => ({
      command,
      verified: true,
      markerFound: false,
      moved: false,
      before,
      position,
      note: cycle
        ? `Neither the cursor nor the locators moved: the project has no cycle marker ${number} (or the locators already showed its range).`
        : `The cursor did not move: the project has no marker ${number}.`,
    });
    if (playing) return missing(first.position);
    // Already on the marker, or no such marker: step the cursor (and the locators) 1 s away and send it again.
    const away = await this.locateTime(before.time + 1);
    const shifted = cycle ? await this.shiftLocators(before, 1) : null;
    if (away.applied !== true || !away.position || (cycle && !shifted)) {
      if (shifted) await this.shiftLocators(shifted, -1);
      await this.locateTime(before.time);
      return { ...missing(first.position), markerFound: null, note: 'Nothing moved, and stepping the cursor or the locators away to tell "already on the marker" from "no such marker" failed.' };
    }
    sentAt = Date.now();
    await send();
    const reference: TransportPosition = { ...(shifted ?? before), time: away.position.time, timeDisplay: away.position.timeDisplay };
    const retry = await this.positionChange(reference, sentAt, false, cycle);
    if (retry.changed) {
      return { command, verified: true, markerFound: true, moved: false, before, position: retry.position, note: `The ${cycle ? 'locators were' : 'cursor was'} already on the marker.` };
    }
    if (shifted) await this.shiftLocators(shifted, -1);
    await this.locateTime(before.time);
    return missing(await this.transportPosition(cycle));
  }

  /** A parameter of the DirectAccess transport object (value and display), or null when it cannot be read. */
  async readTransportParam(tag: number): Promise<{ value: number | null; display: string | null } | null> {
    return this.transportParam(tag).catch(() => null);
  }

  /**
   * Sets the cycle locators to times in seconds by writing their display (a normalized write loses the
   * milliseconds) and reads them back. When the left one moves past the right one, the right one is written first.
   * applied: both requested locators read back at their time (null when they cannot be read in seconds).
   */
  async setLocators(left: number | null, right: number | null): Promise<{ requested: Record<string, string>; applied: boolean | null; before: TransportPosition | null; position: TransportPosition | null }> {
    const before = await this.transportPosition(true);
    const wanted: Array<[number, number, 'left' | 'right']> = [];
    if (left !== null) wanted.push([TRANSPORT_TAGS.left, Math.max(0, Math.round(left * 1000) / 1000), 'left']);
    if (right !== null) wanted.push([TRANSPORT_TAGS.right, Math.max(0, Math.round(right * 1000) / 1000), 'right']);
    const currentRight = before?.right ?? null;
    if (left !== null && right !== null && currentRight !== null && left >= currentRight) wanted.reverse();
    const requested: Record<string, string> = {};
    for (const [tag, seconds, name] of wanted) {
      requested[name] = formatTimeDisplay(seconds);
      await this.call('da.setParam', { scope: 'transport', tag, resolvePlugin: false, display: requested[name] });
    }
    const deadline = Date.now() + Math.min(this.confirmMs, 2000);
    for (let attempt = 0; ; attempt++) {
      const position = await this.transportPosition(true);
      const read = (name: 'left' | 'right') => (position ? position[name] : null);
      if (wanted.some(([, , name]) => read(name) === null || read(name) === undefined)) return { requested, applied: null, before, position };
      const ok = wanted.every(([, seconds, name]) => Math.abs((read(name) as number) - seconds) <= 0.011);
      if (ok) return { requested, applied: true, before, position };
      if (Date.now() >= deadline) return { requested, applied: false, before, position };
      await sleep(this.backoff(attempt));
    }
  }

  /** Writes a DirectAccess transport switch (returnOnStop) and polls until it reads back. */
  async setTransportSwitch(tag: number, on: boolean): Promise<{ state: boolean | null; applied: 'confirmed' | 'unconfirmed' }> {
    await this.call('da.setParam', { scope: 'transport', tag, resolvePlugin: false, value: on ? 1 : 0 });
    const deadline = Date.now() + this.confirmMs;
    for (let attempt = 0; ; attempt++) {
      const read = await this.transportParam(tag).catch(() => null);
      const state = read && read.value !== null ? read.value > 0.5 : null;
      if (state === on) return { state, applied: 'confirmed' };
      if (Date.now() >= deadline) return { state, applied: 'unconfirmed' };
      await sleep(this.backoff(attempt + 1));
    }
  }

  /** Presses a DirectAccess transport button: 1, then 0 (a lost 1 is not sent again: it could act twice). */
  private async pressTransportButton(tag: number): Promise<void> {
    try {
      await this.call('da.setParam', { scope: 'transport', tag, resolvePlugin: false, value: 1 }, undefined, { retry: false });
    } finally {
      await this.call('da.setParam', { scope: 'transport', tag, resolvePlugin: false, value: 0 }).catch(() => undefined);
    }
  }

  /**
   * Moves the cursor with a DirectAccess transport button (stepBar, nudgeUp...) and checks the transport time. When
   * the cursor did not move and the transport is stopped, the key command `fallback` is sent instead (it is not
   * sent while playing, where a late move cannot be told from playback).
   */
  async transportStep(tag: number, fallback: { category: string; name: string }): Promise<TransportStep> {
    const before = await this.transportPosition(false);
    const playing = (await this.isPlaying()) === true;
    let sentAt = Date.now();
    await this.pressTransportButton(tag);
    if (!before || before.time === null) {
      return {
        via: null,
        moved: null,
        before,
        position: await this.transportPosition(false),
        note: 'DirectAccess gave no cursor time in seconds, so the move cannot be checked (and the key command was not tried, so the cursor is not moved twice).',
      };
    }
    const first = await this.positionChange(before, sentAt, playing, false);
    if (first.changed) return { via: 'directAccess', moved: true, before, position: first.position };
    if (playing) {
      return { via: null, moved: false, before, position: first.position, note: 'The cursor did not move away from where playback would take it; the key command is not tried while playing.' };
    }
    sentAt = Date.now();
    try {
      await this.runCommand(fallback.category, fallback.name);
    } catch (error) {
      return { via: null, moved: false, before, position: first.position, note: `The DirectAccess button did nothing and ${fallback.category} / ${fallback.name} could not be sent: ${(error as Error).message}` };
    }
    const second = await this.positionChange(before, sentAt, false, false);
    return {
      via: second.changed ? 'command' : null,
      moved: second.changed,
      before,
      position: second.position,
      ...(second.changed
        ? {}
        : { note: `Neither the DirectAccess button nor ${fallback.category} / ${fallback.name} moved the cursor (at the project start or end, nothing moves).` }),
    };
  }

  /**
   * Lists the position markers by locating the cursor at the project start and sending "Locate Next Marker" until
   * the cursor stops moving; "Goto End" then tells the project end (where Cubase stops after the last marker) from a
   * marker. The cursor goes back where it was. Needs the transport stopped and the cursor time in seconds.
   */
  async scanMarkers(maxMarkers = 100): Promise<MarkerScan> {
    if ((await this.isPlaying()) === true) throw new Error('The transport is playing: stop it first (cubase_transport stop). Listing markers moves the cursor.');
    const before = await this.transportPosition(false);
    if (!before || before.time === null) {
      throw new Error('DirectAccess gave no cursor time in seconds (an old bridge script, DirectAccess off, or a time format other than seconds), so the markers cannot be found.');
    }
    const stops: TransportPosition[] = [];
    let complete = false;
    try {
      const start = await this.locateTime(0);
      if (start.applied !== true || !start.position) throw new Error('The cursor could not be put at the project start, so the markers were not listed.');
      let reference = start.position;
      for (let i = 0; i < maxMarkers; i++) {
        const sentAt = Date.now();
        await this.runCommand('Transport', 'Locate Next Marker');
        const step = await this.positionChange(reference, sentAt, false, false);
        if (!step.changed || !step.position || step.position.time === null || (reference.time !== null && step.position.time <= reference.time)) {
          complete = true;
          break;
        }
        stops.push(step.position);
        reference = step.position;
      }
      let end: TransportPosition | null = null;
      const last = stops[stops.length - 1];
      if (last) {
        // Where Cubase stops after the last marker: the project end. A marker exactly there cannot be told apart.
        const sentAt = Date.now();
        await this.runCommand('Transport', 'Goto End');
        const moved = await this.positionChange(last, sentAt, false, false);
        end = moved.changed ? moved.position : last;
      }
      const isEnd = (p: TransportPosition) => end !== null && end.time !== null && p.time !== null && Math.abs(p.time - end.time) <= 0.011;
      // Stopped by maxMarkers right at the project end: nothing was left out.
      if (!complete && last && isEnd(last)) complete = true;
      const markers = stops.filter((p) => !isEnd(p)).map((p, i) => ({ number: i + 1, time: p.timeDisplay, seconds: p.time }));
      const restored = await this.locateTime(before.time);
      return {
        markers,
        projectEnd: end ? { time: end.timeDisplay, seconds: end.time } : null,
        cursorRestored: restored.applied === true,
        complete,
      };
    } catch (error) {
      await this.locateTime(before.time).catch(() => undefined);
      throw error;
    }
  }

  /** Moves both cycle locators by `by` seconds (the right one first when moving right); null when they cannot be set. */
  private async shiftLocators(position: TransportPosition, by: number): Promise<TransportPosition | null> {
    const { left, right } = position;
    if (left === null || left === undefined || right === null || right === undefined) return null;
    const order: Array<[number, number]> = by > 0 ? [[TRANSPORT_TAGS.right, right + by], [TRANSPORT_TAGS.left, left + by]] : [[TRANSPORT_TAGS.left, left + by], [TRANSPORT_TAGS.right, right + by]];
    for (const [tag, seconds] of order) {
      await this.call('da.setParam', { scope: 'transport', tag, resolvePlugin: false, display: formatTimeDisplay(Math.max(0, seconds)) }).catch(() => undefined);
    }
    const now = await this.transportPosition(true);
    if (!now || now.left === null || now.left === undefined || Math.abs(now.left - Math.max(0, left + by)) > 0.011) return null;
    return now;
  }

  // ---------------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------------

  /** Named slots of the bank page shown now with their uids (a small answer), and the bank size. */
  async pageChannels(): Promise<{ size: number; slots: BankSlot[] }> {
    const page = await this.readBankPage();
    return { size: page.size, slots: page.slots };
  }

  /**
   * The bank channels of the page shown now in the DirectAccess mixer tree, by bank index: kind (from the
   * internal name) and the parameters of `tags` (4102: the output). null when the bridge script is older than
   * 'mixer.channels' or DirectAccess is off.
   */
  async mixerChannels(tags: number[] = []): Promise<Map<number, MixerChannelInfo> | null> {
    return (await this.mixerState(tags))?.channels ?? null;
  }

  /**
   * mixerChannels plus the channels DirectAccess reports hidden in the MixConsole (hidden: null when the script or
   * Cubase does not report visibility). Fills the kind cache (by uid) for the channels it reports.
   */
  async mixerState(tags: number[] = []): Promise<MixerState | null> {
    try {
      const result = await this.call<{ channels: Array<Omit<MixerChannelInfo, 'kind'>>; hidden?: HiddenChannel[] | null }>('mixer.channels', { tags });
      const channels = new Map(result.channels.map((c) => [c.index, { ...c, kind: channelKind(c.uniqueName, c.typeName) }]));
      // Scripts older than the uid of each item leave the cache alone.
      for (const channel of channels.values()) if (channel.uid) this.kindByUid.set(channel.uid, channel.kind);
      this.kindsAvailable = true;
      return { channels, hidden: Array.isArray(result.hidden) ? result.hidden.map((h) => ({ title: h.title ?? '', uid: h.uid || null, uniqueName: h.uniqueName ?? null })) : null };
    } catch (error) {
      if (/Unknown method|DirectAccess|not available/i.test((error as Error).message)) {
        this.kindsAvailable = false;
        return null;
      }
      throw error;
    }
  }

  /**
   * Kind of the bank channels given (on the page shown now), by bank index: from the per-uid cache (a channel keeps
   * its kind), asking DirectAccess only for channels not seen before. null when DirectAccess cannot tell.
   */
  async channelKinds(slots: Array<{ index: number; uid?: string | null }>, mixer?: Map<number, MixerChannelInfo> | null): Promise<Map<number, ChannelKind> | null> {
    const out = new Map<number, ChannelKind>();
    if (mixer) for (const slot of slots) if (slot.uid && mixer.has(slot.index)) this.kindByUid.set(slot.uid, (mixer.get(slot.index) as MixerChannelInfo).kind);
    const unknown = slots.filter((s) => !s.uid || !this.kindByUid.has(s.uid));
    let fresh: Map<number, MixerChannelInfo> | null | undefined = mixer;
    if (unknown.length > 0 && !mixer && this.kindsAvailable) {
      // undefined: this read failed (try again next time); null: no DirectAccess.
      fresh = await this.mixerChannels().catch(() => undefined);
      if (fresh) for (const slot of unknown) if (slot.uid) this.kindByUid.set(slot.uid, fresh.get(slot.index)?.kind ?? 'unknown');
    }
    for (const slot of slots) {
      const kind = (slot.uid ? this.kindByUid.get(slot.uid) : undefined) ?? fresh?.get(slot.index)?.kind;
      if (kind) out.set(slot.index, kind);
    }
    return out.size === 0 && slots.length > 0 && !this.kindsAvailable ? null : out;
  }

  /** Mix values of the current bank page (see 'snapshot.read'), read a few channels at a time to keep answers small. */
  async readSnapshotPage(): Promise<SnapshotPage> {
    const step = 12;
    const page: SnapshotPage = { fields: [], size: 0, channels: [] };
    let total = step;
    for (let from = 0; from < total; from += step) {
      const part = await this.call<SnapshotPage & { total: number }>('snapshot.read', { from, count: step });
      total = part.total;
      page.size = part.total;
      page.fields = part.fields;
      page.channels.push(...part.channels);
    }
    // Bridge scripts older than autoRead in snapshot.read: read it apart (one small request).
    if (!page.fields.includes('autoRead') && page.channels.length > 0) {
      const values = await this.readValues(page.channels.map((c) => this.channelKey(c.index, 'autoRead'))).catch(() => ({}) as Record<string, ValueState>);
      page.fields = [...page.fields, 'autoRead'];
      for (const channel of page.channels) channel.values = [...channel.values, values[this.channelKey(channel.index, 'autoRead')]?.v ?? null];
    }
    await this.blankMissingFields(page);
    this.noteSlots(page.channels);
    return page;
  }

  /**
   * Sets to null the fields the page's channels do not have, by channel kind (see MISSING_FIELDS), so repeated
   * reads of a channel agree whatever its bank slot showed before. Kinds come from DirectAccess once per channel.
   */
  private async blankMissingFields(page: SnapshotPage): Promise<void> {
    const kinds = await this.channelKinds(page.channels.filter((c) => c.uid));
    for (const channel of page.channels) {
      const kind = kinds?.get(channel.index);
      const missing = kind ? MISSING_FIELDS[kind] : undefined;
      if (!kind || !missing) continue;
      channel.kind = kind;
      channel.values = channel.values.map((value, i) => (missing.test(page.fields[i]) ? null : value));
    }
  }

  // ---------------------------------------------------------------------------
  // Mixer bank
  // ---------------------------------------------------------------------------

  /** Runs bank-moving work one call at a time; nested calls from the same task run directly. */
  private exclusiveBank<T>(task: () => Promise<T>): Promise<T> {
    if (this.bankContext.getStore()) return task();
    return this.bankLock.run(() => this.bankContext.run(true, task));
  }

  /** Unique id of a bank slot's channel (null for an empty slot). */
  private async channelUid(index: number): Promise<string | null> {
    const { uid } = await this.call<{ uid: string | null }>('channel.uid', { index });
    return uid || null;
  }

  /** Unique id of the first channel of the bank page: tells pages apart even with repeated names. */
  private firstChannelUid(): Promise<string | null> {
    return this.channelUid(0);
  }

  /** Named slots of the current bank page with their uids. */
  private async readBankPage(): Promise<BankPage> {
    // brief: titles and uids only (scripts older than it send the whole summary, without uids).
    const { bankSize, channels } = await this.call<{ bankSize: number; channels: Array<{ index: number; title: string; uid?: string | null }> }>(
      'state.channels',
      { includeValues: false, includeEmpty: true, uids: true, brief: true },
    );
    this.noteSlots(channels);
    const slots = channels.filter((c) => c.title).map((c) => ({ index: c.index, title: c.title, uid: c.uid || null }));
    // Scripts older than the uids option of state.channels: ask for the two uids paging needs.
    const withUids = channels.some((c) => c.uid !== undefined);
    const firstUid = withUids ? channels.find((c) => c.index === 0)?.uid || null : await this.firstChannelUid();
    const last = slots[slots.length - 1];
    const lastUid = !last ? null : withUids ? last.uid : slots.length >= bankSize ? await this.channelUid(last.index) : null;
    return { size: bankSize, slots, firstUid, lastUid };
  }

  /**
   * After a bank action: waits until Cubase has moved the bank (the first channel's uid changes, or
   * becomes `expect`), then until the titles settle, because they arrive one by one and pass through
   * empty while the bank moves.
   */
  private async settleBank(
    before: string | null,
    expect: string | null | undefined,
    windowMs: number,
    expected?: BankSlot[],
  ): Promise<{ moved: boolean; page: BankPage }> {
    const deadline = Date.now() + windowMs;
    let uid = before;
    do {
      await sleep(this.bankPollMs);
      uid = await this.firstChannelUid().catch(() => uid);
      if (expect !== undefined ? uid === expect : uid !== before) break;
    } while (Date.now() < deadline);
    let page = await this.readBankPage();
    const settleBy = Date.now() + this.bankTimeoutMs;
    while (Date.now() < settleBy) {
      if (expected && sameSlots(page.slots, expected)) break;
      await sleep(this.bankPollMs);
      const again = await this.readBankPage();
      const stable = again.slots.length > 0 && pageSignature(again) === pageSignature(page);
      page = again;
      if (stable) break;
    }
    return { moved: page.firstUid !== before, page };
  }

  /**
   * Sends one bank action and waits for its effect. Cubase sometimes answers bank actions late although
   * it performs them, so the answer is not awaited as proof: the first channel's uid decides.
   */
  private async bankStep(
    action: BankAction,
    options: { expect?: string | null; mustMove?: boolean; expected?: BankSlot[] } = {},
  ): Promise<{ moved: boolean; page: BankPage }> {
    const before = await this.firstChannelUid();
    await this.runAction(`bank.${action}`).catch(() => undefined);
    const windowMs = options.expect !== undefined || options.mustMove ? this.bankTimeoutMs : this.bankTimeoutMs / 2;
    return this.settleBank(before, options.expect, windowMs, options.expected);
  }

  /** Puts the bank on the first channel and remembers that channel. */
  private async resetBank(): Promise<BankPage> {
    let step = await this.bankStep('reset', { expect: this.homeUid });
    if (this.homeUid !== undefined && step.page.firstUid !== this.homeUid && !step.moved) {
      // A lost or late action, or a new first channel: a reset is safe to send again.
      step = await this.bankStep('reset');
    }
    this.homeUid = step.page.firstUid;
    this.position = { offset: 0, uid: step.page.firstUid };
    return step.page;
  }

  /** Position (in MixConsole bank order) of the first slot of the bank, when the server knows it. */
  knownBankPosition(firstUid: string | null | undefined): number | null {
    if (!this.position || !firstUid || this.position.uid !== firstUid) return null;
    return this.position.offset;
  }

  /**
   * Pages through the whole bank from its first channel, recording every channel, and calls `visit`
   * on each page (it returns true when its page is the last one). A full page is never the last one,
   * so a `next` that does not move the bank from it is an error, not the end of the bank.
   */
  private async scanBank(scan: BankScan, visit?: PageVisit): Promise<void> {
    let page =
      this.homeUid !== undefined && scan.startUid !== null && scan.startUid === this.homeUid
        ? await this.readBankPage() // already on the first page
        : await this.resetBank();
    scan.size = page.size;
    for (let p = 0; p < 50; p++) {
      const offset = p * page.size;
      scan.offset = offset;
      scan.pages = p + 1;
      if (page.firstUid) scan.pageFirst.set(page.firstUid, offset);
      for (const slot of page.slots) {
        scan.entries.push({ page: p + 1, index: slot.index, position: offset + slot.index, title: slot.title, uid: slot.uid });
      }
      this.position = { offset, uid: page.firstUid };
      const last = (await visit?.(p)) === true || page.slots.length < page.size;
      if (last) break;
      let step = await this.bankStep('next', { mustMove: true });
      if (!step.moved) {
        // Lost or very late: send it again, then check the bank did not move twice (the late one plus this one).
        step = await this.bankStep('next', { mustMove: true });
        if (!step.moved) throw new Error(`Cubase did not move the mixer bank past page ${p + 1} (${p + 1} pages looked at). Try again.`);
        if (page.lastUid && step.page.firstUid !== page.lastUid) {
          const back = await this.bankStep('shiftLeft', { expect: page.lastUid });
          if (back.page.firstUid !== page.lastUid) throw new Error(`The mixer bank skipped a page after page ${p + 1}. Try again.`);
          step = await this.bankStep('shiftRight', { expect: step.page.firstUid, expected: step.page.slots });
        }
      }
      if (step.page.firstUid !== null && step.page.firstUid === page.lastUid) {
        // A project with a multiple of the bank size: this page only repeats the last channel.
        scan.offset = offset + page.size - 1;
        this.position = { offset: scan.offset, uid: step.page.firstUid };
        break;
      }
      page = step.page;
    }
    scan.start = locate(scan, scan.startUid);
  }

  /** Moves the bank to an offset seen by a scan, checking every step against the uids the scan saw. */
  private async navigateBank(scan: BankScan, to: number): Promise<void> {
    const total = scan.entries.length;
    let from = locate(scan, await this.firstChannelUid());
    for (let attempt = 0; attempt < 3 && from !== to; attempt++) {
      for (const action of planBankMoves(from, to, total, scan.size)) {
        const expected = action === 'reset' ? 0 : from === null ? null : applyBankAction(from, action, total, scan.size);
        const page =
          action === 'reset'
            ? await this.resetBank()
            : (
                await this.bankStep(action, {
                  expect: expected === null ? undefined : (uidAt(scan, expected) ?? undefined),
                  mustMove: true,
                  expected: expected === null ? undefined : slotsAt(scan, expected),
                })
              ).page;
        from = locate(scan, page.firstUid);
        // A lost, late or doubled action: plan again from wherever the bank is.
        if (from === null || from !== expected) break;
      }
    }
    if (from !== to) throw new Error(`Could not move the mixer bank to channel position ${to}`);
    scan.offset = to;
    this.position = { offset: to, uid: uidAt(scan, to) };
  }

  /** Puts the bank back where the scan started; when that fails, on its first page. */
  private async returnToStart(scan: BankScan): Promise<boolean> {
    const start = scan.start ?? locate(scan, scan.startUid);
    if (start !== null) {
      try {
        await this.navigateBank(scan, start);
      } catch {
        // Falls back to a reset below.
      }
    }
    if (scan.startUid !== null && (await this.firstChannelUid()) === scan.startUid) return true;
    await this.resetBank();
    return scan.startUid !== null && scan.startUid === this.homeUid;
  }

  /** Scans the bank, runs a task and always puts the bank back on the page it started from. */
  private async withBankScan<T>(task: (scan: BankScan) => Promise<T>, visit?: PageVisit): Promise<{ value: T; bankRestored: boolean; pages: number }> {
    const scan: BankScan = { size: 0, entries: [], pageFirst: new Map(), pages: 0, offset: 0, start: null, startUid: await this.firstChannelUid() };
    let value!: T;
    let bankRestored = false;
    try {
      await this.scanBank(scan, visit);
      value = await task(scan);
    } finally {
      bankRestored = await this.returnToStart(scan).catch(() => false);
    }
    return { value, bankRestored, pages: scan.pages };
  }

  /** Bank offset to act on a channel from: the page the call started on when it shows the channel, else the channel's page. */
  private offsetFor(scan: BankScan, entry: BankEntry): number {
    if (scan.start !== null && entry.position >= scan.start && entry.position < scan.start + scan.size) return scan.start;
    return (entry.page - 1) * scan.size;
  }

  /**
   * Visits every page of the mixer bank from the first one, then puts the bank back on the page it
   * started from, also when a visit fails. A visit returns true when its page is the last one (not full).
   * With several visits, each one is a pass over all the pages; the bank goes back only at the end.
   */
  async forEachBankPage(visit: PageVisit | PageVisit[]): Promise<{ pages: number; bankRestored: boolean }> {
    const [first, ...more] = Array.isArray(visit) ? visit : [visit];
    return this.exclusiveBank(async () => {
      const { pages, bankRestored } = await this.withBankScan(async (scan) => {
        for (const pass of more) {
          for (let page = 0; page < scan.pages; page++) {
            if (pass.skip?.(page)) continue;
            await this.navigateBank(scan, page * scan.size);
            if ((await pass(page)) === true) break;
          }
        }
      }, first);
      return { pages, bankRestored };
    });
  }

  /**
   * Resolves a channel reference (see parseChannelRef and matchChannelName) and runs a task while the bank
   * shows that channel. A bank index addresses the page the bank shows now. A name is searched on every
   * page, and the bank goes back to the page it was on afterwards, also on errors. When it cannot go back,
   * the result gets a `bankWarning`.
   */
  async withChannel<T extends object>(ref: ChannelRef, task: (channel: ResolvedChannel) => Promise<T>): Promise<T> {
    const parsed = parseChannelRef(ref);
    return this.exclusiveBank(async () => {
      if (parsed.kind === 'index') return task(await this.channelAtIndex(parsed.index));
      const { value, bankRestored } = await this.withBankScan(async (scan) => {
        const match = matchChannelName(scan.entries, parsed.name, pagesLookedAt(scan.pages), parsed);
        const offset = this.offsetFor(scan, match);
        await this.navigateBank(scan, offset);
        return task(await this.channelAtIndex(match.position - offset, match));
      });
      if (!bankRestored) Object.assign(value, { bankWarning: BANK_NOT_RESTORED });
      return value;
    });
  }

  /**
   * withChannel for several references in one go: one scan at most, channels grouped by bank page, and
   * the bank put back once at the end. Bank indexes address the page the bank showed when the call began.
   * A reference that fails gets { error } in its place; the others still run.
   */
  async withChannels<T extends object>(
    refs: ChannelRef[],
    task: (channel: ResolvedChannel, i: number) => Promise<T>,
  ): Promise<{ results: Array<T | { error: string }>; bankRestored: boolean }> {
    return this.exclusiveBank(async () => {
      const results: Array<T | { error: string }> = new Array(refs.length);
      const fail = (i: number, error: unknown) => {
        results[i] = { error: error instanceof Error ? error.message : String(error) };
      };
      const run = async (i: number, find: () => ResolvedChannel) => {
        try {
          results[i] = await task(find(), i);
        } catch (error) {
          fail(i, error);
        }
      };
      const parsed = refs.map((ref, i) => {
        try {
          return parseChannelRef(ref);
        } catch (error) {
          fail(i, error);
          return null;
        }
      });
      // Indexes address the page shown now: pin them to their channel before the bank moves.
      const startPage = await this.channels(false, true, true);
      const pinned = new Map<number, ResolvedChannel>();
      parsed.forEach((p, i) => {
        if (p?.kind !== 'index') return;
        try {
          pinned.set(i, this.slotChannel(startPage, p.index));
        } catch (error) {
          fail(i, error);
        }
      });
      if (!parsed.some((p) => p?.kind === 'name')) {
        for (const [i, channel] of pinned) await run(i, () => channel);
        return { results, bankRestored: true };
      }
      const { bankRestored } = await this.withBankScan(async (scan) => {
        const targets: Array<{ i: number; match: NameMatch; offset: number }> = [];
        for (const [i, channel] of pinned) {
          const position = locate(scan, channel.uid) ?? (scan.start !== null ? scan.start + channel.index : null);
          const entry = position === null ? undefined : scan.entries[position];
          if (!entry) fail(i, new Error(`Lost track of bank index ${channel.index} while paging the bank`));
          else targets.push({ i, match: { ...entry, matchedBy: 'index' }, offset: scan.start ?? this.offsetFor(scan, entry) });
        }
        parsed.forEach((p, i) => {
          if (p?.kind !== 'name') return;
          try {
            const match = matchChannelName(scan.entries, p.name, pagesLookedAt(scan.pages), p);
            targets.push({ i, match, offset: this.offsetFor(scan, match) });
          } catch (error) {
            fail(i, error);
          }
        });
        // The page the call started on goes last, so the bank is already back when the work ends.
        const offsets = [...new Set(targets.map((t) => t.offset))].sort((a, b) => (a === scan.start ? 1 : b === scan.start ? -1 : b - a));
        for (const offset of offsets) {
          const group = targets.filter((t) => t.offset === offset).sort((a, b) => a.i - b.i);
          try {
            await this.navigateBank(scan, offset);
          } catch (error) {
            group.forEach((t) => fail(t.i, error));
            continue;
          }
          const page = await this.channels(false, true, true);
          for (const { i, match } of group) await run(i, () => this.slotChannel(page, match.position - offset, match));
        }
      });
      return { results, bankRestored };
    });
  }

  /** Resolves a reference on the current bank page only, without moving the bank. */
  async resolveOnCurrentPage(ref: ChannelRef): Promise<ResolvedChannel> {
    const parsed = parseChannelRef(ref);
    return this.exclusiveBank(async () => {
      const page = await this.channels(false, true, true);
      if (parsed.kind === 'index') return this.slotChannel(page, parsed.index);
      const entries = page.channels
        .filter((c) => c.title)
        .map((c) => ({ page: 0, index: c.index, position: c.index, title: c.title, uid: c.uid || null }));
      const match = matchChannelName(entries, parsed.name, 'the current bank page', parsed);
      return { ...this.slotChannel(page, match.index), matchedBy: match.matchedBy };
    });
  }

  private async channelAtIndex(index: number, match?: NameMatch): Promise<ResolvedChannel> {
    return this.slotChannel(await this.channels(false, true, true), index, match);
  }

  /** A named bank slot as a resolved channel; empty slots are rejected instead of addressed. */
  private slotChannel(page: { bankSize: number; channels: ChannelInfo[] }, index: number, match?: NameMatch): ResolvedChannel {
    const slot = page.channels.find((c) => c.index === index);
    if (!slot || !slot.title) {
      const count = page.channels.filter((c) => c.title).length;
      if (index >= page.bankSize) throw new Error(`Bank index ${index} is out of range: the bank has ${page.bankSize} slots (0-${page.bankSize - 1})`);
      throw new Error(
        `Bank slot ${index} is empty: the current bank page ${count > 0 ? `has ${count} channels (indexes 0-${count - 1})` : 'shows no channels'}. ` +
          'See cubase_list_channels, or cubase_bank to show other channels.',
      );
    }
    const uid = slot.uid || null;
    if (match && (match.uid && uid ? match.uid !== uid : match.title !== slot.title)) {
      throw new Error(`The mixer bank moved while looking for ${describeEntry(match)}: slot ${index} shows "${slot.title}". Try again.`);
    }
    const offset = match ? match.position - index : this.knownBankPosition(page.channels.find((c) => c.index === 0)?.uid);
    const { values: _values, ...info } = slot;
    return {
      ...info,
      uid,
      matchedBy: match?.matchedBy ?? 'index',
      ...(offset === null ? {} : { position: offset + index, page: Math.floor((offset + index) / page.bankSize) + 1 }),
    };
  }

  /**
   * Moves the bank like cubase_bank and reports where it landed. A `next` from the last page (not
   * full) is not sent: Cubase would leave a page with only the last channel. prev/shiftLeft from the
   * first page are not sent either.
   */
  async moveBank(action: BankAction): Promise<BankMove> {
    return this.exclusiveBank(async () => {
      const before = await this.readBankPage();
      const offset = this.knownBankPosition(before.firstUid);
      const atStart = offset === 0 || (before.firstUid !== null && before.firstUid === this.homeUid);
      let page = before;
      let position = offset;
      let sent = true;
      if ((action === 'next' && before.slots.length < before.size) || ((action === 'prev' || action === 'shiftLeft') && atStart)) {
        sent = false;
        if (atStart) {
          position = 0;
          this.position = { offset: 0, uid: before.firstUid };
        }
      } else if (action === 'reset') {
        page = await this.resetBank();
        position = 0;
      } else {
        const step = await this.bankStep(action);
        page = step.page;
        if (!step.moved) position = offset;
        else if (page.firstUid !== null && page.firstUid === this.homeUid) position = 0;
        else if (offset === null) position = null;
        else if (action === 'next') position = page.firstUid !== null && page.firstUid === before.lastUid ? offset + before.size - 1 : offset + before.size;
        else if (action === 'prev') position = Math.max(offset - before.size, 0);
        else position = offset + (action === 'shiftRight' ? 1 : -1);
        this.position = position === null ? null : { offset: position, uid: page.firstUid };
      }
      return {
        ...this.bankResult(action, before, page, position),
        sent,
        repeatsLastChannel: action === 'next' && page.slots.length === 1 && page.firstUid !== null && page.firstUid === before.lastUid,
      };
    });
  }

  /** What a bank move reports: where the bank is now. */
  private bankResult(action: BankMove['action'], before: BankPage, page: BankPage, position: number | null): BankMove {
    return {
      action,
      sent: true,
      moved: page.firstUid !== before.firstUid,
      bankSize: page.size,
      count: page.slots.length,
      atEnd: page.slots.length < page.size,
      repeatsLastChannel: false,
      position,
      atStart: position === 0 || (page.firstUid !== null && page.firstUid === this.homeUid),
      page: position === null || page.size <= 0 ? null : Math.floor(position / page.size) + 1,
      channels: page.slots,
    };
  }

  /**
   * Pages through the whole bank (see scanBank), then moves it to the offset `pick` chooses. On an error the
   * bank goes back to the page it started from.
   */
  private async scanAndMove(pick: (scan: BankScan) => number): Promise<BankScan> {
    const scan: BankScan = { size: 0, entries: [], pageFirst: new Map(), pages: 0, offset: 0, start: null, startUid: await this.firstChannelUid() };
    try {
      await this.scanBank(scan);
      await this.navigateBank(scan, pick(scan));
      return scan;
    } catch (error) {
      await this.returnToStart(scan).catch(() => false);
      throw error;
    }
  }

  /**
   * Moves the bank to page n (1-based, counted from the first channel: page n starts at channel (n - 1) * size).
   * Page 1 is a reset; other pages page through the bank once to count the pages. A page past the last one is
   * an error and leaves the bank where it was.
   */
  async goToPage(n: number): Promise<BankMove & { pages: number | null }> {
    if (!Number.isInteger(n) || n < 1) throw new Error(`Bank page must be a whole number from 1 (got ${n})`);
    return this.exclusiveBank(async () => {
      const before = await this.readBankPage();
      if (n === 1) {
        const page = await this.resetBank();
        return { ...this.bankResult('goToPage', before, page, 0), pages: null };
      }
      const scan = await this.scanAndMove((scan) => {
        if (n > scan.pages) throw new Error(`The mixer bank has ${scan.pages} ${scan.pages === 1 ? 'page' : 'pages'} of ${scan.size} channels: there is no page ${n}. The bank was put back where it was.`);
        return (n - 1) * scan.size;
      });
      const page = await this.readBankPage();
      return { ...this.bankResult('goToPage', before, page, scan.offset), pages: scan.pages };
    });
  }

  /**
   * Moves the bank so it shows a channel: nothing moves when the page shown now has it (a bank index is always on
   * it); otherwise the bank goes to the page the channel is on (pages counted from the first channel). channel is
   * where it is now. Unlike the other tools, the bank stays there.
   */
  async showChannel(ref: ChannelRef): Promise<BankMove & { channel: ResolvedChannel }> {
    const parsed = parseChannelRef(ref);
    return this.exclusiveBank(async () => {
      const before = await this.readBankPage();
      if (parsed.kind === 'index') {
        const channel = await this.channelAtIndex(parsed.index);
        return { ...this.bankResult('showChannel', before, before, this.knownBankPosition(before.firstUid)), sent: false, channel };
      }
      let match: NameMatch | null = null;
      const scan = await this.scanAndMove((scan) => {
        match = matchChannelName(scan.entries, parsed.name, pagesLookedAt(scan.pages), parsed);
        return this.offsetFor(scan, match);
      });
      const found = match as unknown as NameMatch;
      const page = await this.readBankPage();
      const channel = await this.channelAtIndex(found.position - scan.offset, found);
      return { ...this.bankResult('showChannel', before, page, scan.offset), channel };
    });
  }

  /**
   * Renames a channel through DirectAccess: writes the display of its "Name" parameter (tag 1024) on the channel's
   * object in the mixer tree (found by unique id now: object ids change when tracks are added or removed) and waits
   * until the bank shows the new name. Cubase leaves no Edit history step for it. Without DirectAccess it fails
   * with an error whose code is NO_DIRECT_ACCESS.
   */
  async renameChannel(
    ref: ChannelRef,
    name: string,
    options: { expectUid?: string | null } = {},
  ): Promise<{ channel: ResolvedChannel; before: string; after: string | null; renamed: boolean; verified: boolean; bankWarning?: string }> {
    const wanted = name.trim();
    if (!wanted) throw new Error('The new name is blank');
    return this.withChannel(ref, async (channel) => {
      if (options.expectUid && channel.uid !== options.expectUid) {
        throw new Error(`Bank index ${channel.index} shows "${channel.title}" now, not the channel to rename: nothing was written`);
      }
      const mixer = await this.mixerChannels();
      if (!mixer) {
        throw Object.assign(new Error('DirectAccess is not available (DirectAccess off in the bridge script, or a script older than mixer.channels): rename with mode "field"'), {
          code: 'NO_DIRECT_ACCESS',
        });
      }
      const object = mixer.get(channel.index);
      if (!object || (object.uid && channel.uid && object.uid !== channel.uid)) {
        throw new Error(`"${channel.title}" (bank index ${channel.index}) was not found in the DirectAccess mixer tree: try again, or rename it with mode "field"`);
      }
      const written = await this.setDirectDisplay('mixconsole', { objectId: object.objectId, tag: NAME_TAG, resolvePlugin: false }, wanted);
      // The bank title arrives through a callback: poll it (by uid, the slot must still show the same channel).
      const deadline = Date.now() + this.confirmMs;
      let after: string | null = null;
      for (let attempt = 0; ; attempt++) {
        const page = await this.channels(false, true, true).catch(() => null);
        const slot = page?.channels.find((c) => c.index === channel.index);
        if (slot && (!channel.uid || !slot.uid || slot.uid === channel.uid)) after = slot.title;
        if (after === wanted || Date.now() >= deadline) break;
        await sleep(this.backoff(attempt));
      }
      const renamed = after === wanted;
      return { channel, before: channel.title, after, renamed, verified: renamed && written.matches };
    });
  }

  /**
   * Runs Channel & Track Visibility / ShowAll and checks with DirectAccess that no channel is hidden any more.
   * hiddenBefore / hiddenAfter are null when DirectAccess does not report visibility.
   */
  async showAllChannels(): Promise<{ hiddenBefore: HiddenChannel[] | null; hiddenAfter: HiddenChannel[] | null; verified: boolean | null }> {
    return this.exclusiveBank(async () => {
      const before = (await this.mixerState().catch(() => null))?.hidden ?? null;
      await this.runCommand('Channel & Track Visibility', 'ShowAll');
      if (before === null) return { hiddenBefore: null, hiddenAfter: null, verified: null };
      const deadline = Date.now() + this.confirmMs;
      let after: HiddenChannel[] | null = before;
      for (let attempt = 0; ; attempt++) {
        await sleep(this.backoff(attempt));
        after = (await this.mixerState().catch(() => null))?.hidden ?? after;
        if ((after?.length ?? 0) === 0 || Date.now() >= deadline) break;
      }
      // The bank shows other channels now: its position, and its first channel, are not known any more.
      this.position = null;
      this.homeUid = undefined;
      return { hiddenBefore: before, hiddenAfter: after, verified: (after?.length ?? 0) === 0 };
    });
  }

  /** On/off of a value, null when unknown. */
  private async readSwitch(key: string): Promise<boolean | null> {
    const state = await this.getValue(key).catch(() => null);
    return !state || state.v === null ? null : state.v > 0.5;
  }

  /** The channel selected now, with its bank index and uid when the bank page shown now has it. */
  private async previousSelection(): Promise<PreviousSelection> {
    const info = await this.selectionInfo().catch(() => null);
    if (!info || isSelectionStale(info) || !info.title) return { title: null, index: null, uid: null };
    const inBank = info.bankSelected?.find((b) => b.title === info.title);
    const uid = inBank ? await this.channelUid(inBank.index).catch(() => null) : (info.uid ?? null);
    const recordEnabled = inBank ? await this.readSwitch(`ch.${inBank.index}.record`).catch(() => null) : null;
    return { title: info.title, index: inBank?.index ?? null, uid, recordEnabled };
  }

  /**
   * Selects a channel so the "selected track" objects (EQ, inserts, strip, DirectAccess) point at it.
   * The selection stays when the bank goes back to its page after a lookup by name. A channel that is
   * already selected is not selected again (with record following the selection, each selection arms the
   * track and Cubase creates an empty take file). sideEffects says what else changed; disarm switches record
   * off again when the selection armed it.
   */
  async focusChannel(
    ref: ChannelRef,
    options: { disarm?: boolean } = {},
  ): Promise<{
    channel: ResolvedChannel;
    selectedTitle: string;
    verified: boolean;
    applied: Applied;
    bankWarning?: string;
    previous: PreviousSelection;
    sideEffects: SelectionSideEffects;
  }> {
    return this.exclusiveBank(async () => {
      // Read on the page shown now, before a lookup moves the bank: the bank index of the old selection refers to it.
      const previous = await this.previousSelection();
      const focused = await this.withChannel(ref, (channel) =>
        this.lock.run(async () => {
          const key = `ch.${channel.index}.selected`;
          const recordKey = `ch.${channel.index}.record`;
          const now = await this.selectionInfo().catch(() => null);
          const alreadySelected = now !== null && selectionIs(now, channel);
          const recordBefore = await this.readSwitch(recordKey);
          let selectedTitle = now?.title ?? '';
          let verified = alreadySelected;
          if (!alreadySelected) {
            await this.setValue(key, 1);
            // Cubase reports the new selection 2-8 s late on big projects (and the sel.* values after it).
            const started = Date.now();
            const deadline = started + this.selectionTimeoutMs;
            let resent = false;
            for (let attempt = 0; !verified && Date.now() < deadline; attempt++) {
              await sleep(Math.min(this.backoff(attempt), Math.max(0, deadline - Date.now())));
              // Not resent by the bridge: this loop polls until its own deadline.
              const selected = await this.selectionInfo(undefined, { retry: false }).catch(() => null);
              if (selected) {
                selectedTitle = selected.title;
                verified = selectionIs(selected, channel);
              }
              if (!verified && !resent && Date.now() - started >= this.selectionTimeoutMs / 3) {
                // The same absolute write once more (a 1->0 pulse could deselect the channel if the first write lands late).
                resent = true;
                await this.setValue(key, 1).catch(() => undefined);
              }
            }
          }
          let recordEnabled = recordBefore;
          if (verified && !alreadySelected) {
            if (recordBefore === false && options.disarm) {
              // The arm comes with the selection callbacks, sometimes a moment after them.
              const armed = await this.waitForValue(recordKey, (s) => s.v !== null && s.v > 0.5, Math.min(this.confirmMs, 1000));
              recordEnabled = armed.state.v === null ? null : armed.state.v > 0.5;
            } else {
              recordEnabled = await this.readSwitch(recordKey);
            }
          }
          const sideEffects: SelectionSideEffects = {
            previousSelection: previous.title,
            selectionChanged: verified && !alreadySelected,
            recordEnabled,
            armedBySelection: recordBefore === false && recordEnabled === true,
          };
          if (sideEffects.armedBySelection && options.disarm) {
            await this.setValue(recordKey, 0);
            const off = await this.waitForValue(recordKey, (s) => s.v !== null && s.v < 0.5);
            sideEffects.disarmed = off.confirmed ? 'confirmed' : 'unconfirmed';
            sideEffects.recordEnabled = off.state.v === null ? null : off.state.v > 0.5;
          }
          return { channel, selectedTitle, verified, applied: (verified ? 'confirmed' : 'unconfirmed') as Applied, sideEffects };
        }),
      );
      return { ...focused, previous };
    });
  }

  /**
   * Selects the channel that was selected before a tool selected another one: by its bank index when the
   * bank shows it (checked by uid), else by name. With record following the selection, Cubase moves the arm
   * back too.
   */
  async restoreSelection(
    previous: PreviousSelection,
    current: { title: string; uid: string | null },
  ): Promise<NonNullable<SelectionSideEffects['restoredSelection']>> {
    if (!previous.title) return { skipped: 'no mixer channel was selected before' };
    if (previous.uid && current.uid ? previous.uid === current.uid : previous.title === current.title) return { skipped: 'it was the channel selected before' };
    try {
      let ref: ChannelRef = previous.title;
      if (previous.index !== null && previous.uid && (await this.channelUid(previous.index).catch(() => null)) === previous.uid) ref = previous.index;
      // Selecting it again arms it (record follows selection): disarm when it was not armed before (live, 15 Oct 2026).
      const focus = await this.focusChannel(ref, { disarm: previous.recordEnabled === false });
      let disarmed = focus.sideEffects.disarmed;
      if (previous.recordEnabled === false && !disarmed) {
        // Cubase can confirm the selection (and arm the track) seconds late, after focusChannel stopped
        // waiting: watch the record switch a while longer and switch it off if it comes on (live, 15 Oct 2026).
        const key = this.channelKey(focus.channel.index, 'record');
        const armed = await this.waitForValue(key, (state) => state.v !== null && state.v > 0.5, this.selectionTimeoutMs).catch(() => null);
        if (armed?.confirmed) disarmed = (await this.setBool(key, false).catch(() => null))?.applied ?? 'unconfirmed';
      }
      return {
        channel: focus.channel.title,
        applied: focus.applied,
        ...(disarmed ? { disarmed } : {}),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  channelKey(index: number, field: string): string {
    return `ch.${index}.${field}`;
  }
}
