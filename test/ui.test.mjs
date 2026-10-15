import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivateScript,
  buildKeyScript,
  buildMenuClickScript,
  buildMenuListScript,
  buildStateScript,
  buildTypeScript,
  buildFocusScript,
  decodeMenuShortcut,
  describeAction,
  describeAppleScriptError,
  diffWindows,
  formatMenuItems,
  keyCodeFor,
  KEY_NAMES,
  matchMenuItem,
  menuReference,
  parseAppleScriptError,
  parseFocusInfo,
  parseMenuItems,
  parseUiState,
  unescapeFocusValue,
} from '../dist/ui/macos.js';
import { setupServer } from './helpers/session.mjs';

/** A menu line as buildMenuListScript prints it: enabled, submenus, char code, modifiers, key code, glyph, checked, name. */
const line = (name, enabled = true, subs = 0, shortcut = ['', '', '', ''], checked = false) =>
  [String(enabled), String(subs), ...shortcut, checked ? '1' : '0', name].join('\t');

test('menu items come one per line and keep commas, spaces and tabs in their names', () => {
  const output =
    [line('Foo, Bar...'), line('', false), line('  Baz', false), line('Comandos de transporte', true, 1), line('Tab\there')].join('\n') + '\n';
  const plain = { shortcut: null, checked: false };
  assert.deepEqual(parseMenuItems(output), [
    { name: 'Foo, Bar...', index: 1, enabled: true, submenu: false, ...plain },
    { name: '', index: 2, enabled: false, submenu: false, ...plain },
    { name: '  Baz', index: 3, enabled: false, submenu: false, ...plain },
    { name: 'Comandos de transporte', index: 4, enabled: true, submenu: true, ...plain },
    { name: 'Tab\there', index: 5, enabled: true, submenu: false, ...plain },
  ]);
  assert.deepEqual(parseMenuItems('\n'), []);
  assert.equal(formatMenuItems(parseMenuItems(output)), 'Foo, Bar..., (  Baz), Comandos de transporte >, Tab\there');
});

test('menu items carry their shortcut and check mark', () => {
  // Like Finder reports them: letters as a code point, Delete as a control character plus key code 51, modifiers 8 without a key.
  const items = parseMenuItems(
    [
      line('Rehacer', true, 0, ['90', '1', '', '']),
      line('Trasladar a la papelera', true, 0, ['8', '0', '51', '23']),
      line('Sin atajo', true, 0, ['', '8', '', '']),
      line('Activar metrónomo', true, 0, ['', '', '', ''], true),
      line('Detener', true, 0, ['', '0', '82', '']),
    ].join('\n'),
  );
  assert.deepEqual(items[0].shortcut, { text: '⇧⌘Z', modifiers: ['command', 'shift'], key: 'z' });
  assert.deepEqual(items[1].shortcut, { text: '⌘⌫', modifiers: ['command'], key: 'delete' });
  assert.equal(items[2].shortcut, null);
  assert.equal(items[3].checked, true);
  assert.equal(items[3].shortcut, null);
  assert.deepEqual(items[4].shortcut, { text: '⌘Pad0', modifiers: ['command'], key: 'pad0' });
});

