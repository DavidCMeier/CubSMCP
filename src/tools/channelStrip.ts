import { z } from 'zod';
import {
  bool,
  channelIdentity,
  channelRef,
  defineTool,
  describeChannelValues,
  friendlyValue,
  normalized,
  onlyOne,
  optionalChannelRef,
  requireAny,
  SELECTION_NOTE,
  selectionOptions,
  sleep,
  slotScope,
  stripModule,
  SWITCH_LAG_NOTE,
  withSelection,
  type SelectedChannel,
  type ToolContext,
} from './common.js';
import {
  isSelectionStale,
  staleSelectionMessage,
  type BoolResult,
  type ChannelRef,
  type PluginPresence,
  type SelectedInfo,
  type SelectionSideEffects,
  type ValueState,
} from '../cubase/client.js';
import { parseDisplay } from '../cubase/display.js';

/** The selected-track state plus, when a channel was given, what identifies the channel that got selected. */
type Focused = SelectedInfo & { focused?: SelectedChannel['identity']; sideEffects?: SelectionSideEffects };

const STRIP_MODULES = ['gate', 'compressor', 'tools', 'saturator', 'limiter'] as const;

/** Parts of cubase_get_channel_strip that can be asked for alone. */
const STRIP_SECTIONS = ['channel', 'pre', 'eq', 'strip', 'inserts', 'sends', 'quickControls'] as const;
type StripSection = (typeof STRIP_SECTIONS)[number];

/** Slope of the Pre filter in dB/Oct and its normalized value: 0, 0.25, 0.5, 0.75, 1. */
const SLOPES_DB = [6, 12, 24, 36, 48] as const;
const slopeDb = z
  .union([z.literal(6), z.literal(12), z.literal(24), z.literal(36), z.literal(48)])
  .describe('Slope in dB/Oct: 6, 12, 24, 36 or 48 (36 is not checked on a live Cubase yet)');

/**
 * Filter types of Cubase 13's Channel EQ per band, in the order of their normalized steps (type k of n is
 * k/(n-1)). All eight steps of bands 1 and 4 and both of bands 2 and 3 were read live on 15 Oct 2026.
 * Every write is still checked against what Cubase shows, and put back when it differs.
 */
export const EQ_TYPES: Record<number, readonly string[]> = {
  1: ['Parametric I', 'Low Shelf I', 'High Pass I', 'High Pass II', 'Parametric II', 'Low Shelf II', 'Low Shelf III', 'Low Shelf IV'],
  2: ['Parametric I', 'Parametric II'],
  3: ['Parametric I', 'Parametric II'],
  4: ['Parametric I', 'High Shelf I', 'Low Pass I', 'Low Pass II', 'Parametric II', 'High Shelf II', 'High Shelf III', 'High Shelf IV'],
};

const ROMAN: Record<string, string> = { '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv' };

/** An EQ type name in a comparable form: lower case, single spaces, "2" as "ii", "highpass" as "high pass". */
export function normalizeEqType(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/(high|low)(pass|shelf)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/ ([1-4])$/, (_, d: string) => ` ${ROMAN[d]}`);
}

/** Step of an EQ type name on a band, or an error listing the names the band has. */
export function eqTypeStep(band: number, name: string): { index: number; normalized: number; name: string } {
  const types = EQ_TYPES[band];
  const index = types.findIndex((t) => normalizeEqType(t) === normalizeEqType(name));
  if (index < 0) throw new Error(`Band ${band} has no EQ type "${name}". Its types: ${types.join(', ')}.`);
  return { index, normalized: index / (types.length - 1), name: types[index] };
}

const MISSING_NOTE =
  'missing: Cubase names a plugin in the slot but has no plugin object for it (not installed or failed to load): its parameters cannot be read or written, ' +
  'and the vendor is left out because Cubase reports its own for these placeholders.';

/** A plugin slot (insert, strip module, instrument) in the same shape for every tool. */
function describeSlot(slot: string, selected: Focused, presence?: PluginPresence) {
  const v = selected.values;
  const name = presence?.name ?? selected.plugins[slot]?.name ?? '';
  const missing = presence?.missing === true;
  return {
    plugin: name || null,
    ...(name ? {} : { empty: true as const }),
    // Cubase reports "Steinberg Media Technologies" for a plugin that is not installed: not shown then.
    ...(missing ? { missing: true as const } : { vendor: (presence?.vendor ?? selected.plugins[slot]?.vendor) || null }),
    on: bool(v[`${slot}.on`]),
    bypass: bool(v[`${slot}.bypass`]),
    editorOpen: bool(v[`${slot}.edit`]),
  };
}

/**
 * Inserts (slots 1-16, only loaded ones unless includeEmpty), strip modules and instrument (null when the
 * track has none) of the selected track, with a note when a plugin is missing.
 */
