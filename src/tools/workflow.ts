import { z } from 'zod';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { channelRef, defineTool, readChannelList, sleep, SOLO_MASK_NOTE, type ToolContext } from './common.js';
import { OUTPUT_TAG, type MixerChannelInfo, type SnapshotPage, type WriteRecord } from '../cubase/client.js';
import type { MacUi, MenuItemInfo } from '../ui/macos.js';

const ADD_TRACK_DIALOG = /a[ñn]adir pista|add track|spur hinzuf/i;
const EXPORT_WINDOW = /export/i;
const EDIT_MENU = /^(edici[oó]n|edit|bearbeiten|[ée]dition|modifica)$/i;
const UNDO_ITEM = /^(deshacer|undo|rückgängig|annuler|annulla)\b/i;
const REDO_ITEM = /^(rehacer|redo|wiederherstellen|rétablir|ripristina)\b/i;
const AUDIO_EXTENSIONS = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.ogg', '.w64', '.caf']);

/** A selected channel and the output it had when a bus was created for it. */
interface SourceRouting {
  channel: string;
  index: number;
  uid: string | null;
  output: string | null;
}

type BankSlotLike = { index: number; title: string; uid: string | null };

function outputDisplay(channel: MixerChannelInfo | undefined): string | null {
  return channel?.params?.[OUTPUT_TAG]?.display ?? null;
}

/** The Undo and Redo items of Cubase's Edit menu ("Deshacer Añadir pista"), found by their localized names. */
async function editMenuLabels(ui: MacUi): Promise<{ undo: MenuItemInfo | null; redo: MenuItemInfo | null } | null> {
  const bar = await ui.listMenu([]);
  const edit = bar.items.find((item) => EDIT_MENU.test(item.name.trim()));
  if (!edit) return null;
  const { items } = await ui.listMenu([edit.name]);
  return { undo: items.find((item) => UNDO_ITEM.test(item.name)) ?? null, redo: items.find((item) => REDO_ITEM.test(item.name)) ?? null };
}

/** "Deshacer Añadir pista" -> "Añadir pista". */
function stepName(label: string): string {
  return label.replace(UNDO_ITEM, '').replace(REDO_ITEM, '').trim() || label;
}

/** Polls the title of Cubase's front window until it matches (title) or the time is up (null). */
async function waitForWindow(ui: MacUi, pattern: RegExp, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(400);
    const state = await ui.state().catch(() => null);
    const title = state?.windows.find((w) => pattern.test(w.title))?.title;
    if (title !== undefined) return title;
    if (Date.now() >= deadline) return null;
  }
}

/** A channel whose mix values changed (uid only to tell channels apart: results leave it out). */
interface ChangedChannel {
  channel: string;
  index: number;
  uid: string | null;
  fields: string[];
}

type PageDiff = { changed: ChangedChannel[]; added: string[]; removed: string[] };

function emptyDiff(): PageDiff {
  return { changed: [], added: [], removed: [] };
}

const diffSize = (diff: PageDiff) => diff.changed.length + diff.added.length + diff.removed.length;

/** "volume of "Snare"; pre.gain of "Kick"; added "Group 1"". */
function describeDiff(diff: PageDiff): string {
  return [
    ...diff.changed.map((c) => `${c.fields.join(', ')} of "${c.channel}"`),
    ...diff.added.map((title) => `added "${title}"`),
    ...diff.removed.map((title) => `removed "${title}"`),
  ].join('; ');
}

/** Whether a write this server made is to a channel of the diff: by uid, else by name (and bank index when known). */
function sameChannel(write: WriteRecord, changed: ChangedChannel): boolean {
  if (write.uid && changed.uid) return write.uid === changed.uid;
  if (write.channel === null) return write.index === changed.index;
  return write.channel === changed.channel && (write.index === null || write.index === changed.index);
}

const writeLabel = (write: WriteRecord) => `${write.field} of ${write.channel === null ? `bank slot ${write.index}` : `"${write.channel}"`}`;

/** Why the last history step is not always the last write of this server. */
const HISTORY_STEPS_NOTE =
  'Writes made by searches (the dB, Hz and pan targets of cubase_set_volume, cubase_set_pan, cubase_apply_mix, cubase_set_input_gain...) may leave no MixConsole History step, ' +
  'and changes made by hand in Cubase add steps, so the last step is not always the last value this server wrote.';
const SAFE_REVERT_NOTE = 'The safe way to revert values this server wrote is a snapshot: cubase_snapshot_mix before the change, cubase_restore_mix after it.';

