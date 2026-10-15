import { z } from 'zod';
import { channelIdentity, channelRef, defineTool, sleep, type ToolContext } from './common.js';

/**
 * cubase_rename_channel: renames through DirectAccess ("Nombre", tag 1024) or, in field mode, opens the name
 * field for the user to type in.
 */
export function registerRenameTool(ctx: ToolContext): void {
  const { client, ui } = ctx;

  defineTool(
    ctx,
    'cubase_rename_channel',
    'Renames a mixer channel (and its track). mode "direct" (the default when DirectAccess is available) writes the name through DirectAccess (the "Name" parameter, tag 1024, ' +
      'of the channel object found by unique id) and checks that the bank shows the new name (renamed, verified); it does not select the channel, does not need the UI, ' +
      'and Cubase leaves no Edit history step for it (cubase_undo cannot revert it: rename it back instead). ' +
      'mode "field" only prepares the rename for the user: it selects the track and opens its name field (Edit > Rename First Selected Track), and never types the name ' +
      '(Cubase 13 does not expose its name field to Accessibility, so keystrokes could reach the project window as key commands); the track must be visible in the project window, ' +
      'waitSeconds waits for the user to finish and checks the new name, and selecting can record-arm the track (sideEffects). ' +
      'mode "auto" (default) is direct, or field when DirectAccess is off.',
    {
      channel: channelRef,
      name: z.string().trim().min(1).max(64).describe('The new name (not blank)'),
      mode: z.enum(['auto', 'direct', 'field']).default('auto').describe('direct: write it through DirectAccess; field: open the name field for the user; auto: direct when possible'),
      waitSeconds: z.number().int().min(0).max(120).default(0).describe('field mode: wait up to this long for the new name to appear'),
    },
    async ({ channel, name, mode, waitSeconds }) => {
      let fallback: string | null = null;
      if (mode !== 'field') {
        try {
          const result = await client.renameChannel(channel, name);
          const { channel: _title, ...identity } = channelIdentity(result.channel);
          return {
            mode: 'direct',
            before: result.before,
            after: result.after,
            renamed: result.renamed,
            verified: result.verified,
            ...identity,
            ...(result.bankWarning ? { bankWarning: result.bankWarning } : {}),
            ...(!result.renamed
              ? { note: `Cubase did not show "${name}" in the bank in time: check with cubase_list_channels before trying again (mode "field" lets the user type it).` }
              : {}),
          };
        } catch (error) {
          if (mode !== 'auto' || (error as { code?: string }).code !== 'NO_DIRECT_ACCESS') throw error;
          fallback = (error as Error).message;
        }
      }
      const focus = await client.focusChannel(channel);
      if (!focus.verified) throw new Error(`Could not select "${focus.channel.title}"`);
      // The command acts on the focused Cubase window: bring Cubase to the front when allowed.
      if (ctx.config.enableUiAutomation) await ui.activate().catch(() => undefined);
      await client.runCommand('Edit', 'Rename First Selected Track');
      const deadline = Date.now() + waitSeconds * 1000;
      // Cubase can stall for a few seconds on big projects: a timed-out read keeps the last title.
      const readTitle = (last: string | null) => client.selection().then((selection) => selection.title, () => last);
      let current = await readTitle(focus.channel.title);
      while (current !== name && Date.now() < deadline) {
        await sleep(1000);
        current = await readTitle(current);
      }
      const head = { mode: 'field', ...(fallback ? { fallbackReason: fallback } : {}), sideEffects: focus.sideEffects, before: focus.channel.title, after: current };
      if (current === name) return { ...head, renamed: true };
      return {
        ...head,
        renamed: false,
        userAction: `Ask the user to type "${name}" in the open name field of "${focus.channel.title}" and press Return (or double-click the track name if the field did not open).`,
      };
    },
  );
}
