import { z } from 'zod';
import {
  defineTool,
  normalized,
  onlyOne,
  optionalChannelRef,
  SELECTION_NOTE,
  selectionOptions,
  slotScope,
  stripModule,
  withSelection,
  type SelectedChannel,
  type ToolContext,
} from './common.js';
import { isSelectionStale, staleSelectionMessage, type ChannelRef, type DirectParameter } from '../cubase/client.js';

const target = z
  .enum(['insert', 'strip', 'instrument'])
  .describe('insert = insert slot (needs slot), strip = channel strip module (needs module), instrument = VST instrument of the track');

const directScope = z
  .string()
  .describe(
    'DirectAccess scope: "mixconsole" (whole mixer tree), "selected" (selected channel), "transport", "controlroom" (only while Control Room is enabled in Cubase: ' +
      'disabled, Cubase points this scope at the MixConsole root, and the call fails instead), ' +
      '"sel.ins.0".."sel.ins.15" (insert slots), "sel.strip.<module>", "sel.inst".',
  );

/** How a title text matches: contains (default), exact (the whole title) or regex; all ignore case. */
const matchMode = z
  .enum(['contains', 'exact', 'regex'])
  .optional()
  .describe('How the text matches titles: "contains" (default: anywhere in the title), "exact" (the whole title) or "regex" (a regular expression); all ignore case');

const parameterSelector = {
  parameter: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Parameter title, matched as match says (default: contained in the title, case-insensitive), e.g. "Threshold". When several parameters match, a title equal to the text wins; ' +
        'otherwise it is an error that lists them (nothing is written). Give parameter or tag, not both.',
    ),
  tag: z.number().int().optional().describe('Parameter tag (from cubase_get_plugin_parameters). Give parameter or tag, not both. A tag the object does not have is an error.'),
  match: matchMode,
};

/** Read some parameters by tag instead of listing them. */
const tagReads = {
  tag: z.number().int().optional().describe('Read just this parameter (by tag; an error when the object has no such tag)'),
  tags: z.array(z.number().int()).min(1).max(200).optional().describe('Read just these parameters, in this order'),
};

/** The tags asked for (tag or tags), refusing a filter or a page with them. */
function tagsOf(args: { tag?: number; tags?: number[]; filter?: string; offset?: number }): number[] | undefined {
  onlyOne(args, ['tag', 'tags'], false);
  const tags = args.tag !== undefined ? [args.tag] : args.tags;
  if (tags && args.filter !== undefined) throw new Error('Give filter or tag/tags, not both');
  if (tags && args.offset) throw new Error('offset does not apply to tag/tags');
  return tags;
}

/** Keys of a parameter in cubase_get_plugin_parameters. */
const PARAMETER_FIELDS = ['tag', 'title', 'value', 'display', 'units', 'defaultValue'] as const;

const SLOT_NOTE =
  'An empty slot or module, a track without instrument, and a plugin that is not installed (Cubase keeps its name but has no parameters for it) are errors: ' +
  'they used to read and write the slot\'s own controls instead.';

const DISPLAY_NOTE =
  'A display text is checked against what Cubase shows afterwards (Cubase ignores a text it does not understand without an error): ' +
  'a text Cubase ignored is an error, and one that moved the parameter to something else gives applied false with a warning.';