test('shortcuts decode modifiers, function keys, glyphs and the keypad', () => {
  const raw = (fields) => ({ char: null, modifiers: null, virtualKey: null, glyph: null, ...fields });
  // Modifier bits: 1 Shift, 2 Option, 4 Control, 8 no Command; the text uses menu order.
  assert.deepEqual(decodeMenuShortcut(raw({ char: 83, modifiers: 0 })), { text: '⌘S', modifiers: ['command'], key: 's' });
  assert.deepEqual(decodeMenuShortcut(raw({ char: 83, modifiers: 7 })), {
    text: '⌃⌥⇧⌘S',
    modifiers: ['command', 'shift', 'option', 'control'],
    key: 's',
  });
  assert.deepEqual(decodeMenuShortcut(raw({ char: 0xf70c, modifiers: 8 })), { text: 'F9', modifiers: [], key: 'f9' });
  assert.deepEqual(decodeMenuShortcut(raw({ virtualKey: 101, modifiers: 9 })), { text: '⇧F9', modifiers: ['shift'], key: 'f9' });
  assert.deepEqual(decodeMenuShortcut(raw({ char: 0x1f, glyph: 0x7a, modifiers: 8 })), { text: 'F12', modifiers: [], key: 'f12' });
  assert.deepEqual(decodeMenuShortcut(raw({ virtualKey: 76, modifiers: 8 })), { text: '⌤', modifiers: [], key: 'enter' });
  assert.deepEqual(decodeMenuShortcut(raw({ virtualKey: 65, modifiers: 10 })), { text: '⌥Pad.', modifiers: ['option'], key: 'pad.' });
  assert.deepEqual(decodeMenuShortcut(raw({ char: 0x0d, modifiers: 0 })), { text: '⌘↩', modifiers: ['command'], key: 'return' });
  assert.deepEqual(decodeMenuShortcut(raw({ char: 44, modifiers: 0 })), { text: '⌘,', modifiers: ['command'], key: ',' });
  assert.deepEqual(decodeMenuShortcut(raw({ char: 0x20, modifiers: 8 })), { text: 'Space', modifiers: [], key: 'space' });
  // Nothing to press: no character and no key code, or a function-key character nobody maps.
  assert.equal(decodeMenuShortcut(raw({ modifiers: 0 })), null);
  assert.equal(decodeMenuShortcut(raw({ glyph: 0x6f, modifiers: 0 })), null);
  assert.equal(decodeMenuShortcut(raw({ char: 0xf7ff, modifiers: 0 })), null);
});

test('menu labels match exactly, then ignoring case, ellipsis and accents, never by prefix', () => {
  const items = parseMenuItems(
    [line('Deshacer Ajustar nombre de pista'), line('Pegar'), line('Pegar'), line('Ajustes…'), line('Edición', true, 1)].join('\n'),
  );
  assert.deepEqual(matchMenuItem(items, 'Pegar'), { item: items[1], matchedBy: 'exact' });
  assert.equal(matchMenuItem(items, 'ajustes...').item.index, 4);
  assert.equal(matchMenuItem(items, 'ajustes...').matchedBy, 'normalized');
  assert.equal(matchMenuItem(items, 'Edicion').matchedBy, 'accents');
  assert.equal(matchMenuItem(items, 'Deshacer'), null);
  assert.equal(matchMenuItem(items, ''), null);
});

test('menu scripts address items by position and the click checks the label first', () => {
  assert.equal(menuReference([5]), 'menu bar item 5 of menu bar 1');
  assert.equal(menuReference([5, 3, 2]), 'menu item 2 of menu 1 of menu item 3 of menu 1 of menu bar item 5 of menu bar 1');
  assert.match(buildMenuListScript('Cubase 13', []), /name of every menu bar item of theMenu/);
  assert.match(buildMenuListScript('Cubase 13', [5, 3]), /set theMenu to menu 1 of menu item 3 of menu 1 of menu bar item 5 of menu bar 1/);
  assert.match(buildMenuListScript('Cubase 13', [5]), /text item delimiters to linefeed/);
  // Shortcuts cost five queries per menu: only when asked, never for the menu bar, each in its own try.
  assert.doesNotMatch(buildMenuListScript('Cubase 13', [5]), /attributes whose name/);
  assert.doesNotMatch(buildMenuListScript('Cubase 13', [], { shortcuts: true }), /attributes whose name/);
  const listing = buildMenuListScript('Cubase 13', [5], { shortcuts: true });
  for (const attribute of ['AXMenuItemCmdChar', 'AXMenuItemCmdModifiers', 'AXMenuItemCmdVirtualKey', 'AXMenuItemCmdGlyph', 'AXMenuItemMarkChar']) {
    assert.match(listing, new RegExp(`try\\n\\s*set \\w+ to value of \\(attributes whose name is "${attribute}"\\) of every menu item of theMenu\\n\\s*end try`));
  }
  assert.match(listing, /tab & itemName$/m);
  assert.match(listing, /id of character 1 of/);
  const click = buildMenuClickScript('Cubase 13', [5, 3, 2], 'Detener "x"');
  assert.match(click, /set appName to "Cubase 13"/);
  assert.match(click, /if itemName is not "Detener \\"x\\"" then error/);
  assert.match(click, /frontmost of process appName/);
  assert.ok(click.indexOf('frontmost of process appName') < click.indexOf('click theItem'));
  assert.throws(() => buildMenuClickScript('Cubase 13', [5], 'Archivo'));
});

