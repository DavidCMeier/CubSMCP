import { z } from 'zod';
import { defineTool, type ToolContext } from './common.js';
import { KEY_NAMES } from '../ui/macos.js';

const modifiers = z.array(z.enum(['command', 'shift', 'option', 'control'])).default([]);
const menuLabel = z.string().min(1);

export function registerUiTools(ctx: ToolContext): void {
  const { ui, client } = ctx;
  const requirement = ' Requires CUBASE_MCP_ENABLE_UI=1 and Accessibility permission for the app running the server.';
  const action =
    ' Cubase is brought to the front first and nothing is sent if it does not stay there. ' +
    'The result reports the front app and the Cubase windows that opened or closed (~0.5 s later). ' +
    'If the call is denied (by the user or by Claude Code), do not retry it through other ui_* tools or osascript.';
  const labels =
    ' Labels are the ones Cubase shows, in its language (Spanish: "Archivo", "Edición", "Transporte"), and some change with the project ' +
    '("Deshacer <acción>"): use cubase_undo / cubase_transport / cubase_run_command when they cover the action. ' +
    'Matching ignores case, accents and "..." vs "…", never a prefix.';

  defineTool(
    ctx,
    'ui_activate_cubase',
    'Brings Cubase to the front and reports whether it stayed there (activated), the front app and the front window.' + requirement,
    {},
    async () => {
      const state = await ui.activate();
      return {
        activated: state.cubaseFrontmost,
        frontApp: state.frontApp,
        frontWindow: state.windows[0]?.title ?? null,
        windowCount: state.windows.length,
      };
    },
  );

  defineTool(
    ctx,
    'ui_click_menu',
    'Clicks a Cubase menu item by path, e.g. ["Transporte", "Comandos de transporte", "Detener"] or ["Archivo", "Exportar", "Mezcla de audio..."]. ' +
      'Each level is matched against the live menu; a missing label fails with the items that exist, and disabled items are not clicked. ' +
      'Items that open a window toggle it: a second click on "Estudio > Conexiones de audio..." closes the window (check opened/closed).' +
      labels +
      action +
      requirement,
    { path: z.array(menuLabel).min(2).max(5) },
    async ({ path }) => ui.clickMenu(path),
    { destructive: true },
  );

  defineTool(
    ctx,
    'ui_list_menu',
    'Lists a Cubase menu to discover exact labels: no menu lists the menu bar; menu "Transporte" lists that menu; ' +
      'submenu ["Comandos de transporte"] goes deeper. Items report index, enabled and whether they open a submenu; ' +
      'items of a menu also report checked (a check mark) and their shortcut: text as the menu shows it ("⇧⌘Z"), ' +
      'modifiers and key ready for ui_keystroke (a character) or ui_key (a key name such as "f9" or "pad0"). ' +
      'Shortcuts are what macOS reports for the menu item; Cubase key commands that are not in a menu do not appear.' +
      labels +
      requirement,
    {
      menu: menuLabel.optional().describe('Top-level menu as Cubase shows it, e.g. "Archivo" or "Edición". Omit to list the menu bar.'),
      submenu: z.array(menuLabel).max(4).default([]).describe('Submenu path inside that menu, e.g. ["Comandos de transporte"]'),
    },
    async ({ menu, submenu }) => {
      if (!menu && submenu.length) throw new Error('submenu needs menu');
      const { path, items } = await ui.listMenu(menu ? [menu, ...submenu] : []);
      return {
        path,
        items: items
          .filter((item) => item.name !== '')
          .map((item) => ({
            name: item.name,
            index: item.index,
            ...(item.enabled ? {} : { enabled: false }),
            ...(item.submenu && path.length ? { submenu: true } : {}),
            ...(item.checked ? { checked: true } : {}),
            ...(item.shortcut ? { shortcut: item.shortcut } : {}),
          })),
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'ui_keystroke',
    'Sends a keystroke to Cubase, e.g. text "s" with ["command"] to save. Cubase runs whatever its key commands assign to it ' +
      '(Cmd+Shift+Z is Redo): ui_list_menu shows the shortcuts of each menu, check them before trying one. An uppercase letter is sent with Shift.' +
      action +
      requirement,
    { text: z.string().min(1), modifiers },
    async ({ text, modifiers: mods }) => ({ sent: text, modifiers: mods, ...(await ui.keystroke(text, mods)) }),
    { destructive: true },
  );

  defineTool(
    ctx,
    'ui_key',
    `Sends a special key to Cubase: ${KEY_NAMES.join(', ')}. ` +
      'pad0..pad9, pad., pad+, pad-, pad*, pad/, padenter, padequals and padclear are the numeric keypad keys ("enter" is the keypad Enter too). ' +
      'F keys and keypad keys run whatever Cubase key commands assign to them (in Cubase\'s defaults the keypad drives the transport, e.g. pad0 Stop and padenter Start; ' +
      'F1 opens the online help in the browser, which then stays in front).' +
      action +
      requirement,
    { key: z.string(), modifiers },
    async ({ key, modifiers: mods }) => ({ sent: key, modifiers: mods, ...(await ui.keyCode(key, mods)) }),
    { destructive: true },
  );

  defineTool(
    ctx,
    'ui_type_text',
    'Types text into the focused Cubase field (optionally selecting all first and pressing Return after). ' +
      'Only use it when you know a text field or dialog is open: otherwise every character reaches Cubase as a key command (and Cmd+A selects all events). ' +
      'Text with accents or other non-ASCII characters is pasted through the clipboard, which is put back afterwards. ' +
      'ui_read_focused shows what has the focus before typing and, for fields macOS can see, the text after.' +
      action +
      requirement,
    { text: z.string(), selectAll: z.boolean().default(false), pressReturn: z.boolean().default(false) },
    async ({ text, selectAll, pressReturn }) => ({ typed: text, ...(await ui.typeText(text, { selectAll, pressReturn })) }),
    { destructive: true },
  );

  defineTool(
    ctx,
    'ui_front_window',
    'Returns the front app and Cubase\'s front window without activating Cubase (to check whether a dialog is open). ' +
      'Many Cubase windows have no title (frontWindow ""), so it also gives the first window that has one.' +
      requirement,
    {},
    async () => {
      const state = await ui.state();
      return {
        frontApp: state.frontApp,
        cubaseRunning: state.cubaseRunning,
        cubaseFrontmost: state.cubaseFrontmost,
        frontWindow: state.windows[0]?.title ?? null,
        firstTitledWindow: state.windows.find((w) => w.title)?.title ?? null,
        windowCount: state.windows.length,
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'ui_read_focused',
    'Reads what has the keyboard focus in Cubase, as macOS Accessibility reports it: the focused window and the focused element ' +
      '(role, subrole, title, description, value as text with its class, placeholder, selected text, enabled). Read-only: it sends no keys and, ' +
      'unless activate is true, does not bring Cubase to the front. Use it to check that a text field has the focus before ui_type_text, and to read back what was typed. ' +
      'Cubase 13 does not expose its own name fields to Accessibility (the track name field in the project window is one): ' +
      'there the element comes out without a value, or not at all, and what was typed cannot be read back. Standard macOS controls, such as the file dialogs, usually are exposed.' +
      requirement,
    { activate: z.boolean().default(false).describe('Bring Cubase to the front first') },
    async ({ activate }) => {
      const focus = await ui.focus({ activate });
      const notes: string[] = [];
      if (!focus.element) {
        notes.push('macOS reports no focused element in Cubase: the focus is on something Cubase does not expose to Accessibility (e.g. a track name field), or on nothing.');
      } else if (focus.element.value === undefined) {
        notes.push('The focused element has no value Accessibility can read: if it is a Cubase name field, check the name with cubase_get_channel or cubase_list_channels instead.');
      }
      if (!focus.cubaseFrontmost) notes.push(`Cubase is not the frontmost app (front: "${focus.frontApp || 'unknown'}"): keys reach Cubase only while it is in front (ui_* actions bring it there first).`);
      return {
        frontApp: focus.frontApp,
        cubaseFrontmost: focus.cubaseFrontmost,
        focusedWindow: focus.window,
        focusedElement: focus.element,
        ...(notes.length ? { notes } : {}),
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'ui_list_windows',
    'Lists Cubase\'s windows front to back (title, "" when untitled, and size). By default Cubase is not activated: ' +
      'while it is in the background macOS hides plugin editors, so they only appear with activate true. ' +
      'Whether a plugin editor is open is read more reliably from editorOpen in cubase_get_channel_strip.' +
      requirement,
    { activate: z.boolean().default(false).describe('Bring Cubase to the front first (shows plugin editors)') },
    async ({ activate }) => (activate ? ui.activate() : ui.state()),
    { readOnly: true },
  );
}
