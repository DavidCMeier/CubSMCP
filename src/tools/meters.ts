import { z } from 'zod';
import { channelRef, defineTool, sleep, type ToolContext } from './common.js';
import { meterToDb, parseDisplay } from '../cubase/display.js';
import type { ChannelKind, ChannelRef, ValueState } from '../cubase/client.js';

interface MeterReading {
  index: number;
  title: string;
  current: number | null;
  peakMax: number | null;
  /** RMS of the meter level over the time the transport played (bridge scripts from this version on). */
  rms?: number | null;
  playedMs?: number;
  samples: number;
  hostMax: number | null;
  hostMaxDisplay: string | null;
  clipped: boolean | null;
}

/** A meter reading of one channel, with what identifies it. */
interface ChannelReading {
  index: number;
  title: string;
  uid: string | null;
  /** 1-based bank page and position in MixConsole bank order (allPages only). */
  page?: number;
  position?: number;
  current: number | null;
  peakDb: number | null;
  averageDb: number | null;
  playedSeconds: number | null;
  samples: number;
  clipped: boolean | null;
}

const INPUT_GAIN_LIMIT = 48;

const MEASUREMENT_NOTE =
  'Peaks come from sampling the channel meters, so short transients can read up to ~1 dB low. ' +
  'Meters follow the MixConsole meter position (default post-fader). averageDb is the RMS of the meter level over the time the transport played ' +
  '(the meter has its own release, so it is a rough level indication, not the RMS of the audio); it is the same in cubase_get_meters. ' +
  'For exact peaks or loudness export stems and use audio_analyze_folder.';

const PAGE_NOTE =
  'Cubase only gives meters for the 48 slots of the bank page shown now: this measured that page only. Use allPages: true to play the section once per bank page and measure every channel.';

const STOP_WARNING = 'Cubase did not confirm that the transport stopped: check it (cubase_get_transport_state) and stop it with cubase_transport.';

