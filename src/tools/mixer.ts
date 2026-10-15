import { z } from 'zod';
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join, isAbsolute, relative, sep } from 'node:path';
import {
  CHANNEL_LIST_FIELDS,
  CHANNEL_REF_HELP,
  DEFAULT_LIST_FIELDS,
  defineTool,
  channelIdentity,
  channelRef,
  describeChannel,
  normalized,
  onlyOne,
  readChannelList,
  sendDestination,
  SOLO_MASK_NOTE,
  SWITCH_LAG_NOTE,
  requireAny,
  selectionOptions,
  sleep,
  withSelection,
  type ToolContext,
} from './common.js';
import { OUTPUT_TAG, SEND_SLOTS, type SnapshotPage, type BankMove, type BoolResult, type ChannelRef, type HiddenChannel, type PreviousSelection, type ResolvedChannel, type SeekResult } from '../cubase/client.js';
import {
  IGNORED,
  RESTORED,
  SnapshotCollector,
  automationReadOn,
  isAutomatable,
  matchChannels,
  normalizeSnapshot,
  pendingWrites,
  snapshotPath,
  type LiveChannel,
  type MixSnapshot,
  type SnapshotChannel,
} from '../cubase/snapshot.js';
import { describeRef } from '../cubase/bank.js';
import { registerRenameTool } from './rename.js';

const sendSlot = z.number().int().min(1).max(8).describe('Send slot, 1-8');

/** Fields cubase_restore_mix can be limited to, and the snapshot fields each one covers. */
const RESTORE_FIELDS = ['volume', 'pan', 'mute', 'solo', 'inputGain', 'phase', 'lowCut', 'sends'] as const;
const RESTORE_FIELD_TEST: Record<(typeof RESTORE_FIELDS)[number], (field: string) => boolean> = {
  volume: (f) => f === 'volume',
  pan: (f) => f === 'pan',
  mute: (f) => f === 'mute',
  solo: (f) => f === 'solo',
  inputGain: (f) => f === 'pre.gain',
  phase: (f) => f === 'pre.phase',
  lowCut: (f) => f.startsWith('pre.lowCut'),
  sends: (f) => f.startsWith('send.'),
};

/** Fader and send level: Cubase's fader ends at +6.02 dB; "-inf" writes -oo (normalized 0). */
const levelDb = z
  .union([z.number().min(-200).max(6.02), z.literal('-inf')])
  .describe('dB from -200 to +6.02 (the top of Cubase\'s fader), or "-inf" for -oo');
/** Pre-section input gain: Cubase's range is -48..+48 dB. */
const inputGainDb = z.number().min(-48).max(48).describe('Input gain in dB, -48..+48');

/** -oo written as normalized 0, reported like a search result. */
type LevelResult = Omit<SeekResult, 'target' | 'achieved'> & { target: number | '-inf'; achieved: number | null };

