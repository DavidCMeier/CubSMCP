import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  sendFields,
  SEND_SLOTS,
  type ChannelRef,
  type CubaseClient,
  type ValueState,
  type ChannelInfo,
  type PreviousSelection,
  type ResolvedChannel,
  type SelectionSideEffects,
} from '../cubase/client.js';
import type { AudioAnalyzer } from '../analysis/audio.js';
import type { MacUi } from '../ui/macos.js';
import type { Config } from '../config.js';
import type { CommandEntry } from '../cubase/commands.js';
import { parseDisplay } from '../cubase/display.js';

export interface ToolContext {
  server: McpServer;
  client: CubaseClient;
  analyzer: AudioAnalyzer;
  ui: MacUi;
  config: Config;
  commands: CommandEntry[];
}

export const CHANNEL_REF_HELP =
  'Mixer channel: a bank index, a channel name, or {name, occurrence?, exact?}. ' +
  'A whole number (or a text of digits, e.g. "12") is a bank index on the bank page shown now (see cubase_list_channels): ' +
  'indexes are relative to the bank, so they change when cubase_bank moves it. ' +
  'Any other text is a name, searched on every bank page ignoring case: the exact name first, then a unique prefix, then a unique substring. ' +
  'When several channels match, the call fails and lists them (page, index and uid): add #N for the Nth channel with that exact name in MixConsole order (e.g. "G L#2"). ' +
  'The object form only takes the exact name (ignoring case; no prefix or substring, and the name is literal, "#N" included): occurrence picks the Nth channel with that name, ' +
  'exact: false allows the prefix and substring fallbacks again. ' +
  'A lookup by name pages the bank and puts it back on its page. Blank names, and numbers that are not whole and >= 0, are rejected.';

/** A channel named exactly (see ChannelSpec): no prefix or substring fallback unless exact is false. */
export const channelSpec = z
  .object({
    name: z.string().trim().min(1).describe('The whole channel name (ignoring case), taken literally'),
    occurrence: z.number().int().min(1).optional().describe('The Nth channel with exactly this name, in MixConsole order (1 = first)'),
    exact: z.boolean().optional().describe('Default true: only the exact name. false also tries a unique prefix, then a unique substring'),
  })
  .strict();

export const channelRef = z.union([z.number().int().min(0), z.string().trim().min(1), channelSpec]).describe(CHANNEL_REF_HELP);

export const optionalChannelRef = channelRef
  .optional()
  .describe(`Channel to select and work on; if omitted, the currently selected track is used. ${CHANNEL_REF_HELP}`);

export const normalized = z.number().min(0).max(1);

/** For tools that switch values: Cubase reports switches through callbacks that come 1-8 s after the write. */
export const SWITCH_LAG_NOTE =
  'Switches are written as absolute on/off values and each one waits (a few seconds at most) until Cubase reports the new state: ' +
  'state is what Cubase reports, and applied "unconfirmed" means it had not arrived yet (read it again later instead of switching it again).';

/** For tools that select the channel they are given. */
export const SELECTION_NOTE =
  'Giving "channel" selects it in Cubase (the channel strip and plugins are only reachable on the selected track); a channel already selected is not selected again. ' +
  'With Cubase\'s preference "Enable Record on Selected Audio Track" on, selecting also record-arms the track, and Cubase creates an empty (0-byte) take file in the project\'s Audio folder each time ' +
  '(File > Cleanup removes them; turn the preference off while mixing). sideEffects reports the previous selection, recordEnabled and armedBySelection; ' +
  'disarm: true switches record off again, restoreSelection: true selects the previous channel again when done.';

export const selectionOptions = {
  disarm: z.boolean().optional().describe('If selecting the channel record-armed it, switch record off again right away (needs channel)'),
  restoreSelection: z
    .boolean()
    .optional()
    .describe('When done, select the channel that was selected before (needs channel; with record following the selection Cubase moves the arm back too)'),
};

/** A channel a tool selected: what identifies it, the selection before, and what else changed. */
export interface SelectedChannel {
  identity: ReturnType<typeof channelIdentity> & { bankWarning?: string };
  channel: ResolvedChannel;
  previous: PreviousSelection;
  sideEffects: SelectionSideEffects;
}