/** Channel kinds gain staging leaves out by default: buses and outputs (a change there would add to the change on their sources). */
const BUS_KINDS: ChannelKind[] = ['group', 'fx', 'vca', 'output', 'input'];
const KIND_NAMES = ['audio', 'instrument', 'sampler', 'midi', 'group', 'fx', 'vca', 'output', 'input', 'unknown'] as const;
/** Without channel types (an older bridge script), outputs are recognized by these exact names. */
const OUTPUT_NAMES = /^(stereo out|main|main out|master)$/i;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function registerMeterTools(ctx: ToolContext): void {
  const { client } = ctx;
  /** First uid of the bank page whose channels the meter statistics belong to (they are kept per slot). */
  let meterPageUid: string | null | undefined;

  async function readMeters(): Promise<Array<Omit<ChannelReading, 'uid'>>> {
    const { channels } = await client.call<{ channels: MeterReading[] }>('meters.get');
    // hostMax / hostMaxDisplay (mVUMeterMax) are not usable in Cubase 13: "-oo" on channels with signal
    // and "127" or "0" on instrument and disabled channels, so the peak comes from the sampled meter.
    return channels.map((c) => ({
      index: c.index,
      title: c.title,
      current: c.current,
      peakDb: meterToDb(c.peakMax),
      averageDb: c.rms === undefined ? null : meterToDb(c.rms),
      playedSeconds: c.playedMs === undefined ? null : round1(c.playedMs / 1000),
      samples: c.samples,
      clipped: c.clipped,
    }));
  }

  async function firstPageUid(): Promise<string | null> {
    const { slots } = await client.pageChannels();
    return slots.find((s) => s.index === 0)?.uid ?? null;
  }

  async function resetMeters() {
    await client.call('meters.reset');
    await client.runCommand('Mixer', 'Meters: Reset').catch(() => undefined);
  }

  /**
   * Places the cursor where the section starts and returns that time (seconds; null when DirectAccess does not
   * give it). A marker that does not exist fails before anything plays.
   */
  async function positionSection(options: { seconds: number; fromMarker?: number; fromCycleMarker?: number }) {
    const warnings: string[] = [];
    let start: number | null = null;
    const section: Record<string, unknown> = {};
    if (options.fromCycleMarker) {
      const n = options.fromCycleMarker;
      const located = await client.locateMarker(true, n);
      if (located.markerFound === false) throw new Error(`Cycle marker ${n} was not found: ${located.note} Nothing was played.`);
      if (located.markerFound !== true) warnings.push(`Cycle marker ${n} could not be checked: ${located.note}`);
      const { time, left, right, leftDisplay, rightDisplay } = located.position ?? {};
      const before = located.before;
      const locatorsChanged = before !== null && (before.left !== left || before.right !== right);
      // The locators show the marker when they changed, when everything was already on it, or when the cursor sits on the left one.
      const locatorsOnMarker =
        locatorsChanged || located.moved === false || (time !== null && time !== undefined && left !== null && left !== undefined && Math.abs(time - left) < 0.011);
      if (located.markerFound === true && !locatorsOnMarker && time !== null && time !== undefined) {
        // Only the cursor moved: the section starts there and its end is not known.
        start = time;
        Object.assign(section, { cycleMarker: n, from: located.position?.timeDisplay ?? null });
        warnings.push(`Cycle marker ${n} moved the cursor but not the locators: the section starts at the cursor and lasts \`seconds\`.`);
      } else if (left !== null && left !== undefined) {
        // The command may only set the locators: the section starts at the left one.
        const at = await client.locateTime(left);
        if (at.applied === false) warnings.push(`The cursor did not go to the left locator (${leftDisplay}): it shows ${at.position?.timeDisplay ?? 'nothing'}.`);
        start = left;
        Object.assign(section, { cycleMarker: n, from: leftDisplay, to: rightDisplay });
        if (right !== null && right !== undefined && options.seconds > right - left + 0.05) {
          warnings.push(
            `seconds (${options.seconds}) is longer than cycle marker ${n} (${round1(right - left)} s): with cycle on Cubase plays the range again, with cycle off it plays past it.`,
          );
        }
      } else {
        await client.runCommand('Transport', 'To Left Locator');
        warnings.push('The locators could not be read, so the cursor was sent to the left locator without checking it.');
      }
    }
    if (options.fromMarker) {
      const n = options.fromMarker;
      const located = await client.locateMarker(false, n);
      if (located.markerFound === false) throw new Error(`Marker ${n} was not found: ${located.note} Nothing was played.`);
      if (located.markerFound !== true) warnings.push(`Marker ${n} could not be checked: ${located.note}`);
      start = located.position?.time ?? null;
      Object.assign(section, { marker: n, from: located.position?.timeDisplay ?? null });
    }
    if (!options.fromMarker && !options.fromCycleMarker) {
      const position = await client.transportPosition(false);
      start = position?.time ?? null;
      section.from = position?.timeDisplay ?? null;
    }
    section.seconds = options.seconds;
    if (start === null) warnings.push('The start position could not be read (DirectAccess transport time), so it was not checked.');
    return { start, section, warnings };
  }

  /** One playback: optionally locate, reset the statistics, play, read the meters before stopping, and always stop. */
  async function measurePass(seconds: number, locateTo: number | null, warnings: string[]) {
    if (locateTo !== null) {
      const at = await client.locateTime(locateTo);
      if (at.applied === false) warnings.push(`The cursor did not go back to the start of the section (it shows ${at.position?.timeDisplay ?? 'nothing'}).`);
    }
    await resetMeters();
    let readings: Awaited<ReturnType<typeof readMeters>>;
    let stopped = false;
    try {
      await client.setBool('tr.start', true);
      await sleep(seconds * 1000);
      // Read while playing: after the stop the meters fall.
      readings = await readMeters();
    } finally {
      stopped = await client.stopTransport();
    }
    return { readings, stopped };
  }

  interface PageMeasurement {
    /** 0-based bank page, null for "the page shown now". */
    page: number | null;
    readings: ChannelReading[];
  }

  /**
   * Measures the page shown now, or every bank page (one playback each, from the same start), calling `after`
   * on each page while the bank still shows it. pagesWith: skip the pages without any of these uids.
   */
  async function measurePages(options: {
    seconds: number;
    start: number | null;
    allPages: boolean;
    pagesWith?: Set<string> | null;
    warnings: string[];
    after?: (page: PageMeasurement) => Promise<void>;
  }) {
    let passes = 0;
    let stopped = true;
    let bankRestored: boolean | undefined;
    const measured: PageMeasurement[] = [];
    const here = async (page: number | null): Promise<boolean> => {
      const { size, slots } = await client.pageChannels();
      if (options.pagesWith && !slots.some((s) => s.uid !== null && options.pagesWith?.has(s.uid))) return false;
      const uids = new Map(slots.map((s) => [s.index, s.uid]));
      const pass = await measurePass(options.seconds, passes > 0 ? options.start : null, options.warnings);
      passes++;
      meterPageUid = uids.get(0) ?? null;
      const result: PageMeasurement = {
        page,
        readings: pass.readings.map((r) => ({
          ...r,
          uid: uids.get(r.index) ?? null,
          ...(page !== null ? { page: page + 1, position: page * size + r.index } : {}),
        })),
      };
      measured.push(result);
      if (!pass.stopped) {
        stopped = false;
        return true; // Do not play the next page with the transport in an unknown state.
      }
      if (options.after) await options.after(result);
      return false;
    };
    if (!options.allPages) await here(null);
    else {
      const visit = await client.forEachBankPage(async (page) => (await here(page)) || undefined);
      bankRestored = visit.bankRestored;
    }
    return { measured, passes, stopped, bankRestored };
  }

  defineTool(
    ctx,
    'cubase_reset_meters',
    'Resets the peak/average statistics the bridge collects from the channel meters (and Cubase meter peaks). Waits while a measurement (cubase_measure_levels, cubase_gain_stage) is running.',
    {},
    async () =>
      client.measurement(async () => {
        await resetMeters();
        meterPageUid = await firstPageUid().catch(() => null);
        return { reset: true };
      }),
  );

  defineTool(
    ctx,
    'cubase_get_meters',
    'Returns meter statistics per channel of the bank page shown now since the last reset: kind (audio, instrument, group, fx, vca, output...; from DirectAccess, absent without it), ' +
      'current level (normalized), peakDb, averageDb (RMS of the meter level over the time the transport played) and clip state. ' +
      'Cubase only gives meters for the 48 slots of the page shown now, and the statistics belong to the slots: after the bank moved they mix channels (bankMoved warns about it). ' +
      'channels limits the answer to some channels of that page (bank index or name; a name not on the page is an error, the bank does not move); ' +
      'onlyWithSignal leaves out the channels whose meter showed nothing since the reset (peakDb null). total says how many channels the page has.',
    {
      channels: z
        .array(channelRef)
        .min(1)
        .max(48)
        .optional()
        .describe('Only these channels, by bank index or name, on the bank page shown now'),
      onlyWithSignal: z.boolean().default(false).describe('Leave out channels without signal since the last reset'),
    },
    async ({ channels: refs, onlyWithSignal }) => {
      // Names are resolved on the page shown now: the meters only exist there.
      let wanted: Set<number> | null = null;
      if (refs) {
        wanted = new Set();
        for (const ref of refs) {
          try {
            wanted.add((await client.resolveOnCurrentPage(ref as ChannelRef)).index);
          } catch (error) {
            throw new Error(`channels: ${(error as Error).message} Meters only exist for the bank page shown now: show the channel's page with cubase_bank first.`);
          }
        }
      }
      const all = await readMeters();
      const channels = all.filter((c) => (!wanted || wanted.has(c.index)) && (!onlyWithSignal || c.peakDb !== null));
      const page = await client.pageChannels().catch(() => null);
      const uid = page ? (page.slots.find((s) => s.index === 0)?.uid ?? null) : null;
      // Kinds are cached per channel: DirectAccess is asked only for channels not seen before.
      const kinds = page ? await client.channelKinds(page.slots).catch(() => null) : null;
      const bankMoved = meterPageUid !== undefined && uid !== meterPageUid;
      return {
        total: all.length,
        ...(refs || onlyWithSignal ? { returned: channels.length } : {}),
        channels: channels.map((c) => ({
          index: c.index,
          name: c.title,
          ...(kinds?.get(c.index) ? { kind: kinds.get(c.index) } : {}),
          current: c.current,
          peakDb: c.peakDb,
          averageDb: c.averageDb,
          playedSeconds: c.playedSeconds,
          clipped: c.clipped,
        })),
        ...(bankMoved
          ? { bankMoved: true, warning: 'The bank shows another page than when the meters were last reset or measured: the statistics of each slot can belong to the channel it showed before. Reset and measure again.' }
          : {}),
        note: MEASUREMENT_NOTE,
      };
    },
    { readOnly: true },
  );

  const markerOptions = {
    fromMarker: z.number().int().min(1).max(9).optional().describe('Locate to this marker before playing (fails before playing when the project has no such marker)'),
    fromCycleMarker: z
      .number()
      .int()
      .min(1)
      .max(9)
      .optional()
      .describe('Activate this cycle marker and start at its left locator (fails before playing when it is not found)'),
  };

  defineTool(
    ctx,
    'cubase_measure_levels',
    'Plays the project for a number of seconds and returns the peak level each channel reached (post-fader meters) and its average. ' +
      'By default it measures the channels of the bank page shown now (48 slots): allPages: true plays the section once per bank page from the same start and measures every channel (it takes seconds x pages). ' +
      'Use a cycle marker or a marker to choose the section (e.g. the loudest chorus): the tool checks with the transport time that the cursor or the locators moved and fails before playing when the marker does not exist. ' +
      'Cubase may put the cursor back where playback started when it stops (its "return to start position on stop" setting). ' +
      'Measurements run one at a time: a call made while another one (or cubase_gain_stage, cubase_reset_meters, cubase_transport) runs waits for it to finish.',
    {
      seconds: z.number().min(1).max(600).default(20),
      ...markerOptions,
      allPages: z.boolean().default(false).describe('Measure every bank page, one playback per page'),
    },
    async ({ seconds, fromMarker, fromCycleMarker, allPages }) =>
      client.measurement(async () => {
        const { start, section, warnings } = await positionSection({ seconds, fromMarker, fromCycleMarker });
        const run = await measurePages({ seconds, start, allPages, warnings });
        const readings = run.measured.flatMap((page) => page.readings);
        return {
          seconds,
          section,
          pagesMeasured: run.passes,
          channelsOnPages: readings.length,
          channels: readings
            .filter((c) => c.samples > 0 || c.peakDb !== null)
            .map((c) => ({
              index: c.index,
              name: c.title,
              ...(c.page !== undefined ? { page: c.page, position: c.position } : {}),
              peakDb: c.peakDb,
              averageDb: c.averageDb,
              clipped: c.clipped,
            })),
          ...(allPages ? (run.bankRestored === false ? { bankWarning: 'The bank could not go back to the page it showed before.' } : {}) : { pageNote: PAGE_NOTE }),
          note: MEASUREMENT_NOTE,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(run.stopped ? {} : { warning: STOP_WARNING }),
        };
      }),
  );

  defineTool(
    ctx,
    'cubase_gain_stage',
    'Gain staging: plays a section, measures each channel peak and computes the input-gain change needed to reach a target peak. Dry run by default; set apply=true to write the input gains. ' +
      'Meters are post-fader, so by default the fader level is taken out of the peak (compensateFader; faderDb and preFaderPeakDb in each step). Channels below minPeakDb before the fader are skipped as "signal too low" instead of getting the maximum change, and a change cut at maxChangeDb is marked capped. ' +
      'Group, FX, VCA, output and input channels are left out by type (excludeKinds; types come from DirectAccess, so they need the bridge script of this version: without it outputs are left out by name and a warning says so). excludeNames leaves out channels by exact name (case-insensitive). excluded lists what was left out and why. ' +
      'channels are resolved before anything plays. Without allPages it measures the bank page shown now (48 slots) and the names must be on it; with allPages it plays the section once per bank page that has a channel to measure and writes each gain while the bank shows its page, after checking the slot still shows the same channel (uid). ' +
      'It reads only the gains and faders of the planned channels and always returns the plan: a channel whose values cannot be read is skipped, and with apply a failed write stops the remaining ones (each step says applied, error or notApplied). ' +
      'New gains stay within Cubase\'s -48..+48 dB (limitedTo says when the plan was cut); applied is false with notReached when Cubase did not reach the planned gain. ' +
      'The section: see cubase_measure_levels (fromMarker, fromCycleMarker fail before playing when the marker does not exist). Measurements run one at a time: concurrent calls wait for each other.',
    {
      targetPeakDb: z.number().min(-40).max(0).default(-10),
      seconds: z.number().min(2).max(300).default(20),
      ...markerOptions,
      channels: z
        .array(channelRef)
        .optional()
        .describe('Limit to these channels, by bank index or name (default: every channel with signal that is not excluded); without allPages they must be on the bank page shown now'),
      allPages: z.boolean().default(false).describe('Measure every bank page that has a channel to plan (one playback per page)'),
      excludeKinds: z
        .array(z.enum(KIND_NAMES))
        .default(BUS_KINDS)
        .describe('Channel types to leave out (default: group, fx, vca, output, input)'),
      excludeNames: z.array(z.string().trim().min(1)).default([]).describe('Exact channel names to leave out (case-insensitive); blank names are rejected'),
      compensateFader: z.boolean().default(true).describe('Take the fader level out of the post-fader peak (turn off when the meters are set to Input or pre-fader)'),
      minPeakDb: z.number().min(-120).max(0).default(-60).describe('Below this peak (before the fader) a channel is skipped as "signal too low"'),
      maxChangeDb: z.number().min(1).max(36).default(18),
      apply: z.boolean().default(false),
    },
    async ({ targetPeakDb, seconds, fromMarker, fromCycleMarker, channels, allPages, excludeKinds, excludeNames, compensateFader, minPeakDb, maxChangeDb, apply }) =>
      client.measurement(async () => {
        // 1. Which channels, before anything plays (a wrong name fails now, not after the playback).
        let wantedUids: Set<string> | null = null;
        let wantedIndexes: Set<number> | null = null;
        if (channels && channels.length > 0) {
          wantedUids = new Set();
          if (!allPages) {
            wantedIndexes = new Set();
            for (const ref of channels) {
              const channel = await client.resolveOnCurrentPage(ref as ChannelRef);
              wantedIndexes.add(channel.index);
              if (channel.uid) wantedUids.add(channel.uid);
            }
          } else {
            const { results } = await client.withChannels(channels as ChannelRef[], async (channel) => channel);
            results.forEach((result, i) => {
              if ('error' in result) throw new Error(`Channel ${JSON.stringify(channels[i])}: ${result.error}`);
              if (!result.uid) throw new Error(`Channel ${JSON.stringify(channels[i])} has no unique id (update the bridge script): allPages needs it to find the channel on its page`);
              wantedUids?.add(result.uid);
            });
          }
        }
        // Without allPages the bank does not move (the measurement holds it): the indexes found before playing still apply.
        const isWanted = (r: ChannelReading) => !wantedUids || (wantedIndexes ? wantedIndexes.has(r.index) : r.uid !== null && wantedUids.has(r.uid));
        const excludedNames = new Set(excludeNames.map((n) => n.toLowerCase()));

        // 2. The section.
        const { start, section, warnings } = await positionSection({ seconds, fromMarker, fromCycleMarker });

        // 3. Measure, plan and (with apply) write page by page, while the bank shows the page.
        const plan: Array<Record<string, unknown>> = [];
        const excluded: Array<Record<string, unknown>> = [];
        let considered = 0;
        let stoppedAt: string | null = null;
        let typesMissing = false;
        const planPage = async ({ page, readings }: PageMeasurement) => {
          const kinds = await client.mixerChannels().catch(() => null);
          if (!kinds) typesMissing = true;
          const selection: Array<ChannelReading & { kind?: ChannelKind }> = [];
          for (const reading of readings) {
            if (!isWanted(reading)) continue;
            considered++;
            const kind = kinds?.get(reading.index)?.kind;
            const who = { channel: reading.title, index: reading.index, ...(reading.page !== undefined ? { page: reading.page } : {}) };
            if (kind && excludeKinds.includes(kind)) excluded.push({ ...who, kind, reason: `${kind} channel` });
            else if (!kinds && !wantedUids && OUTPUT_NAMES.test(reading.title.trim())) excluded.push({ ...who, reason: 'output (by name: channel types unavailable)' });
            else if (excludedNames.has(reading.title.trim().toLowerCase())) excluded.push({ ...who, ...(kind ? { kind } : {}), reason: 'excludeNames' });
            else selection.push({ ...reading, ...(kind ? { kind } : {}) });
          }

          // Only the gains and faders of the channels with signal: small reads (the bridge resends them after a stall).
          const measured = selection.filter((r) => r.peakDb !== null);
          let gains: Record<string, ValueState> = {};
          let faders: Record<string, ValueState> = {};
          let readError: string | null = null;
          try {
            if (measured.length > 0) {
              gains = await client.readValues(measured.map((r) => `ch.${r.index}.pre.gain`));
              if (compensateFader) faders = await client.readValues(measured.map((r) => `ch.${r.index}.volume`));
            }
          } catch (error) {
            readError = error instanceof Error ? error.message : String(error);
          }
          const steps = selection.map((reading): Record<string, unknown> => {
            const step: Record<string, unknown> = {
              channel: reading.title,
              index: reading.index,
              ...(reading.uid ? { uid: reading.uid } : {}),
              ...(reading.page !== undefined ? { page: reading.page } : {}),
              ...(reading.kind ? { kind: reading.kind } : {}),
            };
            if (reading.peakDb === null) return { ...step, skipped: 'no signal' };
            step.measuredPeakDb = reading.peakDb;
            let peak = reading.peakDb;
            if (compensateFader) {
              const fader = faders[`ch.${reading.index}.volume`];
              const faderDb = parseDisplay(fader?.d, fader?.u)?.value;
              if (faderDb === undefined || Number.isNaN(faderDb)) return { ...step, skipped: `fader could not be read${readError ? ` (${readError})` : ''}` };
              if (faderDb === Number.NEGATIVE_INFINITY) return { ...step, faderDb: '-oo', skipped: 'fader at -oo' };
              step.faderDb = faderDb;
              peak = round1(reading.peakDb - faderDb);
              step.preFaderPeakDb = peak;
            }
            if (peak < minPeakDb) return { ...step, skipped: `signal too low (${peak} dBFS${compensateFader ? ' before the fader' : ''}, below minPeakDb ${minPeakDb})` };
            const state = gains[`ch.${reading.index}.pre.gain`];
            const currentGain = parseDisplay(state?.d, state?.u)?.value;
            if (currentGain === undefined || !Number.isFinite(currentGain)) {
              return { ...step, skipped: `input gain could not be read${readError ? ` (${readError})` : ''}` };
            }
            const raw = targetPeakDb - peak;
            const wanted = Math.max(-maxChangeDb, Math.min(maxChangeDb, raw));
            // Cubase's input gain goes from -48 to +48 dB.
            const newGain = Math.max(-INPUT_GAIN_LIMIT, Math.min(INPUT_GAIN_LIMIT, currentGain + wanted));
            const capped = Math.abs(raw) > maxChangeDb + 0.05;
            if (capped) warnings.push(`${reading.title}: the change was capped at ${raw > 0 ? '+' : '-'}${maxChangeDb} dB (it needed ${raw > 0 ? '+' : ''}${round1(raw)} dB).`);
            return {
              ...step,
              currentInputGainDb: currentGain,
              changeDb: round1(newGain - currentGain),
              newInputGainDb: round1(newGain),
              ...(capped ? { capped: true, neededChangeDb: round1(raw) } : {}),
              ...(newGain !== currentGain + wanted ? { limitedTo: newGain > 0 ? '+48 dB' : '-48 dB' } : {}),
            };
          });
          plan.push(...steps);
          if (!apply) return;

          // The bank still shows the page that was measured: check each slot by uid before writing.
          const slotUids = new Map((await client.pageChannels().catch(() => ({ slots: [] }))).slots.map((s) => [s.index, s.uid]));
          for (const step of steps) {
            if (step.newInputGainDb === undefined || Math.abs(step.changeDb as number) < 0.3) continue;
            if (stoppedAt) {
              step.notApplied = `stopped after the error on "${stoppedAt}"`;
              continue;
            }
            if (step.uid && slotUids.get(step.index as number) !== step.uid) {
              step.applied = false;
              step.notApplied = `bank slot ${step.index} no longer shows this channel (the bank moved): nothing written`;
              continue;
            }
            const key = `ch.${step.index}.pre.gain`;
            try {
              const result = await client.seekDisplay(key, step.newInputGainDb as number);
              step.applied = result.withinTolerance;
              step.appliedInputGainDb = result.achieved;
              if (!result.withinTolerance) step.notReached = `wanted ${step.newInputGainDb} dB, Cubase shows ${result.display ?? 'no value'}`;
            } catch (error) {
              step.applied = false;
              step.error = error instanceof Error ? error.message : String(error);
              // What Cubase has now (the search may have left an intermediate value or put the old one back).
              const now = await client.getValue(key).catch(() => null);
              const value = now ? parseDisplay(now.d, now.u)?.value : undefined;
              step.inputGainNowDb = value !== undefined && Number.isFinite(value) ? value : null;
              // Cubase is stalling: stop instead of piling more writes on it.
              stoppedAt = step.channel as string;
            }
          }
        };
        const run = await measurePages({ seconds, start, allPages, pagesWith: allPages ? wantedUids : null, warnings, after: planPage });
        if (typesMissing) {
          warnings.push(
            'Channel types were not available (reload the bridge script of this version, with DirectAccess on): groups and FX channels were not left out, only outputs by name. Pass channels with the sources only.',
          );
        }

        const planned = plan.filter((step) => step.newInputGainDb !== undefined).length;
        const channelsSeen = run.measured.reduce((n, page) => n + page.readings.length, 0);
        let message: string | undefined;
        if (planned === 0) {
          if (channelsSeen === 0) message = 'meters.get returned no channels: the bank page shows none.';
          else if (considered === 0) message = 'None of the given channels was on the measured page(s).';
          else if (plan.length === 0) message = 'Every channel was left out by excludeKinds or excludeNames (see excluded).';
          else message = 'No channel had enough signal in the measured section (see skipped in the plan).';
        }
        return {
          targetPeakDb,
          applied: apply && !stoppedAt && planned > 0 && plan.every((step) => step.applied !== false),
          section,
          pagesMeasured: run.passes,
          plan,
          ...(excluded.length > 0 ? { excluded } : {}),
          ...(message ? { message } : {}),
          ...(allPages ? (run.bankRestored === false ? { bankWarning: 'The bank could not go back to the page it showed before.' } : {}) : { pageNote: PAGE_NOTE }),
          note: MEASUREMENT_NOTE,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(stoppedAt ? { warning: `Writing the input gain of "${stoppedAt}" failed, so the remaining changes were not applied. Check the values and run it again.` } : {}),
          ...(run.stopped ? {} : { transportWarning: STOP_WARNING }),
        };
      }),
  );
}
