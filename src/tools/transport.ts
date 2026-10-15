import { z } from 'zod';
import { bool, defineTool, friendlyValue, normalized, sleep, type ToolContext } from './common.js';
import { TRANSPORT_TAGS, type TransportPosition, type ValueState } from '../cubase/client.js';
import { parseSwitch, parseTimeDisplay } from '../cubase/display.js';

type TransportAction =
  | { kind: 'value'; key: string; on: boolean }
  | { kind: 'stop' }
  | { kind: 'step'; direction: 1 | -1; key: string }
  | { kind: 'locate' }
  | { kind: 'locators' }
  | { kind: 'button'; tag: number; fallback: { category: string; name: string } }
  | { kind: 'switch'; tag: number; on: boolean }
  | { kind: 'command'; category: string; name: string };

const ACTIONS: Record<string, TransportAction> = {
  play: { kind: 'value', key: 'tr.start', on: true },
  stop: { kind: 'stop' },
  record: { kind: 'value', key: 'tr.record', on: true },
  stop_record: { kind: 'value', key: 'tr.record', on: false },
  rewind: { kind: 'step', direction: -1, key: 'tr.rewind' },
  forward: { kind: 'step', direction: 1, key: 'tr.forward' },
  locate: { kind: 'locate' },
  cycle_on: { kind: 'value', key: 'tr.cycle', on: true },
  cycle_off: { kind: 'value', key: 'tr.cycle', on: false },
  metronome_on: { kind: 'value', key: 'tr.metronome', on: true },
  metronome_off: { kind: 'value', key: 'tr.metronome', on: false },
  go_to_start: { kind: 'command', category: 'Transport', name: 'Return to Zero' },
  go_to_end: { kind: 'command', category: 'Transport', name: 'Goto End' },
  go_to_left_locator: { kind: 'command', category: 'Transport', name: 'To Left Locator' },
  go_to_right_locator: { kind: 'command', category: 'Transport', name: 'To Right Locator' },
  next_marker: { kind: 'command', category: 'Transport', name: 'Locate Next Marker' },
  previous_marker: { kind: 'command', category: 'Transport', name: 'Locate Previous Marker' },
  play_selection: { kind: 'command', category: 'Transport', name: 'Play Selection Range' },
  locators_to_selection: { kind: 'command', category: 'Transport', name: 'Locators to Selection' },
  return_to_start_position: { kind: 'command', category: 'Transport', name: 'Return to Start Position' },
  set_locators: { kind: 'locators' },
  step_bar: { kind: 'button', tag: TRANSPORT_TAGS.stepBar, fallback: { category: 'Transport', name: 'Step Bar' } },
  step_back_bar: { kind: 'button', tag: TRANSPORT_TAGS.stepBackBar, fallback: { category: 'Transport', name: 'Step Back Bar' } },
  nudge_forward: { kind: 'button', tag: TRANSPORT_TAGS.nudgeUp, fallback: { category: 'Transport', name: 'Nudge Cursor Right' } },
  nudge_back: { kind: 'button', tag: TRANSPORT_TAGS.nudgeDown, fallback: { category: 'Transport', name: 'Nudge Cursor Left' } },
  return_on_stop_on: { kind: 'switch', tag: TRANSPORT_TAGS.returnOnStop, on: true },
  return_on_stop_off: { kind: 'switch', tag: TRANSPORT_TAGS.returnOnStop, on: false },
};

const TEMPO_NOTE =
  'Not available: Cubase 13 exposes no tempo to MIDI Remote (the DirectAccess transport object has 101 parameters and none is the tempo). ' +
  'Read it in Cubase, or set it with the key command Transport / Input Tempo (it opens the tempo field).';

/** A time given in seconds or as Cubase shows it ("0:01:23.000"), or null when it is not one. */
function timeArg(value: number | string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : parseTimeDisplay(value);
}

/** How long forward/rewind hold their button when the cursor time cannot be read (Cubase winds while it is held). */
const HOLD_MS = 500;

/** Cursor and locators for a result: the text Cubase shows and seconds. */
export function describePosition(position: TransportPosition | null) {
  if (!position) return null;
  return {
    time: position.timeDisplay,
    seconds: position.time,
    ...(position.leftDisplay !== undefined ? { leftLocator: position.leftDisplay, rightLocator: position.rightDisplay } : {}),
  };
}