/** Selects a channel for a tool; fails when Cubase does not report the new selection in time. */
export async function selectChannel(client: CubaseClient, channel: ChannelRef, options: { disarm?: boolean } = {}): Promise<SelectedChannel> {
  const focus = await client.focusChannel(channel, options);
  if (!focus.verified) {
    throw new Error(
      `Could not select "${focus.channel.title}" (bank index ${focus.channel.index}): Cubase still reports "${focus.selectedTitle}" as the selected track. ` +
        'It reports selections seconds late on big projects, so it may still switch: check with cubase_get_channel_strip before trying again.',
    );
  }
  return {
    identity: { ...channelIdentity(focus.channel), ...(focus.bankWarning ? { bankWarning: focus.bankWarning } : {}) },
    channel: focus.channel,
    previous: focus.previous,
    sideEffects: focus.sideEffects,
  };
}

/**
 * Runs work on a channel's selection: selects it when given (null when not), and afterwards, with
 * restoreSelection, selects the previous channel again (also when the work failed). The result's
 * sideEffects object gets restoredSelection added.
 */
export async function withSelection<T>(
  client: CubaseClient,
  channel: ChannelRef | undefined,
  options: { disarm?: boolean; restoreSelection?: boolean },
  work: (selection: SelectedChannel | null) => Promise<T>,
): Promise<T> {
  if (channel === undefined) {
    if (options.disarm !== undefined || options.restoreSelection !== undefined) {
      throw new Error('disarm and restoreSelection only apply with "channel" (without it nothing gets selected)');
    }
    return work(null);
  }
  const selection = await selectChannel(client, channel, options);
  try {
    return await work(selection);
  } finally {
    if (options.restoreSelection) selection.sideEffects.restoredSelection = await client.restoreSelection(selection.previous, selection.channel);
  }
}

interface ToolOptions {
  readOnly?: boolean;
  destructive?: boolean;
  title?: string;
}

/** What a handler gets besides its arguments. */
export interface ToolExtra {
  /**
   * Sends notifications/progress when the client asked for them (a progressToken in the request's _meta);
   * otherwise it does nothing. A failed notification never fails the tool.
   */
  progress: (progress: number, total?: number, message?: string) => Promise<void>;
}

/** The part of the SDK's RequestHandlerExtra that ToolExtra needs. */
interface SdkExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>;
}

function toolExtra(extra: SdkExtra | undefined): ToolExtra {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return { progress: async () => undefined };
  return {
    progress: async (progress, total, message) => {
      try {
        await send({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } });
      } catch {
        // Progress is a courtesy: a closed transport must not turn a finished analysis into an error.
      }
    },
  };
}

/**
 * Registers a tool whose handler returns plain data; the result is serialized as compact JSON text
 * (indentation made answers 25-100 % bigger, and Claude Code moves answers over ~25k tokens to a file).
 */