export function registerMixerTools(ctx: ToolContext): void {
  const { client } = ctx;
  registerRenameTool(ctx);
  /** The selection before a Channel Settings window was opened with restoreSelection, by channel uid (or name). */
  const editorSelections = new Map<string, PreviousSelection>();

  /** A level in dB by searching the display, or -oo ("-inf") by writing normalized 0. */
  async function seekLevel(key: string, db: number | '-inf'): Promise<LevelResult> {
    if (db !== '-inf') return client.seekDisplay(key, db);
    const state = await client.writeAndRead(key, 0);
    const reached = state.v !== null && state.v <= 1e-6;
    return { key, target: '-inf', achieved: null, display: state.d, units: state.u, normalized: state.v ?? 0, iterations: 1, withinTolerance: reached };
  }

  /**
   * A warning when the channel has automation read on: Cubase then replaces the values of automated parameters
   * with their automation as soon as the transport moves or plays. null when it is off or cannot be read.
   */
  async function automationWarning(index: number, title: string): Promise<string | null> {
    const state = await client.getValue(client.channelKey(index, 'autoRead')).catch(() => null);
    if (!state || state.v === null || state.v < 0.5) return null;
    return (
      `"${title}" has automation read on: Cubase replaces the values of its automated parameters with the automation as soon as the transport moves or plays, ` +
      'so this value may not last. Turn automation read off (cubase_set_channel_state automationRead: false) or edit the automation in Cubase to keep it.'
    );
  }

  /** Whether channels hidden in the MixConsole can be missing from the bank, from what the script reports. */
  async function hiddenChannelsNote(): Promise<string | null> {
    const caps = await client.capabilities().catch(() => null);
    const follow = (caps?.capabilities as { followVisibility?: boolean | null } | undefined)?.followVisibility;
    const showAll = 'Show them with cubase_bank action showAll (it checks that none stays hidden) and try again.';
    if (follow === false) {
      return `The bridge script asks Cubase to keep channels hidden in the MixConsole in the bank (followVisibility off). If channels you hid are missing anyway, Cubase left them out: ${showAll}`;
    }
    if (follow === true) {
      return `The bridge script follows MixConsole visibility (followVisibility: true in its CONFIG): channels hidden in the MixConsole are not in the bank. ${showAll}`;
    }
    return `Channels hidden in the MixConsole may be missing from the bank (this bridge script does not report followVisibility: reinstall it with npm run install:script). ${showAll}`;
  }

  /** Channels hidden in the MixConsole, for a result: count, the first names and a note; {} when none or unknown. */
  function hiddenReport(hidden: HiddenChannel[] | null | undefined): Record<string, unknown> {
    if (!hidden) return {};
    if (hidden.length === 0) return { hidden: 0 };
    const names = hidden.slice(0, 20).map((h) => h.title);
    return {
      hidden: hidden.length,
      hiddenChannels: hidden.length > 20 ? [...names, `... and ${hidden.length - 20} more`] : names,
      hiddenNote:
        `${hidden.length} ${hidden.length === 1 ? 'channel is' : 'channels are'} hidden in the MixConsole: Cubase can leave them out of the bank, so tools by name do not find them ` +
        'and cubase_restore_mix lists them as unmatched. cubase_bank action showAll shows them (it moves the bank indexes).',
    };
  }

  defineTool(
    ctx,
    'cubase_list_channels',
    'Lists the MixConsole channels in the current bank page (audio, instrument, group, FX, VCA and output channels) with name, unique id, kind (audio, instrument, sampler, midi, group, fx, vca, output, input; from DirectAccess, absent without it) and, compactly, the values chosen in fields ' +
      '(default: volume, pan, mute, solo, inputGain and the sends that have a destination; values as Cubase shows them, e.g. "-6.02 dB"). ' +
      'Use cubase_get_channel for every value of one channel. offset/limit page through the channels of the bank page (count is how many it has). ' +
      'Use the returned index or name to address channels: indexes refer to the bank page shown now. ' +
      'bankPosition is the MixConsole position of index 0 when the server knows it (null otherwise). ' +
      'hidden counts the channels DirectAccess reports hidden in the MixConsole (absent when it cannot tell); Cubase can leave them out of the bank: cubase_bank showAll shows them.',
    {
      includeValues: z.boolean().default(true).describe('Include the values in fields (false = names and uids only, fastest)'),
      fields: z
        .array(z.enum(CHANNEL_LIST_FIELDS))
        .min(1)
        .optional()
        .describe(`Values to include (default ${DEFAULT_LIST_FIELDS.join(', ')}). Each one adds to the answer: ask only for what you need.`),
      offset: z.number().int().min(0).default(0).describe('First channel to list, counted among the named channels of the bank page'),
      limit: z.number().int().min(1).max(48).default(48),
    },
    async ({ includeValues, fields, offset, limit }) => {
      const list = await readChannelList(client, { fields: includeValues ? (fields ?? DEFAULT_LIST_FIELDS) : [], offset, limit });
      const mixer = await client.mixerState().catch(() => null);
      const kinds = await client
        .channelKinds(
          list.channels.map((c) => ({ index: c.index as number, uid: (c.uid as string | undefined) ?? null })),
          mixer?.channels,
        )
        .catch(() => null);
      const more = offset + list.channels.length < list.total;
      return {
        bankSize: list.bankSize,
        count: list.total,
        ...(offset > 0 || more ? { offset, returned: list.channels.length } : {}),
        bankPosition: client.knownBankPosition(list.firstUid),
        ...(list.soloActive ? { soloActive: true } : {}),
        note:
          [
            more ? `More channels on this bank page: call again with offset ${offset + list.channels.length}.` : '',
            list.total >= list.bankSize ? 'The bank is full: use cubase_bank to page through more channels.' : '',
            list.soloActive ? SOLO_MASK_NOTE : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
        ...hiddenReport(mixer?.hidden),
        channels: list.channels.map(({ index, name, uid, ...values }) => ({
          index,
          name,
          ...(uid ? { uid } : {}),
          ...(kinds?.get(index as number) ? { kind: kinds.get(index as number) } : {}),
          ...values,
        })),
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_get_channel',
    'Returns the full state of one mixer channel (fader, pan, switches, input gain, phase, low cut, meter and the sends that have a destination; prePost "pre" or "post"), ' +
      'with its bank index, unique id and (when known) MixConsole position and bank page. soloActive says a channel of the page is soloed: mute and solo then show solo-implied states.',
    { channel: channelRef },
    async ({ channel }) =>
      client.withChannel(channel, async (info) => {
        // Only this channel's values (a few KB), not the whole bank with values (~150 KB, which stalls MIDI Remote).
        const values = await client.channelValues(info.index);
        const { channel: _name, ...identity } = channelIdentity(info);
        const described = describeChannel({ ...info, values });
        // Mute and solo reads are solo-implied while a channel of the page is soloed.
        const soloActive = (described.mute || described.solo) && (await client.soloedChannels()).length > 0;
        return { ...described, ...identity, ...(soloActive ? { soloActive: true, note: SOLO_MASK_NOTE } : {}) };
      }),
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_get_routing',
    'Reads the routing of one channel, or of every channel of the bank page shown now: output (the bus its output goes to, as DirectAccess shows it, tag 4102 "Output"/"Salida"; ' +
      '"No Bus"/"Sin bus" when it goes nowhere) and the destinations of its sends (slot and destination, from the send titles). kind is the channel type. ' +
      'Read-only: Cubase ignores writes to the output (by display, and normalized values are clamped to 0..1 while the value is a bus id), the API cannot set send destinations, ' +
      'and inputs are not exposed at all, so routing is changed by hand in Cubase. output is null without DirectAccess (or with a bridge script older than mixer.channels).',
    { channel: channelRef.optional().describe(`One channel (default: every channel of the bank page shown now). ${CHANNEL_REF_HELP}`) },
    async ({ channel }) => {
      const read = async (only?: ResolvedChannel) => {
        const page = await client.channels(false, false, true);
        const mixer = await client.mixerState([OUTPUT_TAG]).catch(() => null);
        const kinds = await client.channelKinds(page.channels.map((c) => ({ index: c.index, uid: c.uid ?? null })), mixer?.channels).catch(() => null);
        const list = page.channels.filter((c) => c.title && (!only || c.index === only.index));
        return {
          outputsAvailable: Boolean(mixer),
          channels: list.map((c) => {
            const sends = [];
            for (let slot = 0; slot < SEND_SLOTS; slot++) {
              const destination = sendDestination(c.sendTitles, slot);
              if (destination) sends.push({ slot: slot + 1, destination });
            }
            return {
              index: c.index,
              name: c.title,
              ...(c.uid ? { uid: c.uid } : {}),
              ...(kinds?.get(c.index) ? { kind: kinds.get(c.index) } : {}),
              output: mixer?.channels.get(c.index)?.params?.[OUTPUT_TAG]?.display ?? null,
              sends,
            };
          }),
        };
      };
      const note = 'Routing cannot be changed through the API: set outputs, inputs and send destinations by hand in Cubase.';
      if (channel === undefined) {
        const { outputsAvailable, channels } = await read();
        return { count: channels.length, outputsAvailable, channels, note };
      }
      return client.withChannel(channel, async (info) => {
        const { outputsAvailable, channels } = await read(info);
        const { index: _index, name: _name, uid: _uid, ...routing } = channels[0] ?? { output: null, sends: [] };
        return { ...channelIdentity(info), ...routing, outputsAvailable, note };
      });
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_bank',
    'Moves the mixer bank window when the project has more channels than the bank (48 slots). ' +
      'Cubase moves it by offset, not by fixed pages: next/prev move it 48 channels but never past the last channel or before the first one, ' +
      'shiftLeft/shiftRight move it one channel, reset goes back to the first channel. So after a shift the pages are no longer multiples of 48, ' +
      'and the last page can hold fewer channels. Bank indexes in every tool refer to the page shown now. ' +
      'goToPage (with page) shows page N counted from the first channel (it pages through the bank once to count the pages; a page past the last one is an error and the bank stays). ' +
      'showChannel (with channel) moves the bank to the page that has the channel and leaves it there (nothing moves when the page shown now has it); channel says where it is now. ' +
      'showAll runs Channel & Track Visibility / ShowAll, which shows every channel hidden in the MixConsole, and checks with DirectAccess that none is hidden afterwards (hiddenBefore, hiddenAfter, verified); the channels it shows shift the bank indexes. ' +
      'Waits until Cubase has moved the bank and returns moved, count, first and last channel, atStart (the bank starts at the first channel), atEnd (last page: next is not sent from it, since Cubase would show only the last channel), ' +
      'position (MixConsole position of index 0, null when unknown), page (the page index 0 is on, counted from the first channel) and hidden (channels DirectAccess reports hidden in the MixConsole).',
    {
      action: z.enum(['prev', 'next', 'reset', 'shiftLeft', 'shiftRight', 'goToPage', 'showChannel', 'showAll']),
      page: z.number().int().min(1).optional().describe('goToPage: the page to show, 1 = the first channel'),
      channel: channelRef.optional().describe(`showChannel: the channel to show. ${CHANNEL_REF_HELP}`),
    },
    async ({ action, page, channel }) => {
      if (page !== undefined && action !== 'goToPage') throw new Error('page only applies to goToPage');
      if (channel !== undefined && action !== 'showChannel') throw new Error('channel only applies to showChannel');
      if (action === 'goToPage' && page === undefined) throw new Error('goToPage needs page (1 = the first channel)');
      if (action === 'showChannel' && channel === undefined) throw new Error('showChannel needs channel');
      const notes: string[] = [];
      if (action === 'showAll') {
        const shown = await client.showAllChannels();
        const now = await client.pageChannels();
        const before = shown.hiddenBefore;
        const after = shown.hiddenAfter;
        const same = (a: HiddenChannel, b: HiddenChannel) => (a.uid && b.uid ? a.uid === b.uid : a.title === b.title);
        if (shown.verified === false) notes.push(`Cubase still reports ${after?.length} hidden ${after?.length === 1 ? 'channel' : 'channels'} after ShowAll: show them in the MixConsole by hand.`);
        if (shown.verified === null) notes.push('DirectAccess does not report channel visibility (DirectAccess off or an older bridge script): ShowAll was sent but could not be checked.');
        notes.push('Channels shown again take their place in the MixConsole: bank indexes changed, list the channels again before using them.');
        const channels = now.slots.map((c) => ({ index: c.index, name: c.title }));
        return {
          action,
          command: 'Channel & Track Visibility / ShowAll',
          hiddenBefore: before?.length ?? null,
          hiddenAfter: after?.length ?? null,
          verified: shown.verified,
          ...(before && before.length > 0 ? { shown: before.filter((h) => !after?.some((a) => same(a, h))).map((h) => h.title) } : {}),
          ...(after && after.length > 0 ? hiddenReport(after) : {}),
          bankSize: now.size,
          count: now.slots.length,
          atEnd: now.slots.length < now.size,
          first: channels[0] ?? null,
          last: channels[channels.length - 1] ?? null,
          channels,
          note: notes.join(' '),
        };
      }
      let move: BankMove & { pages?: number | null; channel?: ResolvedChannel };
      if (action === 'goToPage') move = await client.goToPage(page as number);
      else if (action === 'showChannel') {
        move = await client.showChannel(channel as ChannelRef);
        if (!move.moved) notes.push('The bank page shown now already has this channel: the bank did not move.');
      } else {
        move = await client.moveBank(action);
        if (!move.sent) notes.push(action === 'next' ? 'Not sent: this is the last bank page.' : 'Not sent: the bank already starts at the first channel.');
        else if (!move.moved) notes.push('Cubase did not move the bank (it is already at that end, or it did not react: run cubase_list_channels to check).');
        if (move.repeatsLastChannel) notes.push('This page only repeats the last channel: the previous page was the last one. Use prev or reset.');
      }
      const hidden = hiddenReport((await client.mixerState().catch(() => null))?.hidden);
      const channels = move.channels.map((c) => ({ index: c.index, name: c.title }));
      const { channel: shownChannel, pages, ...rest } = move;
      return {
        ...rest,
        ...(pages ? { pages } : {}),
        ...(shownChannel ? { channel: channelIdentity(shownChannel) } : {}),
        first: channels[0] ?? null,
        last: channels[channels.length - 1] ?? null,
        channels,
        ...hidden,
        ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      };
    },
  );

  defineTool(
    ctx,
    'cubase_set_volume',
    'Sets a channel fader. Give exactly one of volumeDb (-200..+6.02 dB, the fader ends at +6.02; "-inf" for -oo) or a raw normalized value. ' +
      'The dB search starts next to the target and goes on until Cubase shows it at its display resolution; the result is the value Cubase applied ' +
      '(withinTolerance false, and clamped when the fader ends before the target, say when it was not reached). Cubase plays the values it passes through. ' +
      'warning: the channel has automation read on, so Cubase replaces the value with the automation when the transport moves.',
    { channel: channelRef, volumeDb: levelDb.optional(), normalized: normalized.optional() },
    async (args) => {
      const mode = onlyOne(args, ['volumeDb', 'normalized']);
      return client.withChannel(args.channel, async (info) => {
        const key = client.channelKey(info.index, 'volume');
        const warning = await automationWarning(info.index, info.title);
        const result =
          mode === 'volumeDb' ? await seekLevel(key, args.volumeDb as number | '-inf') : { state: await client.writeAndRead(key, args.normalized as number) };
        return { ...channelIdentity(info), ...result, ...(warning ? { warning } : {}) };
      });
    },
  );

  defineTool(
    ctx,
    'cubase_set_pan',
    'Sets a channel pan. Give exactly one of pan, from -100 (hard left) to +100 (hard right) with 0 = center, or a raw normalized value. ' +
      'warning: the channel has automation read on, so Cubase replaces the value with the automation when the transport moves.',
    { channel: channelRef, pan: z.number().min(-100).max(100).optional(), normalized: normalized.optional() },
    async (args) => {
      const mode = onlyOne(args, ['pan', 'normalized']);
      return client.withChannel(args.channel, async (info) => {
        const key = client.channelKey(info.index, 'pan');
        const warning = await automationWarning(info.index, info.title);
        const result = mode === 'pan' ? await client.seekDisplay(key, args.pan as number) : { state: await client.writeAndRead(key, args.normalized as number) };
        return { ...channelIdentity(info), ...result, ...(warning ? { warning } : {}) };
      });
    },
  );

  /**
   * Writes mute while a channel may be soloed: always written (a read that matches proves nothing then), and
   * verified only when no channel of the page shows solo, since Cubase shows solo-implied mutes meanwhile.
   */
  async function writeMute(index: number, on: boolean): Promise<BoolResult & { maskedBySolo?: true }> {
    const key = client.channelKey(index, 'mute');
    const soloed = await client.soloedChannels();
    if (soloed.length === 0) return client.setBool(key, on, { force: true });
    return { ...(await client.setBool(key, on, { force: true, verify: false })), maskedBySolo: true };
  }

  defineTool(
    ctx,
    'cubase_set_channel_state',
    `Switches channel states on or off: mute, solo, record enable, monitor, automation read/write, input phase, open channel settings editor. ${SWITCH_LAG_NOTE} ` +
      'Mute and solo are always written (never skipped because the read already matches): solo off first, then mute, then solo on. While a channel is soloed ' +
      'Cubase shows solo-implied mutes, so a mute written then cannot be read back: it says maskedBySolo and applied "unconfirmed". ' +
      'sideEffects reports what changed besides the switches asked for: automationReadTurnedOn (Cubase switches automation read on with write), ' +
      'soloImplied (a solo makes the other channels read mute on and the channels it feeds read solo on), and for openEditor the selection (see below). ' +
      'openEditor: true selects the channel first (Cubase opens Channel Settings on the selected track) and, with Cubase\'s "record follows selection" preference, record-arms it: ' +
      'disarm: true switches record off again. The Channel Settings window follows the selection, so restoreSelection: true with openEditor: true keeps the selection while the window is open ' +
      'and remembers the channel selected before; openEditor: false with restoreSelection: true closes the window and selects that channel again (and disarms it when it was not armed). ' +
      'openEditor false without restoreSelection only closes the editor. ' +
      'Editor windows are hidden from Accessibility (ui_list_windows) while Cubase is in the background: editorOpen in cubase_get_channel_strip is the reliable check.',
    {
      channel: channelRef,
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      recordEnable: z.boolean().optional(),
      monitor: z.boolean().optional(),
      automationRead: z.boolean().optional(),
      automationWrite: z.boolean().optional().describe('Cubase switches automation read on too when write goes on (sideEffects.automationReadTurnedOn)'),
      phaseInvert: z.boolean().optional(),
      openEditor: z.boolean().optional().describe('Open/close the Channel Settings window (opening selects the channel, which can record-arm it)'),
      disarm: selectionOptions.disarm.describe('With openEditor: true, if selecting the channel record-armed it, switch record off again right away'),
      restoreSelection: selectionOptions.restoreSelection.describe(
        'With openEditor: true, remember the channel selected before (the window follows the selection, so it is not selected again yet); with openEditor: false, close the window and select that channel again',
      ),
    },
    async (args) => {
      requireAny(args, ['mute', 'solo', 'recordEnable', 'monitor', 'automationRead', 'automationWrite', 'phaseInvert', 'openEditor']);
      const { disarm, restoreSelection } = args;
      if (disarm !== undefined && args.openEditor !== true) {
        throw new Error('disarm only applies with openEditor: true (the other switches do not select the channel)');
      }
      if (restoreSelection !== undefined && args.openEditor === undefined) {
        throw new Error('restoreSelection only applies with openEditor (true remembers the selection, false goes back to it)');
      }
      if (args.openEditor === false && restoreSelection) {
        // Close the window first, then go back to the channel selected before it was opened.
        const closed = await client.withChannel(args.channel, async (info) => ({
          ...channelIdentity(info),
          results: [await client.setBool(client.channelKey(info.index, 'editorOpen'), false)],
          uid: info.uid,
          title: info.title,
        }));
        const saved = editorSelections.get(closed.uid ?? closed.title);
        editorSelections.delete(closed.uid ?? closed.title);
        const { uid: _uid, title: _title, ...out } = closed;
        if (!saved) return { ...out, sideEffects: { restoredSelection: { skipped: 'no selection was remembered when this channel\'s editor was opened' } } };
        return { ...out, sideEffects: { restoredSelection: await client.restoreSelection(saved, { title: closed.title, uid: closed.uid }) } };
      }
      // With the editor open the window follows the selection: remember the previous one instead of selecting it now.
      const restoreNow = args.openEditor === true ? false : restoreSelection;
      return withSelection(client, args.openEditor === true ? args.channel : undefined, { disarm, restoreSelection: restoreNow }, async (selection) =>
        client.withChannel(args.channel, async (info) => {
          const results: Array<BoolResult & { maskedBySolo?: true }> = [];
          // The selection's own sideEffects object: restoredSelection is added to it when the work is done.
          const sideEffects: Record<string, unknown> = selection ? (selection.sideEffects as unknown as Record<string, unknown>) : {};
          const solo = client.channelKey(info.index, 'solo');
          if (args.solo === false) results.push(await client.setBool(solo, false, { force: true }));
          if (args.mute !== undefined) results.push(await writeMute(info.index, args.mute));
          if (args.solo === true) {
            results.push(await client.setBool(solo, true, { force: true }));
            sideEffects.soloImplied =
              `While "${info.title}" is soloed Cubase shows the other channels with mute on and the channels it feeds with solo on: their real switches did not change (clear the solo to read them).`;
          }
          const autoReadKey = client.channelKey(info.index, 'autoRead');
          const readBefore = args.automationWrite === true ? await client.getValue(autoReadKey).catch(() => null) : null;
          const map: Array<[boolean | undefined, string]> = [
            [args.recordEnable, 'record'],
            [args.monitor, 'monitor'],
            [args.automationRead, 'autoRead'],
            [args.automationWrite, 'autoWrite'],
            [args.phaseInvert, 'pre.phase'],
            [args.openEditor, 'editorOpen'],
          ];
          for (const [value, field] of map) {
            if (value === undefined) continue;
            results.push(await client.setBool(client.channelKey(info.index, field), value));
          }
          if (args.automationWrite === true) {
            // Cubase switches read on with write (B-91), through a late callback.
            const wasOn = args.automationRead === true || (readBefore?.v ?? 0) > 0.5;
            const after = await client.waitForValue(autoReadKey, (s) => s.v !== null && s.v > 0.5, 1000).catch(() => null);
            const nowOn = after ? after.state.v !== null && after.state.v > 0.5 : null;
            if (!wasOn && nowOn) sideEffects.automationReadTurnedOn = true;
            if (args.automationRead === false && nowOn) {
              sideEffects.automationReadTurnedOn = true;
              sideEffects.automationNote = 'automationRead: false was written, but switching write on turned read on again.';
            }
          }
          if (args.openEditor === true && restoreSelection && selection) {
            editorSelections.set(info.uid ?? info.title, selection.previous);
            sideEffects.restoreSelection = selection.previous.title
              ? `Kept "${info.title}" selected while its Channel Settings window is open (the window follows the selection). Close it with openEditor: false, restoreSelection: true to select "${selection.previous.title}" again.`
              : 'No mixer channel was selected before: nothing to go back to.';
          }
          const masked = results.some((r) => r.maskedBySolo);
          return {
            ...channelIdentity(info),
            results,
            ...(selection || Object.keys(sideEffects).length > 0 ? { sideEffects } : {}),
            ...(masked ? { note: SOLO_MASK_NOTE } : {}),
          };
        }),
      );
    },
  );

  defineTool(
    ctx,
    'cubase_set_input_gain',
    'Sets the input gain (Pre section) of a channel in dB, -48..+48. This is the right place for gain staging.',
    { channel: channelRef, gainDb: inputGainDb },
    async ({ channel, gainDb }) =>
      client.withChannel(channel, async (info) => ({
        ...channelIdentity(info),
        ...(await client.seekDisplay(client.channelKey(info.index, 'pre.gain'), gainDb)),
      })),
  );

  defineTool(
    ctx,
    'cubase_set_low_cut',
    `Sets the Pre-section low cut (high-pass) filter of a channel. ${SWITCH_LAG_NOTE}`,
    { channel: channelRef, on: z.boolean().optional(), frequencyHz: z.number().min(20).max(20000).optional() },
    async (args) => {
      requireAny(args, ['on', 'frequencyHz']);
      const { on, frequencyHz } = args;
      return client.withChannel(args.channel, async (info) => {
        const out: Record<string, unknown> = { ...channelIdentity(info) };
        if (on !== undefined) out.on = await client.setBool(client.channelKey(info.index, 'pre.lowCutOn'), on);
        if (frequencyHz !== undefined) out.frequency = await client.seekDisplay(client.channelKey(info.index, 'pre.lowCutFreq'), frequencyHz);
        return out;
      });
    },
  );

  const noDestination = (slot: number, channel: string) =>
    `Send ${slot} of "${channel}" has no destination: Cubase keeps its values, but they do nothing until the send is routed (output channels have no sends at all).`;

  defineTool(
    ctx,
    'cubase_set_send',
    'Configures a channel send: level (levelDb, -200..+6.02 dB or "-inf", or normalized; not both), on/off and pre/post fader (preFader true = pre: Cubase stores 1 for pre and shows it as "Activ."/"On"). ' +
      `Destinations are read-only (set routing in Cubase or in your template); a slot without destination gets a warning. ${SWITCH_LAG_NOTE}`,
    {
      channel: channelRef,
      slot: sendSlot,
      levelDb: levelDb.optional(),
      normalized: normalized.optional(),
      on: z.boolean().optional(),
      preFader: z.boolean().optional(),
    },
    async (args) => {
      // Checked before any write: a contradictory call must not half-apply.
      onlyOne(args, ['levelDb', 'normalized'], false);
      requireAny(args, ['levelDb', 'normalized', 'on', 'preFader']);
      const { slot, levelDb: db, normalized: value, on, preFader } = args;
      return client.withChannel(args.channel, async (info) => {
        const base = client.channelKey(info.index, `send.${slot - 1}`);
        const destination = sendDestination(info.sendTitles, slot - 1);
        const out: Record<string, unknown> = { ...channelIdentity(info), slot, destination };
        if (!destination) out.warning = noDestination(slot, info.title);
        if (on !== undefined) out.on = await client.setBool(`${base}.on`, on);
        if (preFader !== undefined) {
          const result = await client.setBool(`${base}.prePost`, preFader);
          out.preFader = { ...result, prePost: result.state === null ? null : result.state ? 'pre' : 'post' };
        }
        if (db !== undefined) out.level = await seekLevel(`${base}.level`, db);
        else if (value !== undefined) out.level = await client.writeAndRead(`${base}.level`, value);
        return out;
      });
    },
  );

  const mixSend = z
    .object({
      slot: sendSlot,
      levelDb: levelDb.optional(),
      normalized: normalized.optional().describe('Send level as a raw normalized value (instead of levelDb)'),
      on: z.boolean().optional(),
      preFader: z.boolean().optional().describe('true = pre-fader, false = post-fader'),
    })
    .strict()
    .refine((send) => [send.levelDb, send.normalized, send.on, send.preFader].some((v) => v !== undefined), {
      message: 'A send change needs levelDb, normalized, on or preFader',
    })
    .refine((send) => send.levelDb === undefined || send.normalized === undefined, { message: 'Give only one of levelDb, normalized for a send' });
  const mixChange = z
    .object({
      channel: channelRef,
      volumeDb: levelDb.optional(),
      pan: z.number().min(-100).max(100).optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      inputGainDb: inputGainDb.optional(),
      sends: z.array(mixSend).optional(),
    })
    .strict()
    .refine((c) => [c.volumeDb, c.pan, c.mute, c.solo, c.inputGainDb, c.sends].some((v) => v !== undefined), {
      message: 'Nothing to change for this channel: give volumeDb, pan, mute, solo, inputGainDb or sends',
    });

  defineTool(
    ctx,
    'cubase_apply_mix',
    'Applies many channel changes in one call (static mix): fader dB (-200..+6.02 or "-inf"), pan, mute, solo, input gain (-48..+48 dB) and sends per channel ' +
      '(level in dB or normalized, on, preFader: true = pre-fader; destinations cannot be set). Ideal for setting a whole balance at once. ' +
      'Bank indexes refer to the bank page shown when the call starts; names are looked up on every page in one pass, the changes are applied page by page ' +
      'and the bank goes back to its page at the end. Each result identifies its channel (index, uid, position and page when known) and shows the values Cubase applied. ' +
      'notReached lists values Cubase did not reach ("volume: wanted -3, got -2.50"); mute, solo and send on wait for Cubase to report them (it does so 1-8 s late) and unverified lists those that had not arrived, ' +
      'or a mute written while a channel is soloed (Cubase then shows solo-implied mutes); warnings lists sends without destination and channels with automation read on ' +
      '(Cubase replaces the values of automated parameters with the automation when the transport moves). Per channel, solo off is written before mute and solo on after it. ' +
      'applied counts the channels where everything was applied and verified, partial the others without errors.',
    { changes: z.array(mixChange).min(1).max(128) },
    async ({ changes }) => {
      const { results, bankRestored } = await client.withChannels(
        changes.map((change) => change.channel),
        async (info, i) => {
          const change = changes[i];
          const entry: Record<string, unknown> = { ...channelIdentity(info) };
          const notReached: string[] = [];
          const unverified: string[] = [];
          const warnings: string[] = [];
          const seek = async (field: string, label: string, target: number | '-inf') => {
            const result = await seekLevel(client.channelKey(info.index, field), target);
            if (!result.withinTolerance) notReached.push(`${label}: wanted ${target}, got ${result.display ?? 'no value'}`);
            return result.display;
          };
          // Report the state Cubase ends up in, and list what did not take.
          const toggle = async (field: string, label: string, on: boolean, force = false) => {
            const result = await client.setBool(client.channelKey(info.index, field), on, { force });
            if (!result.verified) unverified.push(label);
            return result.state;
          };
          // Everything but solo can be automated.
          if ([change.volumeDb, change.pan, change.mute, change.inputGainDb, change.sends].some((v) => v !== undefined)) {
            const automated = await automationWarning(info.index, info.title);
            if (automated) warnings.push(automated);
          }
          if (change.inputGainDb !== undefined) entry.inputGain = await seek('pre.gain', 'inputGain', change.inputGainDb);
          if (change.volumeDb !== undefined) entry.volume = await seek('volume', 'volume', change.volumeDb);
          if (change.pan !== undefined) entry.pan = await seek('pan', 'pan', change.pan);
          if (change.solo === false) entry.solo = await toggle('solo', 'solo', false, true);
          if (change.mute !== undefined) {
            const result = await writeMute(info.index, change.mute);
            entry.mute = result.state;
            if (result.maskedBySolo) unverified.push('mute (masked by an active solo)');
            else if (!result.verified) unverified.push('mute');
          }
          if (change.solo === true) entry.solo = await toggle('solo', 'solo', true, true);
          for (const send of change.sends ?? []) {
            const base = `send.${send.slot - 1}`;
            if (!sendDestination(info.sendTitles, send.slot - 1)) warnings.push(noDestination(send.slot, info.title));
            if (send.on !== undefined) entry[`send${send.slot}On`] = await toggle(`${base}.on`, `send${send.slot}On`, send.on);
            if (send.preFader !== undefined) {
              const pre = await toggle(`${base}.prePost`, `send${send.slot}PreFader`, send.preFader);
              entry[`send${send.slot}PrePost`] = pre === null ? null : pre ? 'pre' : 'post';
            }
            if (send.levelDb !== undefined) entry[`send${send.slot}`] = await seek(`${base}.level`, `send${send.slot}`, send.levelDb);
            else if (send.normalized !== undefined) {
              const state = await client.writeAndRead(client.channelKey(info.index, `${base}.level`), send.normalized);
              entry[`send${send.slot}`] = state.d;
              if (state.applied !== 'confirmed') unverified.push(`send${send.slot}`);
              else if (state.differsFromRequest) notReached.push(`send${send.slot}: wanted normalized ${send.normalized}, got ${state.v === null ? 'no value' : Math.round(state.v * 10000) / 10000}`);
            }
          }
          if (notReached.length > 0) entry.notReached = notReached;
          if (unverified.length > 0) entry.unverified = unverified;
          if (warnings.length > 0) entry.warnings = warnings;
          return entry;
        },
      );
      const out = results.map((result, i) => ('error' in result ? { channel: changes[i].channel, error: result.error } : result));
      const ok = out.filter((r) => !('error' in r));
      const partial = ok.filter((r) => 'notReached' in r || 'unverified' in r).length;
      return {
        applied: ok.length - partial,
        ...(partial > 0 ? { partial } : {}),
        results: out,
        ...(bankRestored ? {} : { bankWarning: 'The mixer bank could not be put back on its page: check bank indexes with cubase_list_channels.' }),
      };
    },
  );

  defineTool(
    ctx,
    'cubase_snapshot_mix',
    'Saves the static mix (faders, pans, mutes, solos, input gain, phase, low cut, sends with a destination; null for what a channel does not have, such as the Pre section and sends of a MIDI channel) to a JSON snapshot so it can be compared or restored later. By default it pages through the whole MixConsole and puts the bank back where it was (also on a page moved with shiftLeft/shiftRight). Channels are saved with their Cubase unique id, so repeated names are told apart. ' +
      'The name may use letters, digits, "_", "-" and "."; anything else becomes "_" and the file stays in the snapshot folder. ' +
      'While a channel is soloed Cubase shows solo-implied mutes and solos, so mute and solo are then not saved (soloActive in the result): clear the solos first to keep them. ' +
      'Automation read is saved per channel (autoRead, not restored): automationRead counts the channels that have it on, whose automated values follow the cursor, so cubase_restore_mix leaves them alone by default. ' +
      'Only channels in the bank are saved: channels hidden in the MixConsole can be left out (see the note in the result). ' +
      'An existing snapshot with the same name is an error unless overwrite is true (checked before anything is read).',
    {
      name: z.string().trim().min(1).describe('Snapshot name, e.g. "v1-before-bus-comp"'),
      allPages: z.boolean().default(true).describe('Save every bank page (false = only the current bank)'),
      overwrite: z.boolean().default(false).describe('Replace a snapshot with the same name (default false: that is an error)'),
    },
    async ({ name, allPages, overwrite }) => {
      // Before paging the bank: a name that cannot be used, or that is taken, fails first.
      const file = snapshotPath(ctx.config.snapshotDir, name);
      const existing = await stat(file).catch(() => null);
      if (existing && !overwrite) {
        const saved = await snapshotInfo(file).catch(() => null);
        throw new Error(
          `Snapshot "${name}" already exists (${file}${saved && 'createdAt' in saved && saved.createdAt ? `, saved ${saved.createdAt}` : ''}): ` +
            'pass overwrite: true to replace it, or choose another name. Nothing was read or written.',
        );
      }
      const collector = new SnapshotCollector();
      let paging: { pages: number; bankRestored: boolean } = { pages: 1, bankRestored: true };
      if (allPages) {
        paging = await client.forEachBankPage(async () => {
          const page = await client.readSnapshotPage();
          collector.add(page);
          return page.channels.length < page.size;
        });
      } else collector.add(await client.readSnapshotPage());
      const snapshot: MixSnapshot = {
        version: 2,
        name,
        createdAt: new Date().toISOString(),
        allPages,
        ...(collector.soloActive ? { soloActive: true } : {}),
        channels: collector.result(),
      };
      await mkdir(ctx.config.snapshotDir, { recursive: true });
      await writeFile(file, JSON.stringify(snapshot, null, 2));
      const note = await hiddenChannelsNote();
      const hidden = hiddenReport((await client.mixerState().catch(() => null))?.hidden);
      const shown = collector.soloed.slice(0, 10).join('", "');
      const automated = collector.automated;
      return {
        file,
        ...(existing ? { replaced: true } : {}),
        channels: snapshot.channels.length,
        automationRead: automated.length,
        ...(automated.length > 0
          ? {
              automationNote:
                `Automation read is on in "${automated.slice(0, 10).join('", "')}"${automated.length > 10 ? ' and more' : ''}: their automated values follow the transport position, ` +
                'so they can differ from this snapshot after the cursor moves without anyone changing them. cubase_restore_mix does not write them unless writeAutomated is true.',
            }
          : {}),
        ...paging,
        ...(collector.soloActive
          ? {
              soloActive: true,
              warning: `Cubase showed solo on for "${shown}"${collector.soloed.length > 10 ? ' and more' : ''}: while a channel is soloed it shows solo-implied mutes and solos, so mute and solo were not saved. Clear the solos and save again to keep them.`,
            }
          : {}),
        ...(note ? { note } : {}),
        ...hidden,
      };
    },
  );

  /** What cubase_list_snapshots says about a snapshot file (an error instead when it is not a readable snapshot). */
  async function snapshotInfo(file: string) {
    const name = basename(file, '.json');
    const info = await stat(file);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> | null;
      const data = normalizeSnapshot(raw, file);
      return {
        name,
        file: basename(file),
        createdAt: data.createdAt || null,
        channels: data.channels.length,
        allPages: data.allPages,
        version: typeof raw?.version === 'number' ? raw.version : 1,
        ...(data.soloActive ? { soloActive: true } : {}),
        size: info.size,
      };
    } catch (error) {
      return { name, file: basename(file), size: info.size, error: error instanceof Error ? error.message : String(error) };
    }
  }

  defineTool(
    ctx,
    'cubase_list_snapshots',
    'Lists the saved mix snapshots, newest first: name, createdAt, number of channels, allPages (false: only one bank page was saved), version, soloActive (mute and solo not saved) and size in bytes. ' +
      'A file that is not a readable snapshot is listed with error.',
    {},
    async () => {
      await mkdir(ctx.config.snapshotDir, { recursive: true });
      const files = (await readdir(ctx.config.snapshotDir)).filter((f) => f.endsWith('.json'));
      const snapshots = await Promise.all(files.map((f) => snapshotInfo(join(ctx.config.snapshotDir, f))));
      snapshots.sort((a, b) => String(('createdAt' in b && b.createdAt) || '').localeCompare(String(('createdAt' in a && a.createdAt) || '')) || a.name.localeCompare(b.name));
      return { folder: ctx.config.snapshotDir, count: snapshots.length, snapshots };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_delete_snapshot',
    'Deletes a saved mix snapshot from the snapshot folder. The name is read like cubase_snapshot_mix reads it (a ".json" ending is dropped and other characters than letters, digits, "_", "-" and "." become "_"), ' +
      'so only files inside the snapshot folder can be deleted, whatever the name says ("../x" is ".._x.json" there). A snapshot that does not exist is an error.',
    { name: z.string().trim().min(1).describe('Snapshot name, as cubase_list_snapshots lists it (or as it was saved)') },
    async ({ name }) => {
      const dir = ctx.config.snapshotDir;
      // A name saved before names were sanitized is kept literally when that file exists (a plain file name only).
      const literal = join(dir, name.endsWith('.json') ? name : `${name}.json`);
      const inside = relative(dir, literal);
      const literalOk =
        !/[\\/]/.test(name) && inside && inside.split(sep)[0] !== '..' && !isAbsolute(inside) && (await stat(literal).catch(() => null))?.isFile();
      const file = literalOk ? literal : snapshotPath(dir, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new Error(`No snapshot "${name}" (${file}): see cubase_list_snapshots`);
      await unlink(file);
      return { deleted: basename(file, '.json'), file };
    },
    { destructive: true },
  );

  /** The file of a snapshot: an absolute path, a name saved before names were sanitized (kept literally), or a name. */
  async function snapshotToRead(snapshot: string): Promise<string> {
    if (isAbsolute(snapshot)) return snapshot;
    const dir = ctx.config.snapshotDir;
    const literal = join(dir, snapshot);
    const inside = relative(dir, literal);
    if (!/[\\/]/.test(snapshot) && inside && inside.split(sep)[0] !== '..' && (await stat(literal).catch(() => null))?.isFile()) return literal;
    return snapshotPath(dir, snapshot);
  }

  async function loadSnapshot(file: string, name: string): Promise<MixSnapshot> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No snapshot "${name}" (${file}): see cubase_list_snapshots`);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file} is not a mix snapshot: it is not valid JSON (${(error as Error).message})`);
    }
    return normalizeSnapshot(parsed, file);
  }

  /** Send and other fields Cubase ignored on a channel (by uid) in an earlier restore: not written again. */
  const ignoredByUid = new Map<string, Set<string>>();

  defineTool(
    ctx,
    'cubase_restore_mix',
    'Restores a mix snapshot: matches channels by Cubase unique id (or by name and position among channels with the same name), writes only the values that changed and reads them back to verify. Snapshots of the whole MixConsole page through every bank and put the bank back where it was. ' +
      'Solos are cleared first, so mutes can be read back (Cubase shows solo-implied mutes while a channel is soloed); a snapshot taken with a solo active has no mute and solo, and then neither is touched (soloNote). ' +
      'Values a channel does not have (sends without destination, the Pre section and sends of MIDI channels and VCA faders) are not written; ignoredByCubase lists writes Cubase ignored (an output channel exposes send values it does not have), and they are not written again in later restores. ' +
      'Results name repeated channels as "name#N" (the Nth with that name in MixConsole order), like channel references do. unmatched lists saved channels not found: deleted, renamed or hidden in the MixConsole. ' +
      'With allPages false on a whole-project snapshot, only the current bank page is restored: the other saved channels are counted in notOnThisPage, not unmatched. ' +
      'Channels with automation read on now are not written (except solo): their automated values follow the automation as soon as the transport moves, so a difference there may only mean the cursor moved. ' +
      'automated lists them with the fields that differ, and changedChannels does not count them; writeAutomated: true writes them anyway (automatedWritten), until the automation takes over again. ' +
      'dryRun: true only reads and compares: results list what would be written (changed, with the values now and in the snapshot, normalized), nothing is written and solos are not cleared, ' +
      'so while a channel is soloed (soloActiveNow) mute and solo differences can be solo-implied. ' +
      'channels restores only those channels (bank indexes on the page shown when the call starts, names or {name, occurrence}; a reference not found fails before anything is written): ' +
      'solos of other channels are left alone, and while one of them stays soloed mute and solo are not restored (soloKept). ' +
      'fields restores only those fields (volume, pan, mute, solo, inputGain, phase, lowCut, sends); solos are only cleared when mute or solo is restored.',
    {
      snapshot: z.string().trim().min(1).describe('Snapshot name or absolute path to its JSON file'),
      allPages: z
        .boolean()
        .optional()
        .describe('Page through every bank (default: as the snapshot was saved). false restores only the channels of the current bank page.'),
      writeAutomated: z
        .boolean()
        .default(false)
        .describe('Also write channels with automation read on (default false: they are listed in automated instead). The automation overrides them again when the transport moves.'),
      dryRun: z.boolean().default(false).describe('Compare only: list what would be written, write nothing'),
      channels: z.array(channelRef).min(1).max(256).optional().describe('Restore only these channels (default: every saved channel)'),
      fields: z.array(z.enum(RESTORE_FIELDS)).min(1).optional().describe('Restore only these fields (default: all of them)'),
    },
    async ({ snapshot, allPages, writeAutomated, dryRun, channels: only, fields }) => {
      const file = await snapshotToRead(snapshot);
      const data = await loadSnapshot(file, snapshot);
      const fieldWanted = (field: string) => !fields || fields.some((f) => RESTORE_FIELD_TEST[f](field));
      const switchesWanted = fieldWanted('mute') || fieldWanted('solo');
      // The channels to restore, by unique id, resolved before anything is written.
      let wanted: Set<string> | null = null;
      if (only) {
        const { results: found } = await client.withChannels(only, async (channel) => channel);
        const errors = found.flatMap((r, i) => ('error' in r ? [`${describeRef(only[i])}: ${r.error}`] : !r.uid ? [`${describeRef(only[i])}: no unique id (update the bridge script)`] : []));
        if (errors.length > 0) throw new Error(`Channels to restore not found, nothing was written: ${errors.join('; ')}`);
        wanted = new Set(found.map((r) => (r as { uid: string }).uid));
      }
      const isWanted = (channel: { uid: string | null }) => !wanted || (channel.uid !== null && wanted.has(channel.uid));
      const everyPage = allPages ?? data.allPages;
      // Part of a whole-project snapshot: channels of other pages are not checked, not missing.
      const partial = data.allPages && !everyPage;
      const keyOf = (page: number, channel: { index: number; uid: string | null }) => channel.uid ?? `${page}:${channel.index}`;

      // Pass 1: read the whole project and match it to the snapshot in one go.
      const live: LiveChannel[] = [];
      const labels = new Map<string, string>();
      const occurrences = new Map<string, number>();
      const soloedLive = new Map<number, number[]>();
      /** Channels Cubase showed soloed when the restore began (labels filled in below), and whether each one is restored. */
      const soloedNow: Array<{ key: string; page: number; wanted: boolean }> = [];
      const readPage = async (pageNumber: number) => {
        const page = await client.readSnapshotPage();
        const solo = page.fields.indexOf('solo');
        for (const channel of page.channels) {
          const key = keyOf(pageNumber, channel);
          live.push({ key, title: channel.title, uid: channel.uid });
          if (solo >= 0 && (channel.values[solo] ?? 0) > 0.5) {
            // Only the restored channels get their solo cleared: the others are left alone.
            if (isWanted(channel)) soloedLive.set(pageNumber, [...(soloedLive.get(pageNumber) ?? []), channel.index]);
            if (!soloedNow.some((s) => s.key === key)) soloedNow.push({ key, page: pageNumber, wanted: isWanted(channel) });
          }
          if (labels.has(key)) continue;
          // Same label as channel references: "G L#2" is the second "G L" in MixConsole order.
          const occurrence = (occurrences.get(channel.title) ?? 0) + 1;
          occurrences.set(channel.title, occurrence);
          labels.set(key, occurrence > 1 ? `${channel.title}#${occurrence}` : channel.title);
        }
        return page.channels.length < page.size;
      };
      let matched: ReturnType<typeof matchChannels> | null = null;
      const match = () => (matched ??= matchChannels(data, live, { partial }));

      // Pass 2: clear the solos (the snapshot has none, or it has no mutes and solos to restore and this is skipped),
      // so the mute reads of pass 3 are the real switches.
      const solosCleared: string[] = [];
      let solosStillOn = false;
      const clearSolos = Object.assign(
        async (pageNumber: number) => {
          const indexes = soloedLive.get(pageNumber) ?? [];
          const page = await client.readSnapshotPage();
          const solo = page.fields.indexOf('solo');
          const now = page.channels.filter((c) => indexes.includes(c.index) && (c.values[solo] ?? 0) > 0.5);
          if (now.length === 0) return;
          await client.setValues(now.map((c) => ({ key: client.channelKey(c.index, 'solo'), value: 0 })));
          solosCleared.push(...now.map((c) => labels.get(keyOf(pageNumber, c)) ?? c.title));
          const cleared = await client.waitForValues(
            now.map((c) => client.channelKey(c.index, 'solo')),
            (s) => s.v !== null && s.v < 0.5,
          );
          if (!cleared) solosStillOn = true;
        },
        { skip: (pageNumber: number) => dryRun || !switchesWanted || data.soloActive === true || !soloedLive.has(pageNumber) },
      );
      // A soloed channel that is not restored keeps its solo: mute and solo reads stay solo-implied, so they are not restored.
      // On the page being restored the solos are read again (a channel fed by a cleared solo no longer reads solo on);
      // the other pages count as they were read (they may still have the solo on).
      const keptSolos = new Set<string>();
      const soloKept = (pageNumber: number, page: SnapshotPage) => {
        const solo = page.fields.indexOf('solo');
        const stillHere = new Set(page.channels.filter((c) => solo >= 0 && (c.values[solo] ?? 0) > 0.5).map((c) => keyOf(pageNumber, c)));
        const kept = soloedNow.filter((s) => !s.wanted && (s.page !== pageNumber || stillHere.has(s.key)));
        kept.forEach((s) => keptSolos.add(s.key));
        return kept.length > 0;
      };

      // Pass 3: write what changed, page by page, and read it back.
      const results: Array<Record<string, unknown>> = [];
      const automated: Array<{ channel: string; index: number; page: number; uid: string | null; fields: string[] }> = [];
      const automatedWritten: string[] = [];
      const done = new Set<string>();
      const restorePage = async (pageNumber: number) => {
        const { matches } = match();
        const page = await client.readSnapshotPage();
        const last = page.channels.length < page.size;
        const touched: Array<{ index: number; uid: string | null; target: SnapshotChannel; entry: Record<string, unknown>; before: Array<number | null> }> = [];
        const kept = !dryRun && switchesWanted && !data.soloActive && soloKept(pageNumber, page);
        for (const channel of page.channels) {
          const key = keyOf(pageNumber, channel);
          const target = matches.get(key);
          if (!target || done.has(key) || !isWanted(channel)) continue;
          done.add(key);
          const known = channel.uid ? ignoredByUid.get(channel.uid) : undefined;
          const pending = pendingWrites(page.fields, channel.values, target).filter(
            (w) => fieldWanted(w.field) && !(kept && (w.field === 'mute' || w.field === 'solo')),
          );
          let writes = pending.filter((w) => !known?.has(w.field));
          const label = labels.get(key) ?? channel.title;
          // Automation read on: automated values follow the cursor, a difference there proves nothing and a write does not last.
          if (automationReadOn(page.fields, channel.values)) {
            const overridden = writes.filter((w) => isAutomatable(w.field)).map((w) => w.field);
            if (overridden.length > 0 && writeAutomated) automatedWritten.push(label);
            else if (overridden.length > 0) {
              automated.push({ channel: label, index: channel.index, page: pageNumber + 1, uid: channel.uid, fields: overridden });
              writes = writes.filter((w) => !overridden.includes(w.field));
            }
          }
          const entry: Record<string, unknown> = {
            channel: label,
            index: channel.index,
            page: pageNumber + 1,
            uid: channel.uid,
            changed: writes.map((w) => w.field),
          };
          const skipped = pending.filter((w) => known?.has(w.field)).map((w) => w.field);
          if (skipped.length > 0) entry.ignored = skipped;
          results.push(entry);
          if (dryRun) {
            if (writes.length > 0) {
              const round = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);
              entry.values = Object.fromEntries(writes.map((w) => [w.field, { now: round(channel.values[page.fields.indexOf(w.field)]), snapshot: round(w.value) }]));
            }
            continue;
          }
          try {
            if (writes.length > 0) {
              // Absolute values: the bridge sends them again if Cubase stalls.
              const items = writes.map((w) => ({ key: client.channelKey(channel.index, w.field), value: w.value }));
              await client.setValues(items);
              touched.push({ index: channel.index, uid: channel.uid, target, entry, before: channel.values });
            }
          } catch (error) {
            entry.error = error instanceof Error ? error.message : String(error);
          }
        }
        if (touched.length === 0) return last;
        await sleep(ctx.config.settleMs);
        const after = await client.readSnapshotPage();
        for (const { index, uid, target, entry, before } of touched) {
          const channel = after.channels.find((c) => c.index === index);
          if (!channel) continue;
          const written = entry.changed as string[];
          const off = after.fields.filter((field, i) => {
            const value = target.values[field];
            const current = channel.values[i];
            return written.includes(field) && value !== null && value !== undefined && current !== null && Math.abs(current - value) >= RESTORED;
          });
          // A value that did not move at all was ignored by Cubase: output channels, for example,
          // expose send values they do not have.
          const ignored = off.filter((field) => {
            const i = after.fields.indexOf(field);
            const was = before[i];
            const now = channel.values[i];
            return was !== null && now !== null && Math.abs(was - now) < IGNORED;
          });
          const failed = off.filter((field) => !ignored.includes(field));
          if (ignored.length > 0) {
            entry.ignored = [...((entry.ignored as string[] | undefined) ?? []), ...ignored];
            entry.changed = written.filter((field) => !ignored.includes(field));
            if (uid) ignoredByUid.set(uid, new Set([...(ignoredByUid.get(uid) ?? []), ...ignored]));
          }
          entry.verified = failed.length === 0;
          if (failed.length > 0) entry.notRestored = failed;
        }
        return last;
      };
      // All passes in one go, so the bank goes back to the page it was on before the first one.
      let paging: { pages: number; bankRestored: boolean } = { pages: 1, bankRestored: true };
      if (everyPage) paging = await client.forEachBankPage([readPage, clearSolos, restorePage]);
      else {
        await readPage(0);
        if (!clearSolos.skip(0)) await clearSolos(0);
        await restorePage(0);
      }
      const { matches, unmatched: allUnmatched, notChecked } = match();
      // With a channel filter only the chosen channels count: the others are not missing, just not asked for.
      const unmatched = wanted ? [] : allUnmatched;
      const labelOf = (key: string) => labels.get(key) ?? live.find((c) => c.key === key)?.title ?? key;

      const changed = results.filter((r) => (r.changed as string[]).length > 0 || r.notRestored);
      const notes: Record<string, unknown> = {};
      if (dryRun) {
        notes.dryRun = true;
        notes.dryRunNote = 'Nothing was written: results list what a restore would write (values normalized 0..1, now and in the snapshot).';
        if (soloedNow.length > 0) {
          notes.soloActiveNow = soloedNow.map((s) => labelOf(s.key));
          notes.soloActiveNote = `${SOLO_MASK_NOTE} A restore clears these solos first (unless they are kept), so its mute and solo writes can differ from this list.`;
        }
      }
      if (wanted) {
        const notInSnapshot = live.filter((c) => c.uid && wanted?.has(c.uid) && !matches.has(c.key)).map((c) => labelOf(c.key));
        if (notInSnapshot.length > 0) notes.notInSnapshot = [...new Set(notInSnapshot)];
      }
      if (keptSolos.size > 0) {
        notes.soloKept = [...keptSolos].map(labelOf);
        notes.soloKeptNote = 'These channels are soloed and not restored, so their solos were left on: Cubase then shows solo-implied mutes and solos, so mute and solo were not restored. Restore them too, or clear their solos first.';
      }
      if (solosCleared.length > 0) notes.solosCleared = solosCleared;
      if (solosStillOn) notes.soloWarning = `Cubase still showed solo on after clearing: mute reads may be solo-implied. ${SOLO_MASK_NOTE}`;
      if (data.soloActive) {
        notes.soloNote = 'The snapshot was taken while a channel was soloed (Cubase then shows solo-implied mutes and solos): mute and solo were not restored.';
      }
      if (automated.length > 0) {
        notes.automated = automated;
        notes.automatedNote =
          'These channels have automation read on: Cubase replaces the values of their automated parameters with the automation as soon as the transport moves, ' +
          'so the differences may only mean the cursor moved since the snapshot, and writes would not last. They were not written. ' +
          'Pass writeAutomated: true to write them anyway, or turn automation read off first (cubase_set_channel_state automationRead: false).';
      }
      if (automatedWritten.length > 0) {
        notes.automatedWritten = automatedWritten;
        notes.automatedWarning = 'These channels have automation read on: the automation overrides the restored values of automated parameters again when the transport moves.';
      }
      if (notChecked > 0) {
        notes.notOnThisPage = notChecked;
        notes.notOnThisPageNote = `${notChecked} saved channels are not on this bank page and were not checked (allPages: false). Restore with allPages: true to restore them too.`;
      }
      return {
        file,
        ...paging,
        matched: matches.size,
        changedChannels: changed.length,
        ...(dryRun ? {} : { notVerified: results.filter((r) => r.verified === false || r.error).length }),
        results: changed.concat(results.filter((r) => r.error && !changed.includes(r))),
        ignoredByCubase: results.filter((r) => r.ignored).map((r) => ({ channel: r.channel, fields: r.ignored })),
        unmatched,
        ...(only ? { channelsRestored: wanted?.size } : {}),
        ...(fields ? { fields } : {}),
        ...notes,
        ...(unmatched.length > 0 ? { unmatchedNote: `Saved channels not found in the bank: deleted, renamed, or hidden in the MixConsole. ${await hiddenChannelsNote()}` } : {}),
        ...(unmatched.length > 0 ? hiddenReport((await client.mixerState().catch(() => null))?.hidden) : {}),
      };
    },
    { destructive: true },
  );
}