export function describePlugins(selected: Focused, presence: PluginPresence[] | null, includeEmpty = false) {
  const bySlot = new Map((presence ?? []).map((p) => [p.slot, p]));
  const inserts = [];
  for (let s = 0; s < 16; s++) {
    const slot = `sel.ins.${s}`;
    if (!(`${slot}.on` in selected.values) && !bySlot.has(slot)) continue;
    const info = describeSlot(slot, selected, bySlot.get(slot));
    if (info.plugin || includeEmpty) inserts.push({ slot: s + 1, ...info });
  }
  const strip = Object.fromEntries(STRIP_MODULES.map((m) => [m, describeSlot(`sel.strip.${m}`, selected, bySlot.get(`sel.strip.${m}`))]));
  const instrumentInfo = describeSlot('sel.inst', selected, bySlot.get('sel.inst'));
  const instrument = instrumentInfo.plugin ? instrumentInfo : null;
  const anyMissing = [...inserts, ...Object.values(strip), ...(instrument ? [instrument] : [])].some((p) => 'missing' in p && p.missing);
  return { inserts, strip, instrument, ...(anyMissing ? { missingNote: MISSING_NOTE } : {}) };
}

export function registerChannelStripTools(ctx: ToolContext): void {
  const { client } = ctx;

  /**
   * Selects the channel when given and runs work on the selected-track state; without a channel, a
   * selection that points at no mixer channel is an error. restoreSelection puts the old selection back after.
   */
  async function withFocus<T>(
    args: { channel?: ChannelRef; disarm?: boolean; restoreSelection?: boolean },
    work: (selected: Focused) => Promise<T>,
  ): Promise<T> {
    return withSelection(client, args.channel, args, async (selection) => {
      const selected: Focused = await client.selected();
      if (selection) {
        selected.focused = selection.identity;
        selected.sideEffects = selection.sideEffects;
      } else if (isSelectionStale(selected)) {
        throw new Error(staleSelectionMessage(selected));
      }
      return work(selected);
    });
  }

  /** Result header: the track the selection points at and, when a channel was given, which channel that is and what selecting it did. */
  function header(selected: Focused): Record<string, unknown> {
    return {
      track: selected.title,
      ...(selected.focused ? { channel: selected.focused } : {}),
      ...(selected.sideEffects ? { sideEffects: selected.sideEffects } : {}),
    };
  }

  /**
   * Writes an EQ type by its step and checks the name Cubase shows (read once more after settleMs when it
   * does not show yet). A different name puts the old type back: the table is wrong for this Cubase.
   */
  async function writeEqType(key: string, band: number, step: { index: number; normalized: number; name: string }) {
    const before = await client.getValue(key);
    let state: ValueState = await client.writeAndRead(key, step.normalized);
    const shows = (s: ValueState) => s.d !== null && normalizeEqType(s.d) === normalizeEqType(step.name);
    if (!shows(state)) {
      await sleep(Math.max(ctx.config.settleMs, 50));
      state = await client.getValue(key);
    }
    if (!shows(state)) {
      if (before.v !== null) await client.writeAndRead(key, before.v).catch(() => undefined);
      throw new Error(
        `Cubase shows "${state.d}" at step ${step.index} of band ${band}, not "${step.name}": the type table does not match this Cubase, so the type was put back to "${before.d}". ` +
          'Use typeNormalized and read the display to choose.',
      );
    }
    return { name: step.name, display: state.d, normalized: state.v, previous: before.d, applied: true, changed: before.d !== state.d };
  }

  /** Plugin slots with empty/missing flags (null with bridge scripts that do not report them). */
  async function pluginPresence(): Promise<PluginPresence[] | null> {
    const result = await client.call<{ plugins: PluginPresence[] }>('plugins.selected').catch(() => null);
    return result && result.plugins.some((p) => 'empty' in p) ? result.plugins : null;
  }

  /** The whole strip, or only some sections of it (the header, track and channel, always comes). */
  async function describeStrip(selected: Focused, sections?: StripSection[]) {
    const full = await describeWholeStrip(selected, sections);
    if (!sections) return full;
    const { inserts, strip, instrument, missingNote, preFilter, eq, quickControls, sends, color, ...rest } = full as Record<string, unknown>;
    const channel = Object.fromEntries(Object.entries(rest).filter(([k]) => !(k in header(selected))));
    const parts: Record<StripSection, Record<string, unknown>> = {
      channel: { color, ...channel },
      pre: { preFilter },
      eq: { eq },
      strip: { strip },
      inserts: { inserts, instrument, ...(missingNote ? { missingNote } : {}) },
      sends: { sends },
      quickControls: { quickControls },
    };
    return { ...header(selected), sections, ...Object.assign({}, ...sections.map((section) => parts[section])) };
  }

  async function describeWholeStrip(selected: Focused, sections?: StripSection[]) {
    const v = selected.values;
    const eq = [1, 2, 3, 4].map((band) => ({
      band,
      on: bool(v[`sel.eq.${band}.on`]),
      gain: friendlyValue(v[`sel.eq.${band}.gain`]),
      frequency: friendlyValue(v[`sel.eq.${band}.freq`]),
      q: friendlyValue(v[`sel.eq.${band}.q`]),
      type: friendlyValue(v[`sel.eq.${band}.type`]),
    }));
    const quickControls = [];
    for (let q = 0; q < 8; q++) {
      const state = v[`sel.qc.${q}`];
      // n is the parameter the quick control is assigned to; t its owner (the plugin or channel). Unassigned, Cubase shows no display.
      if (state) quickControls.push({ index: q + 1, title: state.n || state.t || null, assigned: Boolean(state.n || state.d), ...friendlyValue(state) });
    }
    return {
      ...header(selected),
      color: selected.color,
      ...describeChannelValues(v, 'sel', selected.sendTitles),
      preFilter: {
        bypass: bool(v['sel.pre.bypass']),
        gain: friendlyValue(v['sel.pre.gain']),
        phaseInverted: bool(v['sel.pre.phase']),
        lowCut: { on: bool(v['sel.pre.lowCutOn']), frequency: friendlyValue(v['sel.pre.lowCutFreq']), slope: friendlyValue(v['sel.pre.lowCutSlope']) },
        highCut: { on: bool(v['sel.pre.highCutOn']), frequency: friendlyValue(v['sel.pre.highCutFreq']), slope: friendlyValue(v['sel.pre.highCutSlope']) },
      },
      eq,
      // Plugin presence is one more request: only when the plugin sections are asked for.
      ...describePlugins(selected, !sections || sections.includes('inserts') || sections.includes('strip') ? await pluginPresence() : null),
      quickControls,
    };
  }

  defineTool(
    ctx,
    'cubase_focus_channel',
    'Selects a channel so its full channel strip (Pre filter, EQ, strip modules, inserts, quick controls, plugin parameters) can be read and edited. Returns the strip. ' +
      'Cubase reports the new selection 2-8 s late on big projects: it waits up to ~10 s for it and fails when the selection did not follow. ' +
      SELECTION_NOTE,
    { channel: channelRef, disarm: selectionOptions.disarm },
    async ({ channel, disarm }) => withFocus({ channel, disarm }, describeStrip),
  );

  defineTool(
    ctx,
    'cubase_get_channel_strip',
    'Returns the full channel strip of a channel (or of the selected track): Pre filter, 4-band EQ, strip modules, inserts with plugin names, sends and quick controls. ' +
      'sections limits the answer to some parts: channel (fader, pan, switches, input gain, meter, color), pre (Pre filter), eq, strip (modules), inserts (and the instrument), sends, quickControls; ' +
      'track, channel identity and sideEffects always come. vendor is what Cubase reports; missing marks a plugin that is not installed. ' +
      SELECTION_NOTE,
    {
      channel: optionalChannelRef,
      sections: z.array(z.enum(STRIP_SECTIONS)).min(1).optional().describe('Only these parts of the strip (default: all)'),
      ...selectionOptions,
    },
    async ({ sections, ...args }) => withFocus(args, (selected) => describeStrip(selected, sections ? [...new Set(sections)] : undefined)),
  );

  defineTool(
    ctx,
    'cubase_set_prefilter',
    'Edits the Pre section of a channel: bypass, input gain (-48..+48 dB), phase, low cut and high cut (on, frequency in Hz, slope). ' +
      'Slopes take dB/Oct (lowCutSlopeDb/highCutSlopeDb: 6, 12, 24, 36, 48) or normalized steps (0 = 6, 0.25 = 12, 0.5 = 24, 0.75 = 36, 1 = 48 dB/Oct; other values are rounded to the nearest step). ' +
      'Each change reports the value Cubase shows afterwards; Cubase reports switches and slopes late, so it waits for them (a few seconds at most) and says applied "unconfirmed" when they did not arrive. ' +
      'Gain, phase, low cut on and low cut frequency are written through the mixer bank without selecting the channel; bypass, high cut and slopes need it selected. ' +
      'A warning says when a frequency was set on a cut that is off, or anything while the Pre section is bypassed. ' +
      SELECTION_NOTE,
    {
      channel: optionalChannelRef,
      bypass: z.boolean().optional(),
      gainDb: z.number().min(-48).max(48).optional().describe('Input gain in dB, -48..+48'),
      phaseInvert: z.boolean().optional(),
      lowCutOn: z.boolean().optional(),
      lowCutHz: z.number().min(20).max(20000).optional(),
      lowCutSlope: normalized.optional().describe('Normalized slope: 0 = 6, 0.25 = 12, 0.5 = 24, 0.75 = 36, 1 = 48 dB/Oct'),
      lowCutSlopeDb: slopeDb.optional(),
      highCutOn: z.boolean().optional(),
      highCutHz: z.number().min(20).max(20000).optional(),
      highCutSlope: normalized.optional().describe('Normalized slope: 0 = 6, 0.25 = 12, 0.5 = 24, 0.75 = 36, 1 = 48 dB/Oct'),
      highCutSlopeDb: slopeDb.optional(),
      ...selectionOptions,
    },
    async (args) => {
      // Checked before selecting: selecting can arm the track (Cubase preference), so a call that changes nothing must not select.
      requireAny(args, ['bypass', 'gainDb', 'phaseInvert', 'lowCutOn', 'lowCutHz', 'lowCutSlope', 'lowCutSlopeDb', 'highCutOn', 'highCutHz', 'highCutSlope', 'highCutSlopeDb']);
      onlyOne(args, ['lowCutSlope', 'lowCutSlopeDb'], false);
      onlyOne(args, ['highCutSlope', 'highCutSlopeDb'], false);
      const slope = (n: number | undefined, db: number | undefined) =>
        db !== undefined ? SLOPES_DB.indexOf(db as (typeof SLOPES_DB)[number]) / 4 : n === undefined ? undefined : Math.round(n * 4) / 4;
      const lowCutSlope = slope(args.lowCutSlope, args.lowCutSlopeDb);
      const highCutSlope = slope(args.highCutSlope, args.highCutSlopeDb);
      const warnings: string[] = [];

      const bankOnly =
        args.channel !== undefined &&
        args.disarm === undefined &&
        args.restoreSelection === undefined &&
        args.bypass === undefined &&
        args.highCutOn === undefined &&
        args.highCutHz === undefined &&
        lowCutSlope === undefined &&
        highCutSlope === undefined;
      if (bankOnly) {
        // The bank has gain, phase and low cut of every channel: no selection, so nothing gets armed.
        return client.withChannel(args.channel as ChannelRef, async (info) => {
          const key = (field: string) => client.channelKey(info.index, field);
          const out: Record<string, unknown> = { track: info.title, channel: channelIdentity(info), selected: false };
          if (args.phaseInvert !== undefined) out.phase = await client.setBool(key('pre.phase'), args.phaseInvert);
          if (args.gainDb !== undefined) out.gain = await client.seekDisplay(key('pre.gain'), args.gainDb);
          if (args.lowCutOn !== undefined) out.lowCutOn = await client.setBool(key('pre.lowCutOn'), args.lowCutOn);
          if (args.lowCutHz !== undefined) {
            out.lowCutFreq = await client.seekDisplay(key('pre.lowCutFreq'), args.lowCutHz);
            const on = out.lowCutOn ? (out.lowCutOn as BoolResult).state : bool(await client.getValue(key('pre.lowCutOn')));
            if (on === false) warnings.push('The low cut is off: its frequency is set but has no effect until lowCutOn is true.');
          }
          return { ...out, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) };
        });
      }

      return withFocus(args, async (selected) => {
        const v = selected.values;
        const out: Record<string, unknown> = header(selected);
        const slopeResult = async (field: string, value: number) => {
          // Read back too: Cubase reports the new slope late (first the old one).
          const state = await client.writeAndRead(field, value);
          const db = parseDisplay(state.d, state.u);
          return { ...state, ...(db && Number.isFinite(db.value) ? { dbPerOct: db.value } : {}) };
        };
        if (args.bypass !== undefined) out.bypass = await client.setBool('sel.pre.bypass', args.bypass);
        if (args.phaseInvert !== undefined) out.phase = await client.setBool('sel.pre.phase', args.phaseInvert);
        if (args.gainDb !== undefined) out.gain = await client.seekDisplay('sel.pre.gain', args.gainDb);
        if (args.lowCutOn !== undefined) out.lowCutOn = await client.setBool('sel.pre.lowCutOn', args.lowCutOn);
        if (args.lowCutHz !== undefined) out.lowCutFreq = await client.seekDisplay('sel.pre.lowCutFreq', args.lowCutHz);
        if (lowCutSlope !== undefined) out.lowCutSlope = await slopeResult('sel.pre.lowCutSlope', lowCutSlope);
        if (args.highCutOn !== undefined) out.highCutOn = await client.setBool('sel.pre.highCutOn', args.highCutOn);
        if (args.highCutHz !== undefined) out.highCutFreq = await client.seekDisplay('sel.pre.highCutFreq', args.highCutHz);
        if (highCutSlope !== undefined) out.highCutSlope = await slopeResult('sel.pre.highCutSlope', highCutSlope);
        // What is on now: the switch written in this call, else the one read with the selection (no extra MIDI traffic).
        const isOn = (written: unknown, key: string) => (written ? (written as BoolResult).state : bool(v[key]));
        const bypassed = isOn(out.bypass, 'sel.pre.bypass');
        const lowCutOff = isOn(out.lowCutOn, 'sel.pre.lowCutOn') === false;
        const highCutOff = isOn(out.highCutOn, 'sel.pre.highCutOn') === false;
        if (lowCutOff && (args.lowCutHz !== undefined || lowCutSlope !== undefined)) warnings.push('The low cut is off: its frequency/slope is set but has no effect until lowCutOn is true.');
        if (highCutOff && (args.highCutHz !== undefined || highCutSlope !== undefined)) warnings.push('The high cut is off: its frequency/slope is set but has no effect until highCutOn is true.');
        if (bypassed === true && args.bypass !== true) warnings.push('The Pre section is bypassed: these settings have no effect until bypass is false.');
        return { ...out, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) };
      });
    },
  );

  defineTool(
    ctx,
    'cubase_set_eq_band',
    `Edits one band of the channel EQ (4 bands): on/off, gain in dB, frequency in Hz, Q (0..12) and filter type. ${SWITCH_LAG_NOTE} ` +
      'type takes the name Cubase shows (bands 1 and 4: 8 types, e.g. "Parametric II", "High Pass I", "Low Shelf IV" on band 1, "Low Pass I", "High Shelf II" on band 4; bands 2 and 3: "Parametric I" and "Parametric II"); ' +
      'listTypes returns the names of the band (alone, it selects and writes nothing). The type written is checked against what Cubase shows afterwards: ' +
      'a different name puts the old type back and is an error (some names are not confirmed on a live Cubase yet). typeNormalized writes the raw value instead (type k of n is k/(n-1)). ' +
      'Cubase keeps gain, frequency and Q of a band that is off, so they can be set before switching it on: bandOn says whether the band is on, and a warning says when the values were written to a band that is off (pass on: true to switch it on in the same call). ' +
      SELECTION_NOTE,
    {
      channel: optionalChannelRef,
      band: z.number().int().min(1).max(4),
      on: z.boolean().optional(),
      gainDb: z.number().min(-24).max(24).optional(),
      frequencyHz: z.number().min(20).max(20000).optional(),
      q: z.number().min(0).max(12).optional().describe('Q, 0..12 (Cubase shows 0.0 at the bottom of the range)'),
      type: z.string().trim().min(1).optional().describe('Filter type by name, e.g. "Parametric II", "High Pass I" (see listTypes)'),
      typeNormalized: normalized.optional(),
      listTypes: z.boolean().optional().describe('Also return the type names of this band (alone: only the list, nothing selected or written)'),
      ...selectionOptions,
    },
    async (args) => {
      const types = { band: args.band, types: [...EQ_TYPES[args.band]] };
      const changes = ['on', 'gainDb', 'frequencyHz', 'q', 'type', 'typeNormalized'] as const;
      if (args.listTypes && !changes.some((k) => args[k] !== undefined)) {
        if (args.channel !== undefined) throw new Error('listTypes alone does not select a channel: leave channel out, or give a change too');
        return types;
      }
      requireAny(args, [...changes]);
      onlyOne(args, ['type', 'typeNormalized'], false);
      // Checked before selecting: an unknown name selects nothing.
      const step = args.type !== undefined ? eqTypeStep(args.band, args.type) : undefined;
      return withFocus(args, async (selected) => {
        const prefix = `sel.eq.${args.band}`;
        const out: Record<string, unknown> = { ...header(selected), band: args.band, ...(args.listTypes ? { types: types.types } : {}) };
        if (args.on !== undefined) out.on = await client.setBool(`${prefix}.on`, args.on);
        if (args.typeNormalized !== undefined) {
          out.type = await client.writeAndRead(`${prefix}.type`, args.typeNormalized);
        }
        if (step) out.type = await writeEqType(`${prefix}.type`, args.band, step);
        if (args.frequencyHz !== undefined) out.frequency = await client.seekDisplay(`${prefix}.freq`, args.frequencyHz);
        if (args.gainDb !== undefined) out.gain = await client.seekDisplay(`${prefix}.gain`, args.gainDb);
        if (args.q !== undefined) out.q = await client.seekDisplay(`${prefix}.q`, args.q);
        // The band switch written in this call, else the one read with the selection (no extra MIDI traffic).
        const bandOn = out.on ? (out.on as BoolResult).state : bool(selected.values[`${prefix}.on`]);
        out.bandOn = bandOn;
        const valuesWritten = ['gainDb', 'frequencyHz', 'q', 'type', 'typeNormalized'].some((k) => args[k as keyof typeof args] !== undefined);
        if (bandOn === false && valuesWritten) {
          out.warning = `Band ${args.band} is off: the values are stored but have no effect until the band is switched on (on: true).`;
        }
        return out;
      });
    },
  );

  defineTool(
    ctx,
    'cubase_set_strip_module',
    'Switches a channel strip module (gate, compressor, tools, saturator, limiter): on, bypass, open editor. Edit its parameters with cubase_set_plugin_parameter (target "strip"). ' +
      'An empty module is an error. openEditor selects the channel too (and, with Cubase\'s "record follows selection" preference, record-arms it). ' +
      'Plugin editor windows are hidden from Accessibility (ui_list_windows) while Cubase is in the background: editorOpen in cubase_get_channel_strip is the reliable check. ' +
      `${SWITCH_LAG_NOTE} ${SELECTION_NOTE}`,
    {
      channel: optionalChannelRef,
      module: stripModule,
      on: z.boolean().optional(),
      bypass: z.boolean().optional(),
      openEditor: z.boolean().optional(),
      ...selectionOptions,
    },
    async (args) => {
      requireAny(args, ['on', 'bypass', 'openEditor']);
      const { module, on, bypass, openEditor } = args;
      return withFocus(args, async (selected) => {
        const prefix = `sel.strip.${module}`;
        const plugin = selected.plugins[prefix]?.name || null;
        if (!plugin) throw new Error(`The ${module} module of "${selected.title}" is empty: Cubase 13 cannot load a module through the API`);
        const out: Record<string, unknown> = { ...header(selected), module, plugin };
        if (on !== undefined) out.on = await client.setBool(`${prefix}.on`, on);
        if (bypass !== undefined) out.bypass = await client.setBool(`${prefix}.bypass`, bypass);
        if (openEditor !== undefined) out.editor = await client.setBool(`${prefix}.edit`, openEditor);
        return out;
      });
    },
  );

  defineTool(
    ctx,
    'cubase_list_inserts',
    'Lists the plugins of a channel (or the selected track) like cubase_get_channel_strip: inserts with slot 1-16 (only loaded slots unless includeEmpty), strip modules and instrument (null when the track has none), ' +
      'with on/bypass/editorOpen as booleans. vendor is what Cubase reports; missing marks a plugin that is not installed (Cubase keeps its name but has no parameters for it). ' +
      SELECTION_NOTE,
    {
      channel: optionalChannelRef,
      includeEmpty: z.boolean().default(false).describe('Also list the empty insert slots'),
      ...selectionOptions,
    },
    async (args) => withFocus(args, async (selected) => ({ ...header(selected), ...describePlugins(selected, await pluginPresence(), args.includeEmpty) })),
  );

  defineTool(
    ctx,
    'cubase_set_insert',
    'Switches an insert slot (1-16) of a channel: activate/deactivate, bypass, open/close the plugin window. Cubase 13 cannot load a new plugin into a slot through the API: keep your chains in the project template and switch them here. ' +
      'openEditor selects the channel too (and, with Cubase\'s "record follows selection" preference, record-arms it). ' +
      'Plugin editor windows are hidden from Accessibility (ui_list_windows) while Cubase is in the background: editorOpen in cubase_get_channel_strip is the reliable check. ' +
      `${SWITCH_LAG_NOTE} ${SELECTION_NOTE}`,
    {
      channel: optionalChannelRef,
      slot: z.number().int().min(1).max(16),
      on: z.boolean().optional(),
      bypass: z.boolean().optional(),
      openEditor: z.boolean().optional(),
      ...selectionOptions,
    },
    async (args) => {
      requireAny(args, ['on', 'bypass', 'openEditor']);
      const { slot, on, bypass, openEditor } = args;
      return withFocus(args, async (selected) => {
        const prefix = slotScope('insert', slot);
        const out: Record<string, unknown> = { ...header(selected), slot, plugin: selected.plugins[prefix]?.name || null };
        if (!out.plugin) throw new Error(`Insert slot ${slot} of "${selected.title}" is empty`);
        if (on !== undefined) out.on = await client.setBool(`${prefix}.on`, on);
        if (bypass !== undefined) out.bypass = await client.setBool(`${prefix}.bypass`, bypass);
        if (openEditor !== undefined) out.editor = await client.setBool(`${prefix}.edit`, openEditor);
        return out;
      });
    },
  );

  defineTool(
    ctx,
    'cubase_set_quick_control',
    'Sets a quick control (1-8) of the selected track (or of the channel given, which gets selected) or, with focused=true, of the focused quick controls, as a normalized value. ' +
      'focused=true cannot take a channel: the focused quick controls follow the window that has the focus, not a track. ' +
      'It reads the quick control first: one with no parameter assigned (no name, no display) is not written (Cubase drops the write, and a focused one reports the previous write back), ' +
      'assigned false says so; the API cannot assign quick controls. Otherwise parameter names what it controls, and verified says Cubase shows the value asked for. ' +
      'cubase_get_focused_quick_controls reads what the focused ones control before a write. ' +
      SELECTION_NOTE,
    {
      channel: optionalChannelRef,
      index: z.number().int().min(1).max(8),
      value: normalized,
      focused: z.boolean().default(false).describe('Use the focused quick controls instead of the track quick controls'),
      ...selectionOptions,
    },
    async (args) => {
      const { channel, index, value, focused } = args;
      if (focused && (channel !== undefined || args.disarm !== undefined || args.restoreSelection !== undefined)) {
        throw new Error('Give either channel (with disarm/restoreSelection) or focused=true, not both: the focused quick controls follow the focused window, not a channel.');
      }
      const key = focused ? `fqc.${index - 1}` : `sel.qc.${index - 1}`;
      const run = async (selected: Focused | null) => {
        const before = await client.getValue(key);
        // Assigned: Cubase names the parameter (n) or shows a display. Without one it drops writes.
        const assigned = Boolean(before.n) || Boolean(before.d);
        const head = { ...(selected ? header(selected) : {}), key, index, assigned, parameter: before.n || null, owner: before.t || null };
        if (!assigned) {
          return {
            ...head,
            written: false,
            warning: focused
              ? `Focused quick control ${index} has no parameter assigned: nothing was written (Cubase would only report the previous write back). Focus a plugin window whose parameter it controls first.`
              : `Quick control ${index} of "${selected?.title}" has no parameter assigned: nothing was written (Cubase drops writes to it). Assign it in Cubase; the API cannot.`,
          };
        }
        let state = await client.writeAndRead(key, value);
        if (focused && state.differsFromRequest) {
          // Cubase can report a focused quick control one write behind: wait for the value once more.
          await sleep(ctx.config.settleMs);
          const again = await client.waitForValue(key, (s) => s.v !== null && Math.abs(s.v - value) < 0.01);
          state = { ...state, ...again.state, applied: again.confirmed ? 'confirmed' : state.applied, differsFromRequest: again.state.v === null || Math.abs(again.state.v - value) > 1e-6 };
        }
        return { ...head, written: true, state, verified: state.applied === 'confirmed' && !state.differsFromRequest };
      };
      return focused ? run(null) : withFocus(args, run);
    },
  );

  defineTool(
    ctx,
    'cubase_get_focused_quick_controls',
    'Reads the focused quick controls: the 8 quick controls that follow the window with the focus (a plugin editor, the channel settings), written with cubase_set_quick_control focused=true. ' +
      'target is the object they control now; each quick control gives owner (the object its parameter belongs to, e.g. the plugin), parameter (the parameter name, when Cubase gives one: ' +
      'for focused quick controls Cubase 13 usually names only the owner), assigned and the value. locked says whether the focus is locked. ' +
      'One with no parameter assigned has no display, and Cubase answers a write to it with the previous write.',
    {},
    async () => {
      const state = await client.call<{ title?: string; values: Record<string, ValueState> }>('state.focusedQuickControls');
      const v = state.values ?? {};
      const quickControls = [];
      for (let q = 0; q < 8; q++) {
        const qc = v[`fqc.${q}`];
        if (!qc) continue;
        quickControls.push({
          index: q + 1,
          key: `fqc.${q}`,
          assigned: Boolean(qc.n || qc.d),
          owner: qc.t || null,
          parameter: qc.n || null,
          ...friendlyValue(qc),
        });
      }
      return {
        target: state.title || null,
        locked: bool(v['fqc.locked']),
        quickControls,
        ...(quickControls.some((q) => q.assigned && !q.parameter) ? { note: 'Cubase names only the owner of these quick controls, not the parameter they control.' } : {}),
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_select_track',
    'Selects another track in the project window track list (not the MixConsole order) and returns the new selection. selected is null when the new track has no mixer channel (folder, marker track...). ' +
      'direction moves one track (next or prev); to "first"/"last" steps to the first or last track; name steps until the selected track has that name (whole name, ignoring case), ' +
      'in direction or, without it, first down to the last track and then up to the first. Steps go one track at a time (steps says how many were sent; maxSteps caps them), ' +
      'reading the selection after each one, so a jump over many tracks takes a while. Tracks without mixer channel have no name through the API (a folder cannot be found by name) ' +
      'and cannot be told apart: after maxBlindSteps steps in a row over them, the jump stops. ' +
      'Cubase reports the new selection 2-8 s late on big projects: it waits up to ~10 s for it. changed says whether the selection changed; moved (one step) is true when it did, ' +
      'false when it did not although the previous track had a mixer channel (most likely the first or last track of the list), and null when that cannot be told ' +
      '(between two tracks without mixer channel the API sees no difference). Every track selected on the way can get record-armed (Cubase preference "Enable Record on Selected Audio Track").',
    {
      direction: z.enum(['next', 'prev']).optional().describe('One step (alone), or the direction to search name in'),
      to: z.enum(['first', 'last']).optional().describe('Step to the first or the last track of the list'),
      name: z.string().trim().min(1).optional().describe('Step until the selected track has this name'),
      maxSteps: z.number().int().min(1).max(500).default(200).describe('At most this many steps for to and name'),
      maxBlindSteps: z.number().int().min(1).max(50).default(5).describe('Steps in a row over tracks without mixer channel before a jump stops'),
    },
    async ({ direction, to, name, maxSteps, maxBlindSteps }) => {
      if (to !== undefined && (direction !== undefined || name !== undefined)) throw new Error('Give to alone: it already sets the direction, and name is a different jump');
      if (to === undefined && direction === undefined && name === undefined) throw new Error('Give direction (one step), to (first or last) or name');
      // On big projects Cubase can stall for several seconds after a selection change
      // (it also arms the track when "Enable Record on Selected Track" is on).
      const timeoutMs = Math.max(ctx.config.requestTimeoutMs, 10000);
      const selectionWaitMs = ctx.config.selectionTimeoutMs ?? 10000;
      type Read = Awaited<ReturnType<typeof client.selection>> & { uid: string | null };
      const read = async (): Promise<Read> => {
        const info = await client.selectionInfo(timeoutMs);
        return { ...(await client.selection(info)), uid: info.uid ?? null };
      };
      /**
       * One step. Cubase deselects the old track before it selects the new one, so the first change can be an
       * in-between state: wait until the selection changes and then holds for three reads in a row (up to waitMs).
       */
      const step = async (dir: 'next' | 'prev', from: Read, waitMs: number) => {
        const before = JSON.stringify(from);
        // If Cubase does not confirm the action (a lost or late answer), read the selection anyway.
        let unconfirmed: string | null = null;
        await client.runAction(`track.${dir}`, timeoutMs).catch((error: Error) => {
          unconfirmed = error.message;
        });
        const deadline = Date.now() + waitMs;
        let selection = await read();
        let last = JSON.stringify(selection);
        let changed = last !== before;
        let stableReads = 0;
        while (stableReads < 3 && Date.now() < deadline) {
          await sleep(changed ? 150 : 300);
          selection = await read();
          const current = JSON.stringify(selection);
          if (current === last) {
            if (changed) stableReads++;
          } else {
            last = current;
            changed = current !== before;
            stableReads = 0;
          }
        }
        const moved: boolean | null = changed ? true : from.hasMixerChannel ? false : null;
        return { selection, changed, moved, unconfirmed: unconfirmed as string | null };
      };

      const previous = await read();
      if (to === undefined && name === undefined) {
        const { selection, changed, moved, unconfirmed } = await step(direction as 'next' | 'prev', previous, selectionWaitMs);
        let note: string | undefined;
        if (changed && !selection.hasMixerChannel) note = 'The selected track has no mixer channel, so the channel-strip tools cannot act on it.';
        else if (moved === false) note = `The selection did not move from "${previous.title}": most likely it is the ${direction === 'next' ? 'last' : 'first'} track of the list.`;
        else if (moved === null) note = 'Cannot tell whether the selection moved: tracks without mixer channel all look the same through the API.';
        return {
          previous: previous.title,
          selected: selection.title,
          hasMixerChannel: selection.hasMixerChannel,
          changed,
          moved,
          steps: 1,
          applied: changed ? 'confirmed' : 'unconfirmed',
          ...(unconfirmed ? { warning: `Cubase did not confirm the action (${unconfirmed}); this is the selection read afterwards.` } : {}),
          ...(note ? { note } : {}),
        };
      }

      // A name with a mixer channel is selected through the mixer: stepping only visits the tracks the project
      // window shows (not those inside collapsed folders, live 15 Oct 2026) and arms every track on the way.
      if (name !== undefined && direction === undefined) {
        const direct = await client.focusChannel({ name, exact: true }, { disarm: true }).catch(() => null);
        if (direct) {
          return {
            previous: previous.title,
            selected: direct.channel.title,
            hasMixerChannel: true,
            changed: previous.title !== direct.channel.title,
            steps: 0,
            name,
            found: true,
            via: 'mixer',
            applied: direct.applied,
            sideEffects: direct.sideEffects,
          };
        }
      }

      // A jump: steps until the end of the list or the name. A step from a track without mixer channel cannot
      // be seen unless it lands on one, so it waits less (a late selection only means one more step).
      const blindWaitMs = Math.min(selectionWaitMs, 3000);
      const wanted = name?.toLowerCase();
      const isWanted = (r: Read) => wanted !== undefined && (r.title ?? '').trim().toLowerCase() === wanted;
      let current = previous;
      let steps = 0;
      let found = isWanted(current);
      let stepLimit = false;
      const unconfirmedSteps: string[] = [];
      const ends: Record<string, boolean | null> = {};
      const directions: Array<'next' | 'prev'> = to ? [to === 'first' ? 'prev' : 'next'] : direction ? [direction] : ['next', 'prev'];
      for (const dir of directions) {
        if (found) break;
        let blind = 0;
        ends[dir] = null;
        while (!found) {
          if (steps >= maxSteps) {
            stepLimit = true;
            break;
          }
          const result = await step(dir, current, current.hasMixerChannel ? selectionWaitMs : blindWaitMs);
          steps++;
          if (result.unconfirmed) unconfirmedSteps.push(result.unconfirmed);
          if (result.moved === false) {
            ends[dir] = true;
            break;
          }
          current = result.selection;
          blind = result.moved === null ? blind + 1 : 0;
          found = isWanted(current);
          if (blind >= maxBlindSteps) break;
        }
        if (stepLimit) break;
      }
      // A name not found: put the selection back on the track it started from (when that one had a mixer channel).
      let restored: string | undefined;
      if (name && !found && previous.hasMixerChannel && previous.title && JSON.stringify(current) !== JSON.stringify(previous)) {
        const back = await client
          .focusChannel(previous.title, { disarm: true })
          .catch(() => null);
        if (back) {
          restored = back.channel.title;
          current = await read().catch(() => current);
        }
      }
      const changed = JSON.stringify(current) !== JSON.stringify(previous);
      const endReached = to ? ends[directions[0]] : undefined;
      let note: string | undefined;
      if (stepLimit) note = `Stopped after maxSteps (${maxSteps}) steps.`;
      else if (to && endReached !== true) note = `Stopped after ${maxBlindSteps} steps in a row over tracks without mixer channel: the ${to} track may be further.`;
      else if (name && !found)
        note =
          `No track named "${name}" was found: no mixer channel has that name, and stepping through the project window (which skips tracks inside collapsed folders) did not reach it. ` +
          (restored ? `The selection was put back on "${restored}".` : 'The selection stays where the search ended.');
      if (!current.hasMixerChannel && !note) note = 'The selected track has no mixer channel, so the channel-strip tools cannot act on it.';
      return {
        previous: previous.title,
        selected: current.title,
        hasMixerChannel: current.hasMixerChannel,
        changed,
        steps,
        ...(to ? { to, reachedEnd: endReached ?? null } : {}),
        ...(name ? { name, found } : {}),
        applied: changed || found ? 'confirmed' : 'unconfirmed',
        ...(unconfirmedSteps.length > 0 ? { warning: `Cubase did not confirm ${unconfirmedSteps.length} step(s) (${unconfirmedSteps[0]}); the selection was read after each one.` } : {}),
        ...(note ? { note } : {}),
      };
    },
  );
}