/** Mix values of a bank page before and after, by uid (title and index without one). */
function diffPages(before: SnapshotPage, after: SnapshotPage) {
  const diff = emptyDiff();
  const id = (c: SnapshotPage['channels'][number]) => c.uid ?? `${c.index}:${c.title}`;
  const old = new Map(before.channels.map((c) => [id(c), c]));
  const seen = new Set<string>();
  for (const channel of after.channels) {
    const previous = old.get(id(channel));
    if (!previous) {
      diff.added.push(channel.title);
      continue;
    }
    seen.add(id(channel));
    const fields = after.fields.filter((field, f) => {
      const a = previous.values[before.fields.indexOf(field)] ?? null;
      const b = channel.values[f];
      return a !== b && (a === null || b === null || Math.abs(a - b) > 1e-4);
    });
    if (fields.length > 0) diff.changed.push({ channel: channel.title, index: channel.index, uid: channel.uid, fields });
  }
  for (const channel of before.channels) if (!seen.has(id(channel))) diff.removed.push(channel.title);
  return diff;
}

/** The date of a project file and the .cpr files next to it. */
async function projectFiles(file: string): Promise<{ mtimeMs: number | null; versions: Set<string> }> {
  const mtimeMs = await stat(file)
    .then((s) => s.mtimeMs)
    .catch(() => null);
  const versions = new Set(
    (await readdir(dirname(file)).catch(() => [] as string[])).filter((name) => extname(name).toLowerCase() === extname(file).toLowerCase() || extname(name).toLowerCase() === '.cpr'),
  );
  return { mtimeMs, versions };
}

/** Audio files of a folder with their size and date. */
async function audioFiles(folder: string): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const out = new Map<string, { size: number; mtimeMs: number }>();
  for (const name of await readdir(folder)) {
    if (!AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const info = await stat(join(folder, name)).catch(() => null);
    if (info?.isFile()) out.set(name, { size: info.size, mtimeMs: info.mtimeMs });
  }
  return out;
}