export function registerPluginTools(ctx: ToolContext): void {
  const { client } = ctx;

  /**
   * Selects the channel when given and runs work; without a channel, a selection that points at no mixer
   * channel is an error (the slot scopes would act on the channel the sel.* values still belong to).
   */
  async function onSelection<T>(
    args: { channel?: ChannelRef; disarm?: boolean; restoreSelection?: boolean },
    work: (head: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    return withSelection(client, args.channel, args, async (selection: SelectedChannel | null) => {
      if (!selection) {
        const info = await client.selectionInfo();
        if (isSelectionStale(info)) throw new Error(staleSelectionMessage(await client.selected()));
        return work({});
      }
      return work({ channel: selection.identity, sideEffects: selection.sideEffects });
    });
  }

  function selector(args: { tag?: number; parameter?: string; match?: string }) {
    if (onlyOne(args, ['parameter', 'tag']) === 'tag') {
      if (args.match !== undefined) throw new Error('match only applies to parameter (a title), not to tag');
      return { tag: args.tag };
    }
    return { title: args.parameter, ...(args.match !== undefined ? { match: args.match } : {}) };
  }

  /** A normalized write with its verdict: a write Cubase did not take gives applied false and a warning. */
  async function writeNormalized(scope: string, sel: Record<string, unknown>, value: number) {
    const result = await client.setDirectNormalized(scope, sel, value);
    const shown = `${result.parameter.display ?? ''}${result.parameter.units ? ` ${result.parameter.units}` : ''}`;
    if (!result.applied) {
      return { ...result, warning: `Cubase did not take ${value}: "${result.parameter.title}" still shows "${shown}" (${result.parameter.value}). A read-only parameter ignores writes.` };
    }
    if (!result.matches) return { ...result, note: `Cubase snapped the value to ${result.parameter.value} ("${shown}").` };
    return result;
  }

  /** slot goes with target "insert" and module with "strip": anything else is a mistake, not something to ignore. */
  function checkTarget(args: { target: string; slot?: number; module?: string }) {
    if (args.slot !== undefined && args.target !== 'insert') throw new Error('slot only applies to target "insert"');
    if (args.module !== undefined && args.target !== 'strip') throw new Error('module only applies to target "strip"');
  }

  /** A display write: an error when Cubase ignored the text, a warning when it moved the parameter elsewhere. */
  async function writeDisplay(scope: string, sel: Record<string, unknown>, display: string) {
    const result = await client.setDirectDisplay(scope, sel, display);
    const shown = result.parameter.display ?? '';
    if (!result.applied && result.changed !== true) {
      throw new Error(
        `Cubase ignored the display text "${display}": "${result.parameter.title}" still shows "${shown}${result.parameter.units ? ` ${result.parameter.units}` : ''}". ` +
          'Use a text the parameter shows (a number, or a word of its list), valueInUnits or normalized.',
      );
    }
    return {
      ...result,
      ...(result.applied ? {} : { warning: `Cubase moved "${result.parameter.title}" to "${shown}", not to "${display}".` }),
    };
  }

  defineTool(
    ctx,
    'cubase_get_plugin_parameters',
    'Lists the parameters of a plugin on a channel (insert slot, strip module or instrument) with title, display value, units, normalized value and tag. ' +
      'Use filter to narrow down big plugins (match: contains, exact or regex): then offset and limit count the matching parameters, total is the plugin\'s parameter count and matchedTotal how many match. ' +
      'tag or tags read just those parameters (to check a write by tag). ' +
      'For a compact answer, fields picks the keys of each parameter (index always comes along), and titlesOnly returns just "tag: title" lines (titles) instead of parameters. ' +
      `${SLOT_NOTE} ${SELECTION_NOTE}`,
    {
      channel: optionalChannelRef,
      target,
      slot: z.number().int().min(1).max(16).optional(),
      module: stripModule.optional(),
      filter: z.string().optional().describe('Only parameters whose title matches this text (see match)'),
      match: matchMode,
      ...tagReads,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(120).describe('At most 200 per call (bigger answers do not fit the client): page with offset (total, or matchedTotal with a filter, says how many there are)'),
      fields: z
        .array(z.enum(PARAMETER_FIELDS))
        .min(1)
        .optional()
        .describe('Only these keys of each parameter, e.g. ["tag", "title", "display"] (index is always included)'),
      titlesOnly: z.boolean().default(false).describe('Return titles: ["tag: title", ...] instead of parameters (the most compact answer)'),
      ...selectionOptions,
    },
    async (args) => {
      const { target: kind, slot, module, filter, match, offset, limit, fields, titlesOnly } = args;
      checkTarget({ target: kind, slot, module });
      if (fields && titlesOnly) throw new Error('Give fields or titlesOnly, not both');
      if (match !== undefined && filter === undefined) throw new Error('match applies to filter: give a filter');
      const tags = tagsOf(args);
      const scope = slotScope(kind, slot, module);
      const keep = titlesOnly ? ['tag', 'title'] : fields;
      return onSelection(args, async (head) => {
        const selected = await client.selected();
        const result = await client.call<Record<string, unknown> & { parameters?: Array<Record<string, unknown>> }>(
          'da.params',
          { scope, ...(tags ? { tags } : { filter, match, offset, limit }), ...(keep ? { fields: keep } : {}) },
          15000,
        );
        const { parameters, ...rest } = result;
        const list = parameters ?? [];
        // Older bridge scripts ignore fields: trimmed here too.
        const shaped = titlesOnly
          ? { titles: list.map((p) => `${p.tag}: ${p.title}`) }
          : { parameters: keep ? list.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => keep.includes(k) || k === 'index'))) : list };
        return { track: selected.title, ...head, plugin: selected.plugins[scope]?.name || null, scope, ...rest, ...shaped };
      });
    },
  );

  defineTool(
    ctx,
    'cubase_set_plugin_parameter',
    'Sets one plugin parameter on a channel. Give exactly one of valueInUnits for real units (dB, Hz, ms, %: searched against the plugin display, starting from the current value; ' +
      'a switch that shows "On"/"Off" takes 1 for on and 0 for off), display to type a value the way the plugin shows it, or normalized (0..1). ' +
      'A search that fails puts the parameter back to the value it had; a parameter whose display is not a number (a mode list) needs display or normalized. ' +
      'A normalized write reports before, the parameter after, changed, matches and applied (false with a warning when Cubase ignored it, e.g. a read-only parameter). ' +
      `${DISPLAY_NOTE} ${SLOT_NOTE} ${SELECTION_NOTE}`,
    {
      channel: optionalChannelRef,
      target,
      slot: z.number().int().min(1).max(16).optional(),
      module: stripModule.optional(),
      ...parameterSelector,
      valueInUnits: z.number().optional(),
      display: z.string().optional(),
      normalized: normalized.optional(),
      ...selectionOptions,
    },
    async (args) => {
      // Every check before selecting anything.
      checkTarget(args);
      const scope = slotScope(args.target, args.slot, args.module);
      const sel = selector(args);
      const mode = onlyOne(args, ['valueInUnits', 'display', 'normalized']);
      return onSelection(args, async (head) => {
        let result: object;
        if (mode === 'valueInUnits') result = await client.seekDirectParameter(scope, sel, args.valueInUnits as number);
        else if (mode === 'display') result = await writeDisplay(scope, sel, args.display as string);
        else result = await writeNormalized(scope, sel, args.normalized as number);
        return { ...head, ...result };
      });
    },
  );

  defineTool(
    ctx,
    'cubase_set_plugin_parameters',
    'Sets several parameters of the same plugin at once. Each item gives parameter or tag, and normalized, display or valueInUnits (exactly one of each). Faster than one call per parameter. ' +
      'Every item says whether Cubase took it: normalized and display items report before, changed, matches and applied; valueInUnits items are searched one by one ' +
      'like in cubase_set_plugin_parameter (a search that fails puts that parameter back and reports error; applied is withinTolerance). ' +
      'notApplied counts the items not applied as asked, failed the items with an error (the other items are still written). ' +
      `${SLOT_NOTE} ${SELECTION_NOTE}`,
    {
      channel: optionalChannelRef,
      target,
      slot: z.number().int().min(1).max(16).optional(),
      module: stripModule.optional(),
      items: z
        .array(
          z
            .object({
              parameter: z.string().trim().min(1).optional(),
              tag: z.number().int().optional(),
              normalized: normalized.optional(),
              display: z.string().optional(),
              valueInUnits: z.number().optional(),
            })
            .strict()
            .refine((i) => (i.parameter === undefined) !== (i.tag === undefined), { message: 'Each item needs parameter or tag (exactly one)' })
            .refine((i) => [i.normalized, i.display, i.valueInUnits].filter((v) => v !== undefined).length === 1, {
              message: 'Each item needs normalized, display or valueInUnits (exactly one)',
            }),
        )
        .min(1)
        .max(100),
      match: matchMode.describe('How the parameter titles of the items match (see cubase_set_plugin_parameter)'),
      ...selectionOptions,
    },
    async (args) => {
      const { target: kind, slot, module, items, match } = args;
      checkTarget({ target: kind, slot, module });
      const scope = slotScope(kind, slot, module);
      return onSelection(args, async (head) => {
        type ItemResult = Record<string, unknown> & { applied?: boolean | null; error?: string };
        const results: ItemResult[] = new Array(items.length);
        let objectId: number | undefined;
        // Normalized and display items go in one request per run between valueInUnits items (item order is kept).
        let run: number[] = [];
        const flush = async () => {
          if (run.length === 0) return;
          const chunk = run.map((i) => items[i]);
          const indexes = run;
          run = [];
          const written = await client.call<{ objectId: number; results: Array<DirectParameter & { error?: string; before?: { value: number | null; display: string | null } }> }>(
            'da.setParams',
            { scope, ...(match ? { match } : {}), items: chunk.map((i) => ({ title: i.parameter, tag: i.tag, value: i.normalized, display: i.display })) },
            15000,
          );
          objectId = written.objectId;
          const verified = await client.verifyDisplayItems(scope, written.objectId, chunk, written.results);
          indexes.forEach((itemIndex, k) => {
            results[itemIndex] = verified[k] as ItemResult;
          });
        };
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.valueInUnits === undefined) {
            run.push(i);
            continue;
          }
          await flush();
          const sel = item.tag !== undefined ? { tag: item.tag } : { title: item.parameter, ...(match ? { match } : {}) };
          const named = { ...(item.parameter !== undefined ? { title: item.parameter } : {}), ...(item.tag !== undefined ? { tag: item.tag } : {}) };
          try {
            const seek = await client.seekDirectParameter(scope, sel, item.valueInUnits);
            results[i] = { ...named, requestedUnits: item.valueInUnits, ...seek, applied: seek.withinTolerance };
          } catch (error) {
            results[i] = { ...named, requestedUnits: item.valueInUnits, error: (error as Error).message };
          }
        }
        await flush();
        const notApplied = results.filter((r) => r.applied === false).length;
        const failed = results.filter((r) => r.error).length;
        return {
          ...head,
          ...(objectId !== undefined ? { objectId } : {}),
          results,
          ...(notApplied > 0 ? { notApplied, warning: `${notApplied} ${notApplied === 1 ? 'item was' : 'items were'} not applied as asked (see applied in results).` } : {}),
          ...(failed > 0 ? { failed } : {}),
        };
      });
    },
  );

  defineTool(
    ctx,
    'cubase_da_tree',
    'Advanced: explores the DirectAccess object tree of a scope (objects, titles, types, parameter counts). Use it to discover how Cubase exposes channels, inserts and their parameters. ' +
      'Answers are kept small: 120 nodes by default (truncated says when more were left out) and, unless details=true, without color, unique name and uid. ' +
      'maxDepth 0 returns the object alone. To go deeper, call it again with the objectId of a node instead of raising maxDepth. ' +
      'mixerChannelIndex is DirectAccess\'s own numbering, not a bank index (Stereo Out is -1 and input channels count): bankIndex is added when the node is a channel the mixer bank shows now (matched by unique id). ' +
      'An objectId that does not exist is an error.',
    {
      scope: directScope,
      objectId: z.number().int().optional(),
      maxDepth: z.number().int().min(0).max(8).default(2),
      maxNodes: z.number().int().min(1).max(1000).default(120),
      details: z.boolean().default(false).describe('Include color, unique name, uid and visibility of each node (about twice the size)'),
    },
    async ({ scope, objectId, maxDepth, maxNodes, details }) =>
      client.call('da.tree', { scope, objectId, maxDepth, maxNodes, brief: !details }, 20000),
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_da_find',
    'Advanced: finds DirectAccess objects whose title contains a text (for example a plugin name; match "exact" for the whole title, "regex" for a regular expression) anywhere under a scope (default: the whole MixConsole) or under objectId. ' +
      'It searches breadth first, so all channels are looked at before what is inside them, and stops after maxNodes objects (truncated: true; a whole channel is ~74 nodes) ' +
      'or maxResults results (maxResultsReached: true). When truncated, search under the objectId of a channel, lower maxDepth or raise maxNodes.',
    {
      titleContains: z.string().min(1).describe('The text to look for in object titles (with match "regex", a regular expression)'),
      match: matchMode,
      scope: directScope.default('mixconsole'),
      objectId: z.number().int().optional().describe('Search under this object instead of the scope root'),
      maxDepth: z.number().int().min(1).max(10).default(6),
      maxNodes: z.number().int().min(1).max(100000).default(20000).describe('Objects to look at, at most (~20000 take ~160 ms in Cubase)'),
      maxResults: z.number().int().min(1).max(500).default(100),
    },
    async ({ titleContains, match, scope, objectId, maxDepth, maxNodes, maxResults }) =>
      client.call('da.find', { titleContains, match, scope, objectId, maxDepth, maxNodes, maxResults }, 20000),
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_da_get_parameters',
    'Advanced: lists the parameters of any DirectAccess object (scope + optional objectId from cubase_da_tree / cubase_da_find). ' +
      'Without objectId: in the slot scopes (sel.ins.N, sel.strip.<module>, sel.inst) the plugin below the slot (an error when the slot is empty or the plugin is not installed); ' +
      'in the other scopes the scope object itself (the selected channel, not its Input Filter). resolvePlugin true descends to the first child object with parameters, false keeps the slot itself. ' +
      'baseObjectId and resolved say which object answered. The filter looks at that object only: many values live in child objects (input gain in "Input Filter", EQ gains in the EQ), ' +
      'so pass searchChildren true to search the object and its children. With a filter (match: contains, exact or regex), offset and limit count the matching parameters and matchedTotal says how many match ' +
      '(total is the object\'s parameter count, or the matches with searchChildren). tag or tags read just those parameters of the object.',
    {
      scope: directScope,
      objectId: z.number().int().optional(),
      resolvePlugin: z.boolean().optional().describe('true: descend to the first child object with parameters; false: the scope object itself (in slot scopes, the slot\'s own controls)'),
      filter: z.string().optional().describe('Only parameters whose title matches this text (see match)'),
      match: matchMode,
      ...tagReads,
      searchChildren: z.boolean().default(false).describe('With filter: search the child objects too (up to 3 levels, 400 objects)'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(150).describe('At most 200 per call: page with offset (total, or matchedTotal with a filter, says how many there are)'),
    },
    async ({ tag, tags, ...args }) => {
      if (args.match !== undefined && args.filter === undefined) throw new Error('match applies to filter: give a filter');
      const asked = tagsOf({ tag, tags, filter: args.filter, offset: args.offset });
      if (asked && args.searchChildren) throw new Error('searchChildren applies to filter, not to tag/tags');
      return client.call('da.params', asked ? { scope: args.scope, objectId: args.objectId, resolvePlugin: args.resolvePlugin, tags: asked } : args, 15000);
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_da_set_parameter',
    'Advanced: sets a parameter of any DirectAccess object. Give exactly one of normalized, display string or valueInUnits (searched like in cubase_set_plugin_parameter: switches take 1/0, a failed search restores the value). ' +
      'The object is chosen like in cubase_da_get_parameters (resolvePlugin). An objectId or tag that does not exist is an error. ' +
      'normalized and display writes answer before (value and display before the write): keep it to write it back, because some DirectAccess writes leave no undo step (a rename through tag 1024 is not in the Edit history); ' +
      'they also say whether Cubase took the write (changed, matches, applied). ' +
      'Cubase ignores writes to a channel output ("Salida", tag 4102). ' +
      DISPLAY_NOTE,
    {
      scope: directScope,
      objectId: z.number().int().optional(),
      resolvePlugin: z.boolean().optional().describe('true: descend to the first child object with parameters; false: the scope object itself'),
      ...parameterSelector,
      normalized: normalized.optional(),
      display: z.string().optional(),
      valueInUnits: z.number().optional(),
    },
    async (args) => {
      const sel = { objectId: args.objectId, resolvePlugin: args.resolvePlugin, ...selector(args) };
      const mode = onlyOne(args, ['normalized', 'display', 'valueInUnits']);
      if (mode === 'valueInUnits') return client.seekDirectParameter(args.scope, sel, args.valueInUnits as number);
      if (mode === 'display') return writeDisplay(args.scope, sel, args.display as string);
      return writeNormalized(args.scope, sel, args.normalized as number);
    },
  );
}
