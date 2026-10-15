import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, sleep, type ToolContext } from './common.js';
import { closeCommands, loadInternalNames, resolveCommand, type CommandEntry } from '../cubase/commands.js';
import type { ValueState } from '../cubase/client.js';

/** Blank names never match a command: rejected here instead of reaching the script. */
const commandText = z.string().trim().min(1);

/**
 * Transport commands that do nothing or toggle when sent as key commands: Transport/Start answered ok in the live
 * test and did not play (Cubase seems to drop the 1-then-0 pulse of a command binding for the transport state,
 * while the value binding tr.start works). They are written as absolute values instead and confirmed.
 * on: the state to set, or 'toggle' for the commands that switch.
 */
const TRANSPORT_VALUES: Record<string, { key: string; on: boolean | 'toggle' }> = {
  'Transport / Start': { key: 'tr.start', on: true },
  'Transport / Stop': { key: 'tr.start', on: false },
  'Transport / StartStop': { key: 'tr.start', on: 'toggle' },
  'Transport / Record': { key: 'tr.record', on: 'toggle' },
  'Transport / Cycle': { key: 'tr.cycle', on: 'toggle' },
  'Transport / Metronome On': { key: 'tr.metronome', on: 'toggle' },
};

/** Wait after a command until a raw value reaches a state or changes (Cubase applies switches 1-8 s late). */
const waitForSchema = z
  .object({
    key: z.string().trim().min(1).describe('Raw value key to watch (see cubase_list_value_keys), e.g. "tr.cycle" or "ch.3.mute"'),
    value: z
      .union([z.number().min(0).max(1), z.string().trim().min(1)])
      .optional()
      .describe('Wait until the key reads this: a normalized value (0..1, within 0.005) or the display text (ignoring case)'),
    changed: z.literal(true).optional().describe('Wait until the key reads something else than before the command'),
    timeoutMs: z.number().int().min(100).max(30000).default(8000),
  })
  .strict()
  .refine((w) => (w.value !== undefined) !== (w.changed === true), { message: 'waitFor needs value or changed: true (one of them)' });

type WaitFor = z.infer<typeof waitForSchema>;

const brief = (state: ValueState) => ({ v: state.v, d: state.d });

const NOT_CONFIRMED_NOTE =
  'Cubase gives no feedback for key commands: sent means the bridge triggered it, not that Cubase did anything (an unknown name in a known category, or a command with nothing to act on, does nothing). Check the result with a read tool.';