export function defineTool<S extends ZodRawShape>(
  ctx: ToolContext,
  name: string,
  description: string,
  shape: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>, extra: ToolExtra) => Promise<unknown>,
  options: ToolOptions = {},
): void {
  ctx.server.registerTool(
    name,
    {
      title: options.title,
      description,
      // Strict: unknown keys are rejected instead of silently dropped (a typo must not turn into a no-op).
      inputSchema: z.object(shape).strict(),
      annotations: {
        readOnlyHint: options.readOnly ?? false,
        destructiveHint: options.destructive ?? false,
        openWorldHint: false,
      },
    },
    // The SDK infers argument types from the shape; the cast keeps this helper generic.
    (async (args: z.objectOutputType<S, z.ZodTypeAny>, extra?: SdkExtra) => {
      try {
        const result = await handler(args, toolExtra(extra));
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    }) as never,
  );
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Throws when more than one of these arguments is given (or none, when one is required). Returns the one given. */
export function onlyOne<A extends object>(args: A, keys: Array<keyof A & string>, required = true): (keyof A & string) | undefined {
  const given = keys.filter((key) => args[key] !== undefined);
  if (given.length > 1) throw new Error(`Give only one of ${keys.join(', ')} (got ${given.join(' and ')})`);
  if (required && given.length === 0) throw new Error(`Give one of ${keys.join(', ')}`);
  return given[0];
}

/** Throws before anything is selected or written when none of these arguments is given. */
export function requireAny<A extends object>(args: A, keys: Array<keyof A & string>): void {
  if (!keys.some((key) => args[key] !== undefined)) throw new Error(`Nothing to change: give at least one of ${keys.join(', ')}`);
}

/** What identifies the channel a tool acted on, for its result (names repeat in real projects). */
export function channelIdentity(channel: ResolvedChannel) {
  return {
    channel: channel.title,
    index: channel.index,
    uid: channel.uid,
    ...(channel.position !== undefined ? { position: channel.position, page: channel.page } : {}),
    ...(channel.matchedBy !== 'index' && channel.matchedBy !== 'exact' ? { matchedBy: channel.matchedBy } : {}),
  };
}

export interface FriendlyValue {
  display: string | null;
  units: string | null;
  normalized: number | null;
  value?: number | null;
}

export function friendlyValue(state: ValueState | null | undefined): FriendlyValue | null {
  if (!state) return null;
  const parsed = parseDisplay(state.d, state.u);
  return {
    display: state.d,
    units: state.u,
    normalized: state.v === null ? null : Math.round(state.v * 10000) / 10000,
    value: parsed ? (Number.isFinite(parsed.value) ? parsed.value : null) : null,
  };
}

export function bool(state: ValueState | null | undefined): boolean | null {
  if (!state || state.v === null) return null;
  return state.v > 0.5;
}

/** Turns raw "ch.N.*" / "sel.*" value maps into a readable channel description. */
export function describeChannelValues(values: Record<string, ValueState>, prefix: string, sendTitles: string[] = []) {
  const get = (suffix: string) => values[`${prefix}.${suffix}`];
  const sends: Array<Record<string, unknown>> = [];
  for (let s = 0; s < 16; s++) {
    const level = get(`send.${s}.level`);
    const destination = sendDestination(sendTitles, s);
    // Cubase exposes 8 send values on every channel, also where there is no send (and on outputs, which have none).
    if (!level || !destination) continue;
    sends.push({
      slot: s + 1,
      destination,
      level: friendlyValue(level),
      on: bool(get(`send.${s}.on`)),
      preFader: bool(get(`send.${s}.prePost`)),
      prePost: prePostWord(get(`send.${s}.prePost`)),
    });
  }
  return {
    volume: friendlyValue(get('volume')),
    pan: friendlyValue(get('pan')),
    mute: bool(get('mute')),
    solo: bool(get('solo')),
    recordEnabled: bool(get('record')),
    monitor: bool(get('monitor')),
    selected: bool(get('selected')),
    automationRead: bool(get('autoRead')),
    automationWrite: bool(get('autoWrite')),
    inputGain: friendlyValue(get('pre.gain')),
    phaseInverted: bool(get('pre.phase')),
    lowCut: get('pre.lowCutOn') ? { on: bool(get('pre.lowCutOn')), frequency: friendlyValue(get('pre.lowCutFreq')) } : undefined,
    meter: friendlyValue(get('meter')),
    sends,
  };
}

/**
 * Destination of a send slot (0-based), or null when the slot has no send. Cubase 13 titles an empty send
 * slot with its number ("1".."8") and a routed one "N- Destination".
 */
export function sendDestination(sendTitles: string[] | undefined, slot: number): string | null {
  const title = sendTitles?.[slot]?.trim();
  if (!title || /^\d+$/.test(title)) return null;
  const numbered = /^(\d+)\s*-\s*(.*)$/.exec(title);
  if (numbered && Number(numbered[1]) === slot + 1) return numbered[2].trim() || null;
  return title;
}

/** Send pre/post as a word: Cubase stores 1 for pre-fader (it shows it as "Activ."/"On"). */
export function prePostWord(state: ValueState | null | undefined): 'pre' | 'post' | null {
  const on = bool(state);
  return on === null ? null : on ? 'pre' : 'post';
}

/** Why mute and solo reads cannot be trusted while a channel is soloed. */
export const SOLO_MASK_NOTE =
  'A channel is soloed: Cubase then shows solo-implied states (the other channels read mute on, the soloed channel reads its own mute off, ' +
  'the channels it feeds read solo on), so mute and solo here are not the real switches. Clear the solos to read them.';

/** "-6.02 dB", "C", "1.20 kHz": a value as Cubase shows it. */
export function shortValue(state: ValueState | null | undefined): string | null {
  if (!state || state.d === null || state.d === undefined) return null;
  return state.u ? `${state.d} ${state.u}` : state.d;
}

/** Fields cubase_list_channels and cubase://mixer can include, and the ch.N.* keys each one reads. */
export const CHANNEL_LIST_FIELDS = ['volume', 'pan', 'mute', 'solo', 'inputGain', 'sends', 'phase', 'lowCut', 'record', 'monitor', 'automation', 'selected', 'meter'] as const;
export type ChannelListField = (typeof CHANNEL_LIST_FIELDS)[number];
export const DEFAULT_LIST_FIELDS: ChannelListField[] = ['volume', 'pan', 'mute', 'solo', 'inputGain', 'sends'];

const LIST_FIELD_KEYS: Record<Exclude<ChannelListField, 'sends'>, string[]> = {
  volume: ['volume'],
  pan: ['pan'],
  mute: ['mute'],
  solo: ['solo'],
  inputGain: ['pre.gain'],
  phase: ['pre.phase'],
  lowCut: ['pre.lowCutOn', 'pre.lowCutFreq'],
  record: ['record'],
  monitor: ['monitor'],
  automation: ['autoRead', 'autoWrite'],
  selected: ['selected'],
  meter: ['meter'],
};

/** The ch.N.* fields to read for these list fields: sends only for slots that have a destination. */
export function listFieldKeys(channel: Pick<ChannelInfo, 'sendTitles'>, fields: readonly ChannelListField[]): string[] {
  const keys: string[] = [];
  for (const field of fields) {
    if (field !== 'sends') keys.push(...LIST_FIELD_KEYS[field]);
    else for (let s = 0; s < SEND_SLOTS; s++) if (sendDestination(channel.sendTitles, s)) keys.push(...sendFields(s).filter((f) => !f.endsWith('prePost')));
  }
  return keys;
}

/** A channel in few characters: values as Cubase shows them, switches as booleans, only real sends. */
export function compactChannel(channel: ChannelInfo, values: Record<string, ValueState>, fields: readonly ChannelListField[]) {
  const get = (field: string) => values[`ch.${channel.index}.${field}`];
  const out: Record<string, unknown> = { index: channel.index, name: channel.title, ...(channel.uid ? { uid: channel.uid } : {}) };
  for (const field of fields) {
    switch (field) {
      case 'volume':
      case 'pan':
      case 'inputGain':
      case 'meter':
        out[field] = shortValue(get(LIST_FIELD_KEYS[field][0]));
        break;
      case 'lowCut':
        out.lowCut = bool(get('pre.lowCutOn')) ? shortValue(get('pre.lowCutFreq')) : false;
        break;
      case 'automation':
        out.automation = { read: bool(get('autoRead')), write: bool(get('autoWrite')) };
        break;
      case 'sends': {
        const sends = [];
        for (let s = 0; s < SEND_SLOTS; s++) {
          const to = sendDestination(channel.sendTitles, s);
          if (to) sends.push({ slot: s + 1, to, level: shortValue(get(`send.${s}.level`)), on: bool(get(`send.${s}.on`)) });
        }
        out.sends = sends;
        break;
      }
      default:
        out[field] = bool(get(LIST_FIELD_KEYS[field][0]));
    }
  }
  return out;
}

/**
 * Bank channels with the chosen fields, read in small requests (never the whole bank with values).
 * offset/limit page through the named channels of the bank page shown now.
 */
export async function readChannelList(
  client: CubaseClient,
  options: { fields: readonly ChannelListField[]; offset?: number; limit?: number },
) {
  const { bankSize, channels: all } = await client.channels(false, false, true);
  const offset = options.offset ?? 0;
  const channels = all.slice(offset, offset + (options.limit ?? bankSize));
  // Mute reads need the solos of the page: while a channel is soloed Cubase shows solo-implied mutes.
  const switches = options.fields.includes('mute') || options.fields.includes('solo');
  const keys = [
    ...channels.flatMap((c) => listFieldKeys(c, options.fields).map((field) => client.channelKey(c.index, field))),
    ...(switches ? all.map((c) => client.channelKey(c.index, 'solo')) : []),
  ];
  const values = keys.length > 0 ? await client.readValues([...new Set(keys)]) : {};
  const soloActive = switches && all.some((c) => bool(values[client.channelKey(c.index, 'solo')]) === true);
  return {
    bankSize,
    total: all.length,
    firstUid: all.find((c) => c.index === 0)?.uid ?? null,
    soloActive,
    channels: channels.map((c) => compactChannel(c, values, options.fields)),
  };
}

export function describeChannel(channel: ChannelInfo) {
  return {
    index: channel.index,
    name: channel.title,
    ...(channel.uid ? { uid: channel.uid } : {}),
    color: channel.color,
    ...(channel.values ? describeChannelValues(channel.values, `ch.${channel.index}`, channel.sendTitles) : {}),
  };
}

/** Builds the selected-track value key for a slot target. */
export function slotScope(target: 'insert' | 'strip' | 'instrument', slot?: number, module?: string): string {
  if (target === 'insert') {
    if (!slot || slot < 1 || slot > 16) throw new Error('Insert slot must be between 1 and 16');
    return `sel.ins.${slot - 1}`;
  }
  if (target === 'strip') {
    if (!module) throw new Error('Strip module is required (gate, compressor, tools, saturator, limiter)');
    return `sel.strip.${module}`;
  }
  return 'sel.inst';
}

export const stripModule = z.enum(['gate', 'compressor', 'tools', 'saturator', 'limiter']);