export function registerTransportTools(ctx: ToolContext): void {
  const { client } = ctx;

  /** extended: also returnOnStop and the time signature (two more DirectAccess reads), and the tempo note. */
  async function transportState(extended = false) {
    const values = (await client.call<{ values: Record<string, ValueState> }>('state.transport')).values;
    const position = await client.withSecondsTimeFormat(() => client.transportPosition());
    const state: Record<string, unknown> = {
      playing: bool(values['tr.start']),
      recording: bool(values['tr.record']),
      cycle: bool(values['tr.cycle']),
      metronome: bool(values['tr.metronome']),
      clickLevel: friendlyValue(values['tr.clickLevel']),
      position: describePosition(position),
    };
    if (extended) {
      const returnOnStop = await client.readTransportParam(TRANSPORT_TAGS.returnOnStop);
      const signature = await client.readTransportParam(TRANSPORT_TAGS.signature);
      Object.assign(state, {
        returnOnStop: returnOnStop && returnOnStop.value !== null ? returnOnStop.value > 0.5 : null,
        signature: signature?.display || null,
        tempo: null,
        tempoNote: TEMPO_NOTE,
      });
    }
    return state;
  }

  /** Holds a transport button (forward/rewind wind while held) and always releases it, twice if needed. */
  async function hold(key: string, ms: number) {
    await client.setValue(key, 1);
    try {
      await sleep(ms);
    } finally {
      // A release lost during a stall would leave Cubase winding: absolute writes are resent, and sent once more here.
      await client.setValue(key, 0).catch(() => undefined);
      await client.setValue(key, 0).catch(() => undefined);
    }
  }

  defineTool(
    ctx,
    'cubase_transport',
    `Controls the transport. Actions: ${Object.keys(ACTIONS).join(', ')}. ` +
      'Switches (play, record, cycle, metronome) wait until Cubase reports the new state, which can take a few seconds; applied is "unconfirmed" when it did not arrive in time ' +
      '(read cubase_get_transport_state later instead of sending the action again). stop waits until Cubase reports the transport stopped. ' +
      'forward and rewind move the cursor by `seconds` (default 5) through the transport time, also while playing (playback goes on from there); locate puts the cursor at `to` (seconds or "0:01:23.000"). ' +
      'set_locators sets the left and/or right cycle locator (`left`, `right`: seconds or "0:01:23.000") and reads them back (applied). ' +
      'step_bar / step_back_bar move the cursor to the next / previous bar, nudge_forward / nudge_back nudge it (by Cubase\'s nudge setting): through the DirectAccess transport buttons, and when the cursor did not move ' +
      'with the transport stopped, through the key command (via says which one moved it; moved false when neither did, e.g. at the project start). ' +
      'return_on_stop_on / return_on_stop_off set Cubase\'s "return to start position on stop" (read back: applied). ' +
      'The other actions are key commands, which Cubase does not confirm: every answer has the cursor (and locators) before and after, and moved says whether the cursor or the locators changed ' +
      '(e.g. next_marker without markers goes to the project end, play_selection without a selected range plays nothing). ' +
      'While cubase_measure_levels or cubase_gain_stage is playing, the action waits for the measurement to finish.',
    {
      action: z.enum(Object.keys(ACTIONS) as [string, ...string[]]),
      seconds: z.number().min(0.01).max(3600).optional().describe('forward/rewind: how far to move the cursor (default 5 s)'),
      to: z
        .union([z.number().min(0).max(86400), z.string().trim().min(1)])
        .optional()
        .describe('locate: where to put the cursor, in seconds or as Cubase shows the time ("0:01:23.000")'),
      left: z.union([z.number().min(0).max(86400), z.string().trim().min(1)]).optional().describe('set_locators: the left locator, in seconds or "0:01:23.000"'),
      right: z.union([z.number().min(0).max(86400), z.string().trim().min(1)]).optional().describe('set_locators: the right locator, in seconds or "0:01:23.000"'),
    },
    async ({ action, seconds, to, left, right }) =>
      client.measurement(async () => {
        const spec = ACTIONS[action];
        if (seconds !== undefined && spec.kind !== 'step') throw new Error('seconds only applies to forward and rewind');
        if (to !== undefined && spec.kind !== 'locate') throw new Error('to only applies to locate');
        if ((left !== undefined || right !== undefined) && spec.kind !== 'locators') throw new Error('left and right only apply to set_locators');
        if (spec.kind === 'locate' && to === undefined) throw new Error('locate needs "to" (seconds or "0:01:23.000")');
        if (spec.kind === 'locators') {
          if (left === undefined && right === undefined) throw new Error('set_locators needs left, right or both (seconds or "0:01:23.000")');
          const l = timeArg(left);
          const r = timeArg(right);
          if (l === null) throw new Error(`left "${left}" is not a time: give seconds or "H:MM:SS.mmm" (e.g. "0:01:23.000")`);
          if (r === null) throw new Error(`right "${right}" is not a time: give seconds or "H:MM:SS.mmm" (e.g. "0:01:23.000")`);
          if (l !== undefined && r !== undefined && r <= l) throw new Error('right must be after left');
          const set = await client.setLocators(l ?? null, r ?? null);
          const state = await transportState();
          return {
            action,
            requested: set.requested,
            applied: set.applied === null ? 'unconfirmed' : set.applied ? 'confirmed' : 'notApplied',
            before: describePosition(set.before),
            ...(set.applied === false ? { note: 'Cubase does not show the requested locators: it may have kept the left one before the right one. Check position and set them again.' } : {}),
            state,
          };
        }
        if (spec.kind === 'button') {
          const step = await client.transportStep(spec.tag, spec.fallback);
          return {
            action,
            via: step.via === 'command' ? `${spec.fallback.category} / ${spec.fallback.name}` : step.via,
            moved: step.moved,
            before: describePosition(step.before),
            ...(step.note ? { note: step.note } : {}),
            state: await transportState(),
          };
        }
        if (spec.kind === 'switch') {
          const result = await client.setTransportSwitch(spec.tag, spec.on);
          return { action, returnOnStop: result.state, applied: result.applied, state: await transportState() };
        }
        const before = await client.transportPosition(spec.kind === 'command');
        const out: Record<string, unknown> = { action };
        if (spec.kind === 'value') out.applied = (await client.setBool(spec.key, spec.on)).applied;
        else if (spec.kind === 'stop') out.applied = (await client.stopTransport()) ? 'confirmed' : 'unconfirmed';
        else if (spec.kind === 'locate' || spec.kind === 'step') {
          let target: number | null;
          if (spec.kind === 'locate') {
            target = typeof to === 'number' ? to : parseTimeDisplay(to);
            if (target === null) throw new Error(`"${to}" is not a time: give seconds or "H:MM:SS.mmm" (e.g. "0:01:23.000")`);
          } else {
            target = before?.time === null || before?.time === undefined ? null : Math.max(0, before.time + spec.direction * (seconds ?? 5));
          }
          if (target !== null) {
            const located = await client.locateTime(target);
            out.requested = located.requested;
            out.applied = located.applied === null ? 'unconfirmed' : located.applied ? 'confirmed' : 'notApplied';
          } else if (spec.kind === 'step') {
            // No time in seconds to step from: hold the button instead (Cubase winds while it is held).
            await hold(spec.key, HOLD_MS);
            out.held = `${HOLD_MS} ms`;
            out.note = 'The cursor time could not be read in seconds, so the button was held instead; check the position.';
          }
        } else {
          await client.runCommand(spec.category, spec.name);
          out.sent = true;
        }
        await sleep(100);
        const state = await transportState();
        const after = state.position as ReturnType<typeof describePosition>;
        if (before && after) {
          const moved =
            before.timeDisplay !== after.time ||
            (before.leftDisplay !== undefined && (before.leftDisplay !== after.leftLocator || before.rightDisplay !== after.rightLocator));
          Object.assign(out, { before: describePosition(before), moved });
        }
        return { ...out, state };
      }),
  );

  defineTool(
    ctx,
    'cubase_get_transport_state',
    'Returns play/record/cycle/metronome state, the cursor and cycle locators (position; null when DirectAccess does not give them), ' +
      'returnOnStop (Cubase\'s "return to start position on stop") and the time signature. The tempo is not available: Cubase 13 does not expose it to MIDI Remote (tempo is null, tempoNote says so).',
    {},
    () => transportState(true),
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_go_to_marker',
    'Moves the project cursor to marker 1-9, or activates cycle marker 1-9 (cycle: true). Cubase does nothing, and says nothing, for a marker the project does not have: ' +
      'the tool checks the cursor (and for cycle markers the locators) through the transport time and returns markerFound and the position. When nothing moved it steps the cursor (and the locators) 1 s away ' +
      'and tries again, to tell "already on the marker" from "no such marker", and puts them back when the marker is missing.',
    { number: z.number().int().min(1).max(9), cycle: z.boolean().default(false) },
    async ({ number, cycle }) =>
      client.measurement(async () => {
        const located = await client.locateMarker(cycle, number);
        return {
          command: located.command,
          markerFound: located.markerFound,
          verified: located.verified,
          moved: located.moved,
          before: describePosition(located.before),
          position: describePosition(located.position),
          ...(located.note ? { note: located.note } : {}),
        };
      }),
  );

  defineTool(
    ctx,
    'cubase_list_markers',
    'Lists the positions of the project\'s position markers. The API cannot read markers, so the tool puts the cursor at the project start and sends "Locate Next Marker" until the cursor stops moving, ' +
      'reading each stop through the DirectAccess transport time; "Goto End" then tells the project end (where Cubase stops after the last marker) from a marker. The cursor goes back where it was (cursorRestored). ' +
      'Marker names and IDs are not available through the API: number is the order in the project, which is not always the marker ID that cubase_go_to_marker uses. ' +
      'A marker at the very start (0:00:00.000) or exactly at the project end cannot be seen this way. Cycle markers also stop "Locate Next Marker": each one shows as two positions, its start and its end, ' +
      'and the list cannot tell them from position markers. The transport must be stopped. It takes about a second per marker.',
    { maxMarkers: z.number().int().min(1).max(200).default(100).describe('Stop after this many markers (complete: false then)') },
    async ({ maxMarkers }) =>
      client.measurement(async () => {
        const scan = await client.scanMarkers(maxMarkers);
        return {
          count: scan.markers.length,
          markers: scan.markers,
          projectEnd: scan.projectEnd,
          complete: scan.complete,
          cursorRestored: scan.cursorRestored,
          note: 'Positions only: Cubase does not give marker names or IDs to MIDI Remote. A marker at the project start or exactly at the project end is not listed.',
        };
      }),
  );

  defineTool(
    ctx,
    'cubase_control_room',
    'Reads or changes the Control Room main channel (needs Control Room enabled in Cubase Pro, Studio > Studio Setup): level, mute, dim, reference level, click. ' +
      'With Control Room disabled Cubase still exposes its objects, all empty: the call then fails, for reads and writes alike. ' +
      'Writes report what Cubase shows afterwards (switches: state and applied; levels: the value read back).',
    {
      level: normalized.optional(),
      mute: z.boolean().optional(),
      dim: z.boolean().optional(),
      referenceLevel: z.boolean().optional(),
      click: z.boolean().optional(),
      clickLevel: normalized.optional(),
    },
    async (args) => {
      type CrState = { available: boolean; values: Record<string, ValueState> };
      const state = await client.call<CrState>('state.controlRoom');
      if (!state.available) {
        throw new Error(
          'Control Room is disabled in Cubase (Studio > Studio Setup > Control Room) or not supported by this edition: its main channel values are empty, so nothing can be read or written.',
        );
      }
      const changes: Record<string, unknown> = {};
      if (args.level !== undefined) changes.level = await client.writeAndRead('cr.main.level', args.level);
      if (args.clickLevel !== undefined) changes.clickLevel = await client.writeAndRead('cr.main.clickLevel', args.clickLevel);
      const switches: Array<[boolean | undefined, string, string]> = [
        [args.mute, 'mute', 'cr.main.mute'],
        [args.dim, 'dim', 'cr.main.dim'],
        [args.referenceLevel, 'referenceLevel', 'cr.main.referenceLevelEnabled'],
        [args.click, 'click', 'cr.main.clickActive'],
      ];
      for (const [on, name, key] of switches) if (on !== undefined) changes[name] = await client.setBool(key, on);
      // A read-only call answers from the read above; after writes, read once more.
      const values = Object.keys(changes).length > 0 ? (await client.call<CrState>('state.controlRoom')).values : state.values;
      const read = Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          const isSwitch = parseSwitch(value.d) !== null || /(mute|dim|Enabled|Active|clickActive)$/.test(key);
          // A switch can read value null with a display ("Desact."): the display decides then.
          return [key, isSwitch ? (bool(value) ?? parseSwitch(value.d)) : friendlyValue(value)];
        }),
      );
      return { ...(Object.keys(changes).length > 0 ? { changes } : {}), values: read };
    },
  );
}