export function registerCommandTools(ctx: ToolContext): void {
  const { client, commands } = ctx;
  /** Every Cubase command by internal name, bound or not (read once, when first needed). */
  let internal: CommandEntry[] | null = null;
  const internalNames = () => (internal ??= loadInternalNames(join(ctx.config.projectRoot, 'commands', 'cubase13-internal-names.json')));
  const key = (c: { category: string; name: string }) => `${c.category}\u0000${c.name}`;
  const bound = new Set(commands.map(key));
  const describe = (c: CommandEntry) => `${c.category} / ${c.name}${c.label ? ` (on screen: ${c.label})` : ''}`;

  /**
   * Rejects, before anything is sent, a command the bridge script does not bind (Cubase would get nothing): the error
   * names close bound commands and close Cubase commands that are not bound yet. Without a catalog (no build), it passes.
   */
  function checkBound(category: string, name: string, resolved: { category: string; name: string }) {
    if (commands.length === 0 || bound.has(key(resolved))) return;
    const all = internalNames();
    const known = all.find((c) => c.category === resolved.category && c.name === resolved.name);
    const unbound = all.filter((c) => !bound.has(key(c)));
    const near = closeCommands(commands, category, name);
    const nearUnbound = known ? [] : closeCommands(unbound, category, name, 3);
    const lines = [
      known
        ? `"${category} / ${name}" is a Cubase command, but the bridge script does not bind it, so nothing was sent. To use it, add it to commands/user-commands.txt ([${known.category}] then ${known.name}), run npm run install:script and reload the script in Cubase.`
        : `"${category} / ${name}" is not a command the bridge script binds, so nothing was sent.`,
      near.length > 0 ? `Close commands you can run: ${near.map(describe).join('; ')}.` : 'No close command is bound: search with cubase_list_commands.',
      ...(nearUnbound.length > 0
        ? [`Close Cubase commands that are not bound (add them to commands/user-commands.txt first): ${nearUnbound.map(describe).join('; ')}.`]
        : []),
    ];
    throw new Error(lines.join(' '));
  }

  /** Reads the waitFor key before the command (an unknown key fails before anything is sent). */
  async function waitStart(waitFor: WaitFor | undefined): Promise<ValueState | null> {
    if (!waitFor) return null;
    try {
      return await client.getValue(waitFor.key);
    } catch (error) {
      throw new Error(`waitFor.key: ${(error as Error).message}. List keys with cubase_list_value_keys. Nothing was sent.`);
    }
  }

  /** Polls the waitFor key after the command until it reaches the state (or changed), or the time is up. */
  async function waitState(waitFor: WaitFor, before: ValueState) {
    const started = Date.now();
    const wanted = waitFor.value;
    const accept = (state: ValueState) => {
      if (waitFor.changed) return state.v !== before.v || state.d !== before.d;
      if (typeof wanted === 'number') return state.v !== null && Math.abs(state.v - wanted) <= 0.005;
      return (state.d ?? '').trim().toLowerCase() === String(wanted).toLowerCase();
    };
    const result = await client.waitForValue(waitFor.key, accept, waitFor.timeoutMs);
    return {
      key: waitFor.key,
      ...(waitFor.changed ? { changed: true } : { value: wanted }),
      reached: result.confirmed,
      ...(result.confirmed ? {} : { timedOut: true }),
      waitedMs: Date.now() - started,
      before: brief(before),
      after: brief(result.state),
    };
  }

  /**
   * Sends the internal name (Cubase ignores on-screen labels without any error). The transport commands of
   * TRANSPORT_VALUES are written as values and confirmed instead.
   */
  async function runResolved(category: string, name: string, waitFor?: WaitFor): Promise<Record<string, unknown>> {
    const command = resolveCommand(commands, category, name);
    checkBound(category, name, command);
    const before = await waitStart(waitFor);
    const result = await runChecked(command);
    if (waitFor && before) result.waitFor = await waitState(waitFor, before);
    return result;
  }

  async function runChecked(command: { category: string; name: string; from?: string }): Promise<Record<string, unknown>> {
    const label = `${command.category} / ${command.name}`;
    const from = command.from ? { from: command.from } : {};
    const value = TRANSPORT_VALUES[label];
    if (value) {
      return client.measurement(async () => {
        let on = value.on;
        if (on === 'toggle') {
          const now = await client.getValue(value.key);
          on = !(now.v !== null && now.v > 0.5);
        }
        if (value.key === 'tr.start' && !on) {
          const stopped = await client.stopTransport();
          return { category: command.category, name: command.name, ...from, via: 'tr.stop', state: stopped ? false : null, applied: stopped ? 'confirmed' : 'unconfirmed' };
        }
        const result = await client.setBool(value.key, on);
        return { category: command.category, name: command.name, ...from, via: value.key, state: result.state, applied: result.applied };
      });
    }
    await client.runCommand(command.category, command.name);
    return { category: command.category, name: command.name, ...from, sent: true, confirmed: false };
  }

  defineTool(
    ctx,
    'cubase_list_commands',
    `Searches the Cubase key commands the bridge can trigger (${commands.length || 'about 600'} bound: built-in plus your macros and Logical Editor presets from commands/user-commands.txt). ` +
      'category and name are Cubase internal names; label is the name shown on screen when it differs (both work in cubase_run_command). ' +
      'Both filters ignore case: category matches a whole category name (internal or on-screen), search matches part of "Category / Name" or of the label. ' +
      'includeUnbound also searches the Cubase 13 commands the script does not bind (about 1,450 in all) and marks each result inCatalog: only inCatalog commands can run; ' +
      'the others need adding to commands/user-commands.txt, npm run install:script and a reload of the script.',
    {
      category: z.string().optional().describe('Whole category name, internal or on-screen, ignoring case: "mixer" finds "Mixer", "Mix" finds nothing'),
      search: z.string().optional().describe('Text to find anywhere in "Category / Name" or in the on-screen label, ignoring case'),
      includeUnbound: z.boolean().default(false).describe('Also list Cubase commands the bridge script does not bind (inCatalog: false)'),
      limit: z.number().int().min(1).max(600).default(100),
    },
    async ({ category, search, includeUnbound, limit }) => {
      const needle = search?.toLowerCase();
      const wanted = category?.toLowerCase();
      const pool: Array<CommandEntry & { inCatalog?: boolean }> = includeUnbound
        ? [...commands.map((c) => ({ ...c, inCatalog: true })), ...internalNames().filter((c) => !bound.has(key(c))).map((c) => ({ ...c, inCatalog: false }))]
        : commands;
      const matches = pool.filter((c) => {
        const label = c.label?.toLowerCase() ?? '';
        const inCategory = !wanted || c.category.toLowerCase() === wanted || label.startsWith(`${wanted} / `);
        const found = !needle || `${c.category} / ${c.name}`.toLowerCase().includes(needle) || label.includes(needle);
        return inCategory && found;
      });
      const categories = [...new Set(pool.map((c) => c.category))];
      return {
        total: matches.length,
        ...(includeUnbound ? { notInCatalog: matches.filter((c) => !c.inCatalog).length } : {}),
        categories: category || search ? undefined : categories,
        commands: matches.slice(0, limit),
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_run_command',
    'Runs a Cubase key command by category and name, as listed by cubase_list_commands (internal name or on-screen label; the exact name first, then ignoring case). ' +
      'A name the bridge script does not bind is an error before anything is sent, listing close commands (bound, and Cubase commands not bound yet). ' +
      'Cubase gives no feedback: the answer says sent, confirmed: false, so check the result with a read tool, or pass waitFor ({key, value | changed: true, timeoutMs}) to poll a raw value after the command ' +
      'until it reads that value (normalized, or display text) or changes: waitFor.reached says whether it did before timeoutMs. ' +
      'Transport Start, Stop, StartStop, Record, Cycle and Metronome On are written as transport values instead (via) and wait for Cubase to report the new state (applied), because the key commands do not start playback or toggle. ' +
      'Other switches show their new state 1-8 s later: read again after a while instead of running a toggle command again, which would switch it back. A timeout means the reply was lost, not that the command did not run: it is never resent. ' +
      'Commands that open windows or dialogs only work with Cubase in front and need the UI tools or a human to finish them. Commands can change or delete project data.',
    { category: commandText, name: commandText, waitFor: waitForSchema.optional() },
    async ({ category, name, waitFor }) => {
      const result = await runResolved(category, name, waitFor);
      return result.sent && !(result.waitFor as { reached?: boolean } | undefined)?.reached ? { ...result, note: NOT_CONFIRMED_NOTE } : result;
    },
    { destructive: true },
  );

  defineTool(
    ctx,
    'cubase_run_command_sequence',
    'Runs several key commands in order, with an optional pause after each (e.g. select tracks, then create a group channel for them). Same rules as cubase_run_command: ' +
      'each step says sent (Cubase does not confirm key commands) or, for the transport commands written as values, applied; ok: false with error when it could not be sent ' +
      '(an unbound name included: with stopOnError nothing after it is sent). A step can wait for a raw value with waitFor (see cubase_run_command) before its waitMs pause; ' +
      'with stopOnError, a waitFor that times out also stops the sequence (stoppedBy says why).',
    {
      steps: z
        .array(
          z
            .object({ category: commandText, name: commandText, waitMs: z.number().int().min(0).max(10000).default(150), waitFor: waitForSchema.optional() })
            .strict(),
        )
        .min(1)
        .max(50),
      stopOnError: z.boolean().default(true),
    },
    async ({ steps, stopOnError }) => {
      const results = [];
      let stoppedBy: string | undefined;
      for (const [i, step] of steps.entries()) {
        const { waitFor, ...shown } = step;
        try {
          const sent = await runResolved(step.category, step.name, waitFor);
          const { category: _c, name: _n, ...rest } = sent;
          results.push({ ...shown, ok: true, ...rest, ...(sent.from ? { command: `${sent.category} / ${sent.name}` } : {}) });
          if (stopOnError && (rest.waitFor as { reached?: boolean } | undefined)?.reached === false) {
            stoppedBy = `step ${i + 1}: waitFor ${waitFor?.key} timed out`;
            break;
          }
        } catch (error) {
          results.push({ ...shown, ok: false, error: error instanceof Error ? error.message : String(error) });
          if (stopOnError) {
            stoppedBy = `step ${i + 1}: error`;
            break;
          }
        }
        await sleep(step.waitMs);
      }
      return { results, ...(stoppedBy ? { stoppedBy } : {}), note: NOT_CONFIRMED_NOTE };
    },
    { destructive: true },
  );
}