/** Waits for new or changed audio files in the export folder, until their sizes stop growing or the time is up. */
async function waitForExport(folder: string, before: Map<string, { size: number; mtimeMs: number }>, waitSeconds: number) {
  const deadline = Date.now() + waitSeconds * 1000;
  let last = '';
  let files: Array<{ name: string; size: number }> = [];
  for (;;) {
    const now = await audioFiles(folder);
    files = [...now]
      .filter(([name, info]) => {
        const old = before.get(name);
        return !old || old.mtimeMs !== info.mtimeMs || old.size !== info.size;
      })
      .map(([name, info]) => ({ name: basename(name), size: info.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const signature = JSON.stringify(files);
    // Done when there are files and two reads in a row agree (Cubase writes them while it renders).
    if (files.length > 0 && signature === last) return { files, stillGrowing: false };
    last = signature;
    if (Date.now() >= deadline) return { files, stillGrowing: files.length > 0 };
    await sleep(Math.min(1000, Math.max(50, deadline - Date.now())));
  }
}

async function readWorkflow(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return `# Mixing workflow\n\nNo workflow file found at ${file}. Copy workflow/mix-workflow.md and describe your process there.`;
  }
}

export function registerWorkflowTools(ctx: ToolContext): void {
  const { client, server, config, commands } = ctx;

  server.registerResource(
    'mix-workflow',
    'cubase://workflow',
    { title: 'Mixing workflow', description: "The user's mixing workflow and rules the agent must follow", mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readWorkflow(config.workflowFile) }] }),
  );

  server.registerResource(
    'command-catalog',
    'cubase://commands',
    { title: 'Cubase key commands', description: 'Key commands the bridge can trigger', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(commands) }],
    }),
  );

  server.registerResource(
    'mixer-state',
    'cubase://mixer',
    {
      title: 'Current mixer state',
      description:
        'Channels of the current mixer bank page with fader, pan, mute and solo, compactly. For more fields, other pages or one channel in full use cubase_list_channels and cubase_get_channel.',
      mimeType: 'application/json',
    },
    async (uri) => {
      // Small reads of four fields: the whole bank with values (~150 KB) stalls MIDI Remote.
      const list = await readChannelList(client, { fields: ['volume', 'pan', 'mute', 'solo'] });
      const text = JSON.stringify({
        bankSize: list.bankSize,
        count: list.total,
        ...(list.soloActive ? { soloActive: true, note: SOLO_MASK_NOTE } : {}),
        channels: list.channels,
      });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );

  server.registerPrompt(
    'mix_session',
    {
      title: 'Mix the current Cubase project',
      description: 'Runs the full technical mix pass following the saved workflow, leaving creative decisions to the user.',
      argsSchema: {
        // Trimmed so a blank argument drops its line instead of sending an empty path to the agent.
        genre: z.string().trim().optional(),
        reference: z.string().trim().optional().describe('Absolute path to a reference track'),
        stemsFolder: z.string().trim().optional().describe('Folder where Cubase exports the stems'),
      },
    },
    async ({ genre, reference, stemsFolder }) => {
      const workflow = await readWorkflow(config.workflowFile);
      const text = [
        'You are mixing the project currently open in Cubase through the cubase_* tools.',
        'Follow the workflow below step by step. Before every destructive step, save a snapshot with cubase_snapshot_mix.',
        'Use measurements (cubase_measure_levels, audio_analyze_folder, audio_compare_to_reference) to justify every change, and report what you changed and why.',
        'Stop and ask before anything that is a creative decision (arrangement, muting parts, effects as sound design).',
        genre ? `Genre: ${genre}.` : '',
        reference ? `Reference track: ${reference}.` : '',
        stemsFolder ? `Stems folder: ${stemsFolder}.` : '',
        '',
        '--- WORKFLOW ---',
        workflow,
      ]
        .filter(Boolean)
        .join('\n');
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    },
  );

  defineTool(
    ctx,
    'cubase_get_workflow',
    'Returns the saved mixing workflow (rules, order of steps, targets) the agent should follow. Edit workflow/mix-workflow.md to change it.',
    {},
    async () => ({ file: config.workflowFile, workflow: await readWorkflow(config.workflowFile) }),
    { readOnly: true },
  );

  /**
   * The last bus created with cubase_create_bus_for_selection: the outputs its source channels had before, for when
   * an undo loses them. Kept in a file too, so a server restarted between the creation and the undo still has it.
   */
  type LastBus = { type: string; created: Array<Record<string, unknown>>; sources: SourceRouting[]; createdAt: string };
  const lastBusFile = config.snapshotDir ? join(dirname(config.snapshotDir), 'last-bus.json') : null;
  let lastBus: LastBus | null = null;
  const rememberBus = async (bus: LastBus | null) => {
    lastBus = bus;
    if (!lastBusFile) return;
    if (bus) {
      await mkdir(dirname(lastBusFile), { recursive: true }).catch(() => undefined);
      await writeFile(lastBusFile, JSON.stringify(bus, null, 2)).catch(() => undefined);
    } else {
      await unlink(lastBusFile).catch(() => undefined);
    }
  };
  const recallBus = async (): Promise<LastBus | null> =>
    lastBus ??
    (lastBusFile === null
      ? null
      : await readFile(lastBusFile, 'utf8')
      .then((text) => JSON.parse(text) as LastBus)
      .catch(() => null));

  defineTool(
    ctx,
    'cubase_save_project',
    'Saves the project (File > Save) or a new version (File > Save New Version). Cubase does not confirm saves: pass projectFile (the absolute path of the .cpr) to check that the file was written ' +
      '(its date for a save, a new .cpr next to it for a new version); without it the answer says verified: false. Cubase writes nothing when the project has no changes, and a project never saved opens the Save As dialog.',
    {
      newVersion: z.boolean().default(false),
      projectFile: z.string().trim().min(1).optional().describe('Absolute path of the project .cpr, to check that Cubase wrote it'),
      waitSeconds: z.number().min(0).max(120).default(10).describe('With projectFile: how long to wait for the file to change'),
    },
    async ({ newVersion, projectFile, waitSeconds }) => {
      const name = newVersion ? 'Save New Version' : 'Save';
      if (projectFile && !isAbsolute(projectFile)) throw new Error('projectFile must be an absolute path to the .cpr');
      const before = projectFile ? await projectFiles(projectFile) : null;
      await client.runCommand('File', newVersion ? 'Save New Version' : 'Save');
      if (!projectFile || !before) {
        return {
          command: `File / ${name}`,
          sent: true,
          verified: false,
          note: 'Cubase does not confirm saves. Pass projectFile (the .cpr path) to check the file, or look at the project window title (an asterisk marks unsaved changes).',
        };
      }
      const deadline = Date.now() + waitSeconds * 1000;
      for (;;) {
        await sleep(500);
        const now = await projectFiles(projectFile);
        if (!newVersion && now.mtimeMs !== null && now.mtimeMs !== before.mtimeMs) {
          return { command: `File / ${name}`, sent: true, verified: true, file: projectFile, modified: new Date(now.mtimeMs).toISOString() };
        }
        const added = [...now.versions].filter((file) => !before.versions.has(file));
        if (newVersion && added.length > 0) return { command: `File / ${name}`, sent: true, verified: true, newFiles: added.sort() };
        if (Date.now() >= deadline) {
          return {
            command: `File / ${name}`,
            sent: true,
            verified: false,
            note:
              `${newVersion ? 'No new .cpr appeared next to' : 'The date of'} ${projectFile} ${newVersion ? '' : 'did not change '}in ${waitSeconds} s: Cubase skips a save without changes, ` +
              'a dialog may be open (Save As for a project never saved), or the path is not the open project.',
          };
        }
      }
    },
    { destructive: true },
  );

  defineTool(
    ctx,
    'cubase_undo',
    'Undoes (or redoes) the last edit (scope "edit": Edit > Undo) or the last MixConsole step (scope "mixconsole", the default: MixConsole History). Cubase ignores an undo with an empty history and says nothing, so the tool reports what changed: ' +
      'the mix values of the bank page shown now before and after (changed, added, removed channels) and, for scope "edit" with UI automation on, the Edit menu item ("Undo <step>": step), and it sends nothing when that item is disabled; ' +
      'afterwards it reads the menu again: stepAfter is the step the next undo (redo) would revert (null when there is none), menuAfter the Undo and Redo items as Cubase shows them. ' +
      'The last MixConsole History step is not always the last value this server wrote: writes made by searches (the dB, Hz and pan targets of cubase_set_volume, cubase_set_pan, cubase_apply_mix...) may leave no step, and changes made by hand add steps. ' +
      'So pass expect ({channel, field}: the change you mean to revert): when the bank page shows a different change, the tool sends the opposite command at once (a redo after an undo) and returns an error; ' +
      'when nothing changed on the page it sends nothing more and returns an error. Without expect, a MixConsole undo whose changes are not the last mix value this server wrote (it remembers its last 20 writes) gets a warning naming both (lastWrite). ' +
      'To revert values written by this server, cubase_snapshot_mix before the change and cubase_restore_mix after it is the safe way. ' +
      'Limits of Cubase: the MixConsole history does not record mute or solo (use cubase_set_channel_state or cubase_restore_mix for them), so an undo after a mute reverts an older step such as a fader move; ' +
      'a rename through DirectAccess is not in the Edit history; undoing a group created for the selection (cubase_create_bus_for_selection) deletes it but leaves its source tracks on "No Bus" without restoring their output, ' +
      'and no tool can set an output: the answer then lists the outputs saved when the bus was created, to set by hand.',
    {
      scope: z.enum(['edit', 'mixconsole']).default('mixconsole'),
      redo: z.boolean().default(false),
      verify: z.boolean().default(true).describe('Compare the mix values of the bank page before and after (a few small reads)'),
      expect: z
        .object({
          channel: channelRef.optional().describe('Channel whose value the step should change: a bank index on the page shown now, or a name on that page'),
          field: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe('Field it should change, named like the changed list: volume, pan, pre.gain, pre.phase, pre.lowCutOn, pre.lowCutFreq, send.N.level, send.N.on (N = send slot - 1)'),
        })
        .strict()
        .refine((e) => e.channel !== undefined || e.field !== undefined, { message: 'expect needs channel, field or both' })
        .optional()
        .describe('The change this undo (or redo) should make. Anything else is reverted at once and reported as an error. Needs verify, and the channel on the bank page shown now.'),
    },
    async ({ scope, redo, verify, expect }) => {
      const verb = redo ? 'redo' : 'undo';
      const command = scope === 'mixconsole' ? (redo ? 'Redo MixConsole Step' : 'Undo MixConsole Step') : redo ? 'Redo' : 'Undo';
      const opposite = scope === 'mixconsole' ? (redo ? 'Undo MixConsole Step' : 'Redo MixConsole Step') : redo ? 'Undo' : 'Redo';
      const category = scope === 'mixconsole' ? 'MixConsole History' : 'Edit';
      const history = scope === 'mixconsole' ? 'MixConsole' : 'Edit';
      // The expected change is checked before anything is sent.
      let expected: { title: string; uid: string | null; index: number } | null = null;
      if (expect) {
        if (!verify) throw new Error('expect needs verify: the change is checked by comparing the mix values of the bank page before and after. Nothing was sent.');
        if (expect.channel !== undefined) {
          try {
            const channel = await client.resolveOnCurrentPage(expect.channel);
            expected = { title: channel.title, uid: channel.uid, index: channel.index };
          } catch (error) {
            throw new Error(
              `expect.channel: ${(error as Error).message} The ${verb} is checked on the bank page shown now: show that channel's page with cubase_bank first. Nothing was sent.`,
            );
          }
        }
      }
      let menuItem: MenuItemInfo | null = null;
      if (scope === 'edit' && config.enableUiAutomation) {
        // macOS disables the menu items of an app in the background: "Deshacer X" then reads as disabled (live, 15 Oct 2026).
        await ctx.ui.activate().catch(() => undefined);
        const labels = await editMenuLabels(ctx.ui).catch(() => null);
        menuItem = labels ? (redo ? labels.redo : labels.undo) : null;
        if (menuItem && !menuItem.enabled) {
          return { scope, redo, sent: false, undone: false, menuItem: menuItem.name, reason: `Edit > "${menuItem.name}" is disabled: there is nothing to ${verb}.` };
        }
      }
      const before = verify ? await client.readSnapshotPage().catch(() => null) : null;
      if (expect && !before) throw new Error(`The mix values of the bank page could not be read, so the ${verb} cannot be checked against expect. Nothing was sent.`);
      if (expect?.field && before && !before.fields.includes(expect.field)) {
        throw new Error(`expect.field "${expect.field}" is not a mix field: use one of ${before.fields.join(', ')}. Nothing was sent.`);
      }
      /** The bank page's mix values compared with `before` until something changed (or `until` holds). */
      const compare = async (until: (diff: PageDiff) => boolean) => {
        let diff = emptyDiff();
        let after: SnapshotPage | null = null;
        for (let attempt = 0; attempt < 4 && before; attempt++) {
          await sleep(250 * (attempt + 1));
          after = await client.readSnapshotPage().catch(() => null);
          if (!after) break;
          diff = diffPages(before, after);
          if (until(diff)) break;
        }
        // A track added or removed shifts the bank: Cubase moves titles and ids first and the values of each slot
        // a moment later (live, 15 Oct 2026), so read until two pages agree before comparing by unique id.
        if (before && after && (diff.added.length > 0 || diff.removed.length > 0)) {
          for (let attempt = 0; attempt < 6; attempt++) {
            await sleep(500);
            const again = await client.readSnapshotPage().catch(() => null);
            if (!again) break;
            const settled = diffSize(diffPages(after, again)) === 0;
            after = again;
            if (settled) break;
          }
          diff = diffPages(before, after);
        }
        return diff;
      };
      await client.runCommand(category, command);
      const out: Record<string, unknown> = { scope, redo, command: `${category} / ${command}`, sent: true };
      if (menuItem) out.step = stepName(menuItem.name);
      if (before) {
        const diff = await compare((d) => diffSize(d) > 0);
        Object.assign(
          out,
          diff.changed.length ? { changed: diff.changed.map(({ uid: _uid, ...changed }) => changed) } : {},
          diff.added.length ? { added: diff.added } : {},
          diff.removed.length ? { removed: diff.removed } : {},
        );
        const any = diffSize(diff) > 0;
        out.undone = any ? true : menuItem ? true : null;
        if (!any) {
          out.note =
            `Nothing changed on the bank page shown now. The ${history} history may have been empty (Cubase then does nothing and says nothing), ` +
            'or the step was somewhere this cannot see (other bank pages, plugins, routing, track edits).';
        }
        if (expect) {
          const wanted = `${expect.field ?? 'a value'} of ${expected ? `"${expected.title}"` : 'any channel'}`;
          if (!any) {
            throw new Error(
              `Expected the ${verb} to change ${wanted}, but nothing changed on the bank page shown now: the ${history} history may have been empty, ` +
                `or its last step was somewhere this cannot see (another bank page, plugins). Nothing else was sent, since it is not known whether anything changed. ${SAFE_REVERT_NOTE}`,
            );
          }
          const fits = (changed: ChangedChannel, field: string) =>
            (!expected || (expected.uid && changed.uid ? expected.uid === changed.uid : changed.index === expected.index && changed.channel === expected.title)) &&
            (!expect.field || field === expect.field);
          const pairs = diff.changed.flatMap((changed) => changed.fields.map((field) => fits(changed, field)));
          const met = pairs.length > 0 && pairs.every(Boolean) && diff.added.length === 0 && diff.removed.length === 0;
          if (!met) {
            // Put the other change back at once.
            await client.runCommand(category, opposite);
            let back = diffSize(await compare((d) => diffSize(d) === 0)) === 0;
            // Live (15 Oct 2026) the opposite command did not bring the value back: write the values from before directly.
            let rewritten = false;
            if (!back && before) {
              const writes = diff.changed.flatMap((changed) => {
                const previous = before.channels.find((c) => (changed.uid && c.uid ? c.uid === changed.uid : c.index === changed.index));
                return previous
                  ? changed.fields
                      .map((field) => ({ key: `ch.${previous.index}.${field}`, value: previous.values[before.fields.indexOf(field)] ?? null }))
                      .filter((item): item is { key: string; value: number } => item.value !== null)
                  : [];
              });
              if (writes.length > 0) {
                await client.setValues(writes).catch(() => undefined);
                back = diffSize(await compare((d) => diffSize(d) === 0)) === 0;
                rewritten = back;
              }
            }
            throw new Error(
              `The ${history} history's last step was a different change: the ${verb} changed ${describeDiff(diff)} instead of ${wanted}. ` +
                (back
                  ? rewritten
                    ? `${category} / ${opposite} did not bring it back, so the values from before the ${verb} were written again and the bank page shows them. `
                    : `${category} / ${opposite} was sent at once and the bank page shows its values from before the ${verb} again. `
                  : `${category} / ${opposite} was sent and the values from before the ${verb} were written again, but the bank page does not show them yet: check them with cubase_get_channel. `) +
                `${HISTORY_STEPS_NOTE} ${SAFE_REVERT_NOTE}`,
            );
          }
          out.expectMet = true;
        }
        // The change an undo reverted is no longer the last write; an undo that reverted something else is flagged.
        if (scope === 'mixconsole' && !redo && diff.changed.length > 0) {
          const writes = client.recentWrites().filter((w) => w.field !== 'mute' && w.field !== 'solo'); // not in the MixConsole History
          const reverted = (write: WriteRecord) => diff.changed.some((c) => c.fields.includes(write.field) && sameChannel(write, c));
          const last = writes[writes.length - 1];
          const older = [...writes].reverse().find(reverted);
          if (last && !expect && !reverted(last)) {
            const ago = (write: WriteRecord) => Math.round((Date.now() - write.at) / 1000);
            out.lastWrite = { channel: last.channel, index: last.index, field: last.field, secondsAgo: ago(last) };
            out.warning =
              `This undo changed ${describeDiff(diff)}, but the last mix value this server wrote was ${writeLabel(last)} (${ago(last)} s ago)` +
              (older ? `; what changed matches an older write of this server (${writeLabel(older)}, ${ago(older)} s ago). ` : ', and nothing this server wrote recently. ') +
              `${HISTORY_STEPS_NOTE} If this was not the step you meant, put it back with cubase_undo redo: true, and pass expect to have the step checked. ${SAFE_REVERT_NOTE}`;
          }
          if (older) client.forgetWrite(older);
        }
      } else {
        out.undone = menuItem ? true : null;
        out.note = 'Cubase does not confirm undo: read the values you expect to change.';
      }
      // What the Edit menu offers now: the next step an undo (or redo) would revert.
      if (menuItem) {
        const labels = await editMenuLabels(ctx.ui).catch(() => null);
        const next = labels ? (redo ? labels.redo : labels.undo) : null;
        out.stepAfter = next ? (next.enabled ? stepName(next.name) : null) : undefined;
        if (labels) {
          out.menuAfter = {
            undo: labels.undo ? { label: labels.undo.name, enabled: labels.undo.enabled } : null,
            redo: labels.redo ? { label: labels.redo.name, enabled: labels.redo.enabled } : null,
          };
          // The step is now on the other side of the menu: it was undone (or redone), even when it is not a mixer change.
          const other = redo ? labels.undo : labels.redo;
          if (other?.enabled && stepName(other.name) === stepName(menuItem.name) && typeof out.note === 'string' && out.note.startsWith('Nothing changed')) {
            out.undone = true;
            out.note = `"${stepName(menuItem.name)}" was ${redo ? 'redone' : 'undone'} (the Edit menu now offers to ${redo ? 'undo' : 'redo'} it); it is not a change the bank page shows.`;
          }
        }
      }
      // Undoing a bus creation leaves the sources on "No Bus".
      // Group and FX channels are an "Añadir pista" step; a VCA fader is "Crear grupo enlazado" (live, 15 Oct 2026).
      const busStep = menuItem ? /a[ñn]adir pista|add track|crear grupo enlazado|create linked group/i.test(menuItem.name) : true;
      const bus = scope === 'edit' && !redo && busStep ? await recallBus() : null;
      if (bus) {
        // Read where the sources go now (the bank may have shifted back, so match them by unique id).
        const routing = await client.mixerChannels([OUTPUT_TAG]).catch(() => null);
        const page = routing ? await client.pageChannels().catch(() => null) : null;
        const savedRouting = bus.sources.map((source) => {
          const slot = page?.slots.find((a) => a.uid !== null && a.uid === source.uid);
          return slot && routing ? { ...source, indexNow: slot.index, outputNow: outputDisplay(routing.get(slot.index)) } : source;
        });
        const lost = savedRouting.filter((s) => 'outputNow' in s && s.outputNow !== s.output);
        const checked = savedRouting.every((s) => 'outputNow' in s);
        // A VCA fader never reroutes its sources; for the others, nothing to warn about when their outputs are unchanged.
        if ((bus.type === 'vca' && lost.length === 0) || (checked && lost.length === 0)) {
          await rememberBus(null);
          return out;
        }
        out.routingWarning =
          `This undid the ${bus.type} channel created with cubase_create_bus_for_selection (${bus.createdAt}). ` +
          (lost.length > 0
            ? `Cubase left ${lost.map((s) => `"${s.channel}" on "${(s as { outputNow?: string }).outputNow}"`).join(', ')} instead of the output it had before. `
            : 'Cubase usually leaves its source channels on "No Bus" instead of their old output: check them. ') +
          'Outputs cannot be set through the API: set them back by hand in Cubase (savedRouting has the outputs from before).';
        out.savedRouting = savedRouting;
        await rememberBus(null);
      }
      return out;
    },
    { destructive: true },
  );

  defineTool(
    ctx,
    'cubase_create_bus_for_selection',
    'Creates a Group channel, FX channel or VCA fader for the tracks selected in Cubase (Mixer > Add Track To Selected). Select the tracks first (in Cubase, or cubase_focus_channel for one). ' +
      'For group and FX channels Cubase opens the modal "Add Track" dialog: with UI automation on the tool brings Cubase to the front, sees the dialog and confirms it with Return (confirmDialog: false leaves it open and says dialog-open); ' +
      'without it, confirm it in Cubase. The answer gives the new channel (created: type, name, index) and indexShift: Cubase inserts it in the middle of the MixConsole, so the bank indexes after it move up by one ' +
      '(list the channels again before using indexes). sources lists the selected channels of the bank page with their output before (DirectAccess "Output"): a group takes their output, and undoing the group leaves them on "No Bus" (see cubase_undo). ' +
      'name renames the new channel through DirectAccess once it is created (rename says whether the bank shows the new name; without DirectAccess it reports an error and the channel keeps Cubase\'s name). ' +
      'Mono or stereo, the output and an effect plugin for the new channel cannot be chosen through the API: Cubase takes them from its "Add Track" dialog (its last settings when the dialog is confirmed with Return), so change them there or in the MixConsole afterwards.',
    {
      type: z.enum(['group', 'fx', 'vca']),
      confirmDialog: z.boolean().default(true),
      name: z.string().trim().min(1).max(64).optional().describe('Name for the new channel (renamed through DirectAccess after it is created)'),
    },
    async ({ type, confirmDialog, name: newName }) => {
      const name = { group: 'Add Track To Selected: Group Channel', fx: 'Add Track To Selected: FX Channel', vca: 'Add Track To Selected: VCA Fader' }[type];
      const before = await client.pageChannels();
      const selection = await client.selectionInfo().catch(() => null);
      const routingBefore = await client.mixerChannels([OUTPUT_TAG]).catch(() => null);
      const uidOf = new Map(before.slots.map((s) => [s.index, s.uid]));
      const sources: SourceRouting[] = (selection?.bankSelected ?? []).map((s) => ({
        channel: s.title,
        index: s.index,
        uid: uidOf.get(s.index) ?? null,
        output: outputDisplay(routingBefore?.get(s.index)),
      }));
      const warnings: string[] = [];
      if (sources.length === 0) warnings.push('No channel of the bank page shown now is selected: Cubase uses the tracks selected in the project (maybe none).');
      if (!routingBefore) warnings.push('The outputs could not be read (DirectAccess off or an older bridge script): reload the script to keep them for an undo.');

      // Commands that open windows only work with Cubase in front.
      if (config.enableUiAutomation) await ctx.ui.activate().catch(() => undefined);
      await client.runCommand('Mixer', name);

      let dialog: { title: string; confirmed: boolean } | null = null;
      if (config.enableUiAutomation && type !== 'vca') {
        const title = await waitForWindow(ctx.ui, ADD_TRACK_DIALOG, 3000);
        if (title !== null) {
          dialog = { title, confirmed: false };
          if (confirmDialog) {
            await ctx.ui.keyCode('return');
            dialog.confirmed = (await waitForWindow(ctx.ui, ADD_TRACK_DIALOG, 0)) === null;
          }
        }
      }

      // The new channel: a uid the page did not have.
      const known = new Set(before.slots.map((s) => s.uid ?? `${s.index}:${s.title}`));
      let after = before;
      let created: BankSlotLike[] = [];
      for (let attempt = 0; attempt < 8 && !(dialog && !dialog.confirmed); attempt++) {
        await sleep(250 * Math.min(attempt + 1, 3));
        after = await client.pageChannels();
        created = after.slots.filter((s) => !known.has(s.uid ?? `${s.index}:${s.title}`));
        if (created.length > 0) break;
      }
      // Cubase moves the ids into the shifted slots before their titles: a new channel can show the old occupant's
      // name for a moment (a VCA read as "G R Clean", live 15 Oct 2026). Wait until no new channel carries the title
      // of a channel that was already there.
      const knownTitles = new Set(before.slots.map((s) => s.title));
      for (let attempt = 0; attempt < 8 && created.some((c) => knownTitles.has(c.title)); attempt++) {
        await sleep(300);
        after = await client.pageChannels();
        created = after.slots.filter((s) => !known.has(s.uid ?? `${s.index}:${s.title}`));
      }
      const moved = before.slots
        .map((s) => ({ s, now: after.slots.find((a) => a.uid !== null && a.uid === s.uid) }))
        .filter(({ s, now }) => now && now.index !== s.index);
      const indexShift =
        moved.length > 0
          ? { fromIndex: Math.min(...moved.map(({ s }) => s.index)), by: (moved[0].now as BankSlotLike).index - moved[0].s.index, channelsMoved: moved.length }
          : null;
      const routingAfter = created.length > 0 ? await client.mixerChannels([OUTPUT_TAG]).catch(() => null) : null;
      const sourcesAfter = sources.map((source) => {
        const now = after.slots.find((a) => a.uid !== null && a.uid === source.uid);
        return { ...source, ...(now && now.index !== source.index ? { indexNow: now.index } : {}), ...(now && routingAfter ? { outputNow: outputDisplay(routingAfter.get(now.index)) } : {}) };
      });
      const status = created.length > 0 ? 'created' : dialog && !dialog.confirmed ? 'dialog-open' : 'not-seen';
      const createdOut = created.map((c) => ({ type, name: c.title, index: c.index, uid: c.uid }));
      let rename: Record<string, unknown> | undefined;
      if (newName !== undefined) {
        if (createdOut.length !== 1) rename = { requested: newName, renamed: false, skipped: createdOut.length === 0 ? 'no new channel was seen' : 'more than one new channel appeared' };
        else {
          const [bus] = createdOut;
          try {
            const result = await client.renameChannel(bus.index, newName, { expectUid: bus.uid });
            rename = { requested: newName, before: result.before, renamed: result.renamed, verified: result.verified };
            if (result.renamed) bus.name = newName;
          } catch (error) {
            rename = { requested: newName, renamed: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
      }
      if (status === 'created') await rememberBus({ type, created: createdOut, sources, createdAt: new Date().toISOString() });
      return {
        command: `Mixer / ${name}`,
        status,
        ...(createdOut.length > 0 ? { created: createdOut } : {}),
        ...(rename ? { rename } : {}),
        ...(indexShift ? { indexShift } : {}),
        sources: sourcesAfter,
        ...(dialog ? { dialog } : {}),
        ...(status === 'dialog-open' ? { note: `Cubase shows "${dialog?.title}": confirm it (ui_key return) or cancel it (ui_key escape).` } : {}),
        ...(status === 'not-seen'
          ? {
              note:
                type === 'vca' || config.enableUiAutomation
                  ? 'No new channel appeared on the bank page shown now: it may be on another page, or nothing was selected.'
                  : 'No new channel appeared on the bank page shown now: Cubase probably shows the modal "Add Track" dialog (confirm it in Cubase), or the channel is on another page. Check with cubase_list_channels.',
            }
          : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
    { destructive: true },
  );

  defineTool(
    ctx,
    'cubase_export_audio_mixdown',
    'Opens File > Export > Audio Mixdown and triggers "Perform Audio Export" with the settings already stored in that dialog. Configure the dialog once (channel batch export, folder, naming) and the agent can re-export stems or the mix any time. ' +
      'Cubase only opens the dialog when it is the front app, so the tool brings it to the front (needs CUBASE_MCP_ENABLE_UI=1) and, with UI automation on, checks that the export window opened before starting the export. ' +
      'Pass folder (the export folder set in the dialog) to get the files written (new or changed audio files, once their size stops growing; it waits up to waitSeconds, default 120 with a folder); without it the answer says verified: false. Existing files with the same names are overwritten.',
    {
      waitSeconds: z.number().min(0).max(1800).optional().describe('Time to wait for the export to finish (default 120 s with folder, else 0)'),
      folder: z.string().trim().min(1).optional().describe('Absolute path of the export folder, to report the files written'),
    },
    async ({ waitSeconds, folder }) => {
      if (folder && !isAbsolute(folder)) throw new Error('folder must be an absolute path');
      const before = folder ? await audioFiles(folder) : null;
      // With another app in front, Cubase ignores the command and nothing is exported.
      if (config.enableUiAutomation) await ctx.ui.activate().catch(() => undefined);
      await client.runCommand('File', 'Export Audio Mixdown');
      let dialog: string | null = null;
      if (config.enableUiAutomation) {
        dialog = await waitForWindow(ctx.ui, EXPORT_WINDOW, 4000);
        if (dialog === null) {
          return {
            started: false,
            verified: false,
            note: 'The Export Audio Mixdown window did not open (Cubase in the background, a modal dialog open, or no project): nothing was exported.',
          };
        }
      } else await sleep(1200);
      await client.runCommand('Audio Export', 'Perform Audio Export');
      const wait = waitSeconds ?? (folder ? 120 : 0);
      if (!folder || !before) {
        if (wait > 0) await sleep(wait * 1000);
        return {
          started: true,
          verified: false,
          ...(dialog ? { window: dialog } : {}),
          note: config.enableUiAutomation
            ? 'Commands sent with the export window open. Pass folder to get the files written, or check the export folder.'
            : 'UI automation is off, so Cubase may not be in front and then ignores the command. Pass folder to check the files; if nothing appeared, bring Cubase to the front and retry.',
        };
      }
      const written = await waitForExport(folder, before, wait);
      return {
        started: true,
        verified: written.files.length > 0,
        ...(dialog ? { window: dialog } : {}),
        folder,
        files: written.files,
        ...(written.files.length === 0
          ? { note: `No new or changed audio file appeared in ${folder} within ${wait} s: check the folder set in the export dialog, or wait longer.` }
          : written.stillGrowing
            ? { note: 'Some files were still growing when the wait ended: the export may not be finished.' }
            : {}),
      };
    },
    { destructive: true },
  );
}