test('key and text scripts check the focus in the same script and escape the text', () => {
  const key = buildKeyScript('Cubase 13', { code: keyCodeFor('F12') }, ['command', 'shift']);
  assert.match(key, /key code 111 using \{command down, shift down\}/);
  assert.ok(key.indexOf('frontmost of process appName') < key.indexOf('key code 111'));
  assert.match(buildKeyScript('Cubase 13', { text: 'a"b\\c' }), /keystroke "a\\"b\\\\c"$/m);
  const typed = buildTypeScript('Cubase 13', 'Voz', { selectAll: true, pressReturn: true });
  assert.match(typed, /keystroke "a" using \{command down\}[\s\S]*keystroke "Voz"[\s\S]*key code 36/);
  assert.doesNotMatch(buildTypeScript('Cubase 13', 'Voz'), /key code 36|command down/);
  // Accented letters go through the clipboard: keystroke mistypes them with the keyboard layout.
  const accented = buildTypeScript('Cubase 13', 'ñandú "Trombón"');
  assert.match(accented, /set the clipboard to "ñandú \\"Trombón\\""[\s\S]*keystroke "v" using \{command down\}[\s\S]*set the clipboard to savedClipboard/);
  assert.doesNotMatch(accented, /keystroke "ñ/);
  assert.equal(keyCodeFor('f9'), 101);
  assert.throws(() => keyCodeFor('f13'), /Unknown key "f13"/);
  // Numeric keypad (kVK_ANSI_Keypad*).
  const pad = {
    pad0: 82, pad1: 83, pad5: 87, pad7: 89, pad8: 91, pad9: 92,
    'pad.': 65, 'pad+': 69, 'pad-': 78, 'pad*': 67, 'pad/': 75, padenter: 76, padequals: 81, padclear: 71,
  };
  for (const [name, code] of Object.entries(pad)) assert.equal(keyCodeFor(name), code, name);
  assert.equal(keyCodeFor(' Pad0 '), 82);
  for (let n = 0; n <= 9; n++) assert.ok(KEY_NAMES.includes(`pad${n}`));
  assert.match(buildKeyScript('Cubase 13', { code: keyCodeFor('pad0') }), /key code 82$/m);
});

test('activation never launches Cubase and the state script never activates it', () => {
  const activate = buildActivateScript('Cubase "13"');
  assert.match(activate, /set appName to "Cubase \\"13\\""/);
  assert.ok(activate.indexOf('exists process appName') < activate.indexOf('tell application appName to activate'));
  assert.doesNotMatch(buildStateScript('Cubase 13'), /activate/);
});

test('UI state parsing keeps untitled windows and sizes', () => {
  assert.deepEqual(parseUiState('Cubase 13\ntrue\nCubase Pro Project - Mix\t1920\t1080\n\t67\t19\n'), {
    frontApp: 'Cubase 13',
    cubaseRunning: true,
    cubaseFrontmost: true,
    windows: [
      { title: 'Cubase Pro Project - Mix', width: 1920, height: 1080 },
      { title: '', width: 67, height: 19 },
    ],
  });
  assert.deepEqual(parseUiState('Safari\nmissing\n'), { frontApp: 'Safari', cubaseRunning: false, cubaseFrontmost: false, windows: [] });
});

test('window changes compare titles as a multiset and count untitled windows apart', () => {
  const w = (title) => ({ title, width: null, height: null });
  assert.deepEqual(diffWindows([w('Proyecto'), w('MixConsole'), w('')], [w('Conexiones de audio'), w('Proyecto'), w(''), w('')]), {
    opened: ['Conexiones de audio'],
    closed: ['MixConsole'],
    untitledDelta: 1,
  });
  assert.deepEqual(diffWindows([w('A'), w('A')], [w('A')]), { opened: [], closed: ['A'], untitledDelta: 0 });
});

test('an action report says when another app took the front', () => {
  const before = { frontApp: 'Cubase 13', cubaseRunning: true, cubaseFrontmost: true, windows: [{ title: 'Proyecto', width: 1, height: 1 }] };
  const after = { frontApp: 'Safari', cubaseRunning: true, cubaseFrontmost: false, windows: [{ title: 'Proyecto', width: 1, height: 1 }] };
  const report = describeAction('Cubase 13', before, after);
  assert.equal(report.frontApp, 'Safari');
  assert.equal(report.cubaseFrontmost, false);
  assert.equal(report.frontWindow, 'Proyecto');
  assert.deepEqual(report.opened, []);
  assert.match(report.notes[0], /no longer frontmost.*Safari/);
  assert.equal(describeAction('Cubase 13', before, before).notes, undefined);
});

test('AppleScript errors are parsed from Spanish and English messages', () => {
  assert.deepEqual(
    parseAppleScriptError('63:67: execution error: System Events ha detectado un error: No puede obtenerse process "Cubase 99 Harness". (-1728)\n'),
    { code: -1728, text: 'System Events ha detectado un error: No puede obtenerse process "Cubase 99 Harness".' },
  );
  assert.deepEqual(parseAppleScriptError('no code here'), { code: null, text: 'no code here' });
});

test('AppleScript errors get a hint chosen by their code, with macOS text last', () => {
  const app = 'Cubase 13';
  const notFound = 'execution error: System Events got an error: Can’t get menu bar item "Edicion" of menu bar 1 of process "Cubase 13". (-1728)';
  const menu = describeAppleScriptError(notFound, 'menu', app);
  assert.match(menu, /^Menu or menu item not found.*ui_list_menu/);
  assert.match(menu, /macOS: System Events got an error: .*\(-1728\)$/);
  assert.doesNotMatch(menu, /Accessibility/);

  assert.match(
    describeAppleScriptError('0:10: execution error: No puede obtenerse process "Cubase 99 Harness". (-1728)', 'activate', 'Cubase 99 Harness'),
    /^Cubase process "Cubase 99 Harness" not found.*CUBASE_MCP_APP_NAME/,
  );
  assert.match(describeAppleScriptError('111:155: execution error: Process "X" is not running (-600)', 'keys', 'X'), /CUBASE_MCP_APP_NAME/);
  assert.match(
    describeAppleScriptError('execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)', 'keys', app),
    /Accessibility/,
  );
  assert.match(
    describeAppleScriptError('execution error: System Events ha detectado un error: osascript no tiene permiso de acceso de asistencia. (-25211)', 'menu', app),
    /Accessibility/,
  );
  assert.match(
    describeAppleScriptError('execution error: System Events got an error: osascript is not allowed assistive access. (-1719)', 'menu', app),
    /Accessibility/,
  );
  assert.match(describeAppleScriptError('execution error: Not authorized to send Apple events to System Events. (-1743)', 'keys', app), /Automation/);
  assert.match(describeAppleScriptError('execution error: Invalid index. (-1719)', 'window', app), /no window in front/);
  assert.match(describeAppleScriptError('execution error: Índice no válido. (-1719)', 'menu', app), /ui_list_menu/);
  assert.match(describeAppleScriptError('execution error: AppleEvent timed out. (-1712)', 'menu', app), /did not answer in time/);
  assert.equal(
    describeAppleScriptError('1:2: execution error: Cubase 13 is not the frontmost app (front: Safari); nothing was sent (9100)', 'keys', app),
    'Cubase 13 is not the frontmost app (front: Safari); nothing was sent',
  );
  assert.match(describeAppleScriptError('execution error: Something else. (-2700)', 'keys', app), /^AppleScript failed\. macOS: Something else\. \(-2700\)$/);
});

test('the focus script reads the focused window and element without activating Cubase', () => {
  const script = buildFocusScript('Cubase "13"');
  assert.match(script, /set appName to "Cubase \\"13\\""/);
  assert.match(script, /value of attribute "AXFocusedUIElement" of process appName/);
  assert.match(script, /value of attribute "AXFocusedWindow" of process appName/);
  assert.match(script, /"AXRole", "AXSubrole", .*"AXValue"/);
  assert.doesNotMatch(script, /activate|keystroke|key code|click/);
  assert.ok(script.indexOf('exists process appName') < script.indexOf('AXFocusedUIElement'));
  // AppleScript literals: "\\" is one backslash, and esc writes it doubled.
  assert.ok(script.includes('my rep(t, "\\\\", "\\\\\\\\")'));
  assert.ok(script.includes('my rep(t, linefeed, "\\\\n")'));
});

test('focus output is parsed with escaped values, classes and missing sections', () => {
  const output = [
    'app\tfrontApp\ttext\tCubase 13',
    'app\tfrontmost\tboolean\ttrue',
    'window\tpresent\tboolean\ttrue',
    'window\tAXRole\ttext\tAXWindow',
    'window\tAXTitle\ttext\tExportar mezcla de audio',
    'window\tAXModal\tboolean\ttrue',
    'element\tpresent\tboolean\ttrue',
    'element\tAXRole\ttext\tAXTextField',
    'element\tAXValue\ttext\tVoz\\tlead\\nC:\\\\x',
    'element\tAXEnabled\tboolean\tfalse',
    'element\tAXUnknown\ttext\tignored',
  ].join('\n');
  assert.deepEqual(parseFocusInfo(output + '\n'), {
    frontApp: 'Cubase 13',
    cubaseFrontmost: true,
    window: { role: 'AXWindow', title: 'Exportar mezcla de audio', modal: true },
    element: { role: 'AXTextField', value: 'Voz\tlead\nC:\\x', valueClass: 'text', enabled: false },
  });
  assert.deepEqual(parseFocusInfo('app\tfrontApp\ttext\tSafari\napp\tfrontmost\tboolean\tfalse'), {
    frontApp: 'Safari',
    cubaseFrontmost: false,
    window: null,
    element: null,
  });
  assert.deepEqual(parseFocusInfo('element\tpresent\tboolean\ttrue\nelement\tAXValue\tinteger\t3').element, { value: '3', valueClass: 'integer' });
  // Exactly what the esc handler printed for "a\b<TAB>c<LF>d<CR>e" in osascript.
  assert.equal(unescapeFocusValue('a\\\\b\\tc\\nd\\re'), 'a\\b\tc\nd\re');
  assert.equal(unescapeFocusValue('a\\\\nb'), 'a\\nb');
});

test('ui_read_focused reports the focus without activating Cubase and explains an unreadable field', async () => {
  const calls = [];
  const focus = {
    frontApp: 'Cubase 13',
    cubaseFrontmost: true,
    window: { role: 'AXWindow', title: '' },
    element: { role: 'AXGroup' },
  };
  const ui = { focus: async (options) => (calls.push(options), focus), activate: async () => undefined };
  const { call } = await setupServer({ ui, enableUi: true });
  const result = await call('ui_read_focused');
  assert.deepEqual(calls, [{ activate: false }]);
  assert.deepEqual(result.focusedElement, { role: 'AXGroup' });
  assert.deepEqual(result.focusedWindow, { role: 'AXWindow', title: '' });
  assert.match(result.notes[0], /no value Accessibility can read/);
  focus.element = null;
  focus.cubaseFrontmost = false;
  focus.frontApp = 'Safari';
  const none = await call('ui_read_focused', { activate: true });
  assert.deepEqual(calls[1], { activate: true });
  assert.equal(none.focusedElement, null);
  assert.match(none.notes.join(' '), /no focused element[\s\S]*not the frontmost app \(front: "Safari"\)/);
  focus.cubaseFrontmost = true;
  focus.element = { role: 'AXTextField', value: 'Voz', valueClass: 'text' };
  assert.equal((await call('ui_read_focused')).notes, undefined);
  assert.match((await call('ui_read_focused', { activat: true })).error, /Unrecognized key/);
});

test('ui_list_menu shows shortcuts and check marks only where there are some', async () => {
  const items = parseMenuItems(
    [line('Rehacer', true, 0, ['90', '1', '', '']), line('Metrónomo', true, 0, ['', '8', '', ''], true), line('', false)].join('\n'),
  );
  const ui = { listMenu: async (path) => ({ path, items }), activate: async () => undefined };
  const { call } = await setupServer({ ui, enableUi: true });
  const result = await call('ui_list_menu', { menu: 'Edición' });
  assert.deepEqual(result.items, [
    { name: 'Rehacer', index: 1, shortcut: { text: '⇧⌘Z', modifiers: ['command', 'shift'], key: 'z' } },
    { name: 'Metrónomo', index: 2, checked: true },
  ]);
});
