import { execFile } from 'node:child_process';

/**
 * macOS UI automation through AppleScript / System Events.
 * Covers the gaps the MIDI Remote API leaves open in Cubase 13 (typing names, menu items, dialogs).
 * Requires Accessibility permission for the app that launches the MCP server (Claude, Terminal...).
 *
 * The script text and the parsing of osascript's output are pure functions (exported for the tests);
 * MacUi only runs them.
 */

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  forwarddelete: 117,
  // Numeric keypad (macOS kVK_ANSI_Keypad*). "enter" above is the keypad Enter too.
  pad0: 82,
  pad1: 83,
  pad2: 84,
  pad3: 85,
  pad4: 86,
  pad5: 87,
  pad6: 88,
  pad7: 89,
  pad8: 91,
  pad9: 92,
  'pad.': 65,
  'pad+': 69,
  'pad-': 78,
  'pad*': 67,
  'pad/': 75,
  padenter: 76,
  padequals: 81,
  padclear: 71,
};

export const KEY_NAMES = Object.keys(KEY_CODES);

/** Key code -> ui_key name; with two names for a code ("enter"/"padenter") the first one wins. */
const KEY_NAMES_BY_CODE = new Map<number, string>();
for (const [name, code] of Object.entries(KEY_CODES)) if (!KEY_NAMES_BY_CODE.has(code)) KEY_NAMES_BY_CODE.set(code, name);

export type Modifier = 'command' | 'shift' | 'option' | 'control';

/** Where an AppleScript ran: it decides which hint an error gets. */
export type UiContext = 'activate' | 'menu' | 'window' | 'keys';

/** Custom error numbers raised by our own scripts. */
const NOT_FRONTMOST = 9100;
const MENU_CHANGED = 9101;
/** Same number macOS uses for "application isn't running". */
const NOT_RUNNING = -600;

/** Time Cubase gets to react to a key or menu click before the windows are read again. */
const SETTLE_AFTER_ACTION_MS = 500;
const OSASCRIPT_TIMEOUT_MS = 30_000;

export interface WindowInfo {
  /** Window title; '' for windows without one. */
  title: string;
  width: number | null;
  height: number | null;
}

export interface UiState {
  /** Name of the frontmost application process ('' if macOS did not say). */
  frontApp: string;
  cubaseRunning: boolean;
  cubaseFrontmost: boolean;
  /** Cubase windows, front to back. macOS leaves plugin editors out while Cubase is in the background. */
  windows: WindowInfo[];
}

export interface MenuItemInfo {
  /** Label exactly as macOS reports it ('' for separators). */
  name: string;
  /** 1-based position in the menu, separators included (what AppleScript's "menu item N" uses). */
  index: number;
  enabled: boolean;
  submenu: boolean;
  /** Key equivalent macOS shows next to the item; null when it has none or when shortcuts were not read. */
  shortcut: MenuShortcut | null;
  /** The item shows a check mark (a switch that is on). False when marks were not read. */
  checked: boolean;
}

/** Raw Accessibility values of a menu item's key equivalent (null when absent). */
export interface RawMenuShortcut {
  /** AXMenuItemCmdChar as a Unicode code point. */
  char: number | null;
  /** AXMenuItemCmdModifiers bit mask: 1 Shift, 2 Option, 4 Control, 8 no Command. */
  modifiers: number | null;
  /** AXMenuItemCmdVirtualKey: a macOS key code. */
  virtualKey: number | null;
  /** AXMenuItemCmdGlyph: a Carbon menu glyph number. */
  glyph: number | null;
}

export interface MenuShortcut {
  /** As macOS menus show it, modifiers in menu order: "⇧⌘Z", "⌘S", "F9", "⌥Pad0". */
  text: string;
  /** In the order ui_keystroke / ui_key take them. */
  modifiers: Modifier[];
  /** A ui_key name when ui_key knows the key ("f9", "pad0", "delete"), otherwise the character for ui_keystroke (lowercase: Shift is in modifiers). */
  key: string;
}

/** Accessibility attributes of an element, read as text. Absent attributes are left out. */
export interface AxElementInfo {
  role?: string;
  subrole?: string;
  roleDescription?: string;
  title?: string;
  description?: string;
  /** AXValue as text (lists joined with ", "); valueClass says what it was (text, integer, real, boolean, list...). */
  value?: string;
  valueClass?: string;
  help?: string;
  placeholder?: string;
  selectedText?: string;
  enabled?: boolean;
  modal?: boolean;
}

export interface FocusInfo {
  frontApp: string;
  cubaseFrontmost: boolean;
  /** Cubase's focused window (AXFocusedWindow), null when macOS reports none. */
  window: AxElementInfo | null;
  /** Cubase's focused UI element (AXFocusedUIElement), null when macOS reports none. */
  element: AxElementInfo | null;
}

export interface WindowChanges {
  opened: string[];
  closed: string[];
  /** Change in the number of windows without a title (they cannot be told apart). */
  untitledDelta: number;
}

export interface UiActionReport extends WindowChanges {
  frontApp: string;
  cubaseFrontmost: boolean;
  /** Title of Cubase's front window after the action ('' when it has no title, null when there is none). */
  frontWindow: string | null;
  notes?: string[];
}

export interface ClickMenuReport extends UiActionReport {
  clicked: string[];
  matchedBy: MatchKind[];
}

// ---------------------------------------------------------------------------
// Pure helpers: script text
// ---------------------------------------------------------------------------

export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function keyCodeFor(key: string): number {
  const code = KEY_CODES[key.trim().toLowerCase()];
  if (code === undefined) throw new Error(`Unknown key "${key}". Known: ${KEY_NAMES.join(', ')}`);
  return code;
}

function usingClause(modifiers: Modifier[]): string {
  if (modifiers.length === 0) return '';
  return ` using {${modifiers.map((m) => `${m} down`).join(', ')}}`;
}

function header(appName: string): string[] {
  return [`set appName to "${escapeAppleScript(appName)}"`];
}

/** Fails with -600 when the process is not running (never launches Cubase). Goes inside "tell System Events". */
const REQUIRE_RUNNING = `if not (exists process appName) then error "Process \\"" & appName & "\\" is not running" number ${NOT_RUNNING}`;

/** Fails when Cubase is not the frontmost app, so nothing reaches another app. Goes inside "tell System Events". */
const REQUIRE_FRONTMOST = [
  'if not (frontmost of process appName) then',
  '  set frontName to ""',
  '  try',
  '    set frontName to name of first application process whose frontmost is true',
  '  end try',
  `  error appName & " is not the frontmost app (front: " & frontName & "); nothing was sent" number ${NOT_FRONTMOST}`,
  'end if',
].join('\n');

/** Lines that leave the UI state in `out` (see parseUiState). */
const STATE_BODY = [
  'set frontName to ""',
  'set isFront to "missing"',
  'set winNames to {}',
  'set winSizes to {}',
  'tell application "System Events"',
  '  try',
  '    set frontName to name of first application process whose frontmost is true',
  '  end try',
  '  if exists process appName then',
  '    tell process appName',
  '      set isFront to (frontmost as text)',
  '      set winNames to name of every window',
  '      set winSizes to size of every window',
  '    end tell',
  '  end if',
  'end tell',
  'set out to frontName & linefeed & isFront',
  'repeat with i from 1 to count of winNames',
  '  set winName to item i of winNames',
  '  if winName is missing value then set winName to ""',
  '  set winW to ""',
  '  set winH to ""',
  '  try',
  '    set winSize to item i of winSizes',
  '    set winW to (item 1 of winSize) as text',
  '    set winH to (item 2 of winSize) as text',
  '  end try',
  '  set out to out & linefeed & winName & tab & winW & tab & winH',
  'end repeat',
].join('\n');

/** Reads the front app and Cubase's windows. Never activates anything. */
export function buildStateScript(appName: string): string {
  return [...header(appName), STATE_BODY, 'return out'].join('\n');
}

/** Brings Cubase to the front, waits up to ~2 s until macOS reports it frontmost and returns the UI state. */
export function buildActivateScript(appName: string): string {
  return [
    ...header(appName),
    'tell application "System Events"',
    REQUIRE_RUNNING,
    'end tell',
    // A variable target is resolved at run time: no "Where is Cubase?" dialog for a wrong name.
    'tell application appName to activate',
    'tell application "System Events"',
    '  repeat 20 times',
    '    if frontmost of process appName then exit repeat',
    '    delay 0.1',
    '  end repeat',
    'end tell',
    STATE_BODY,
    'return out',
  ].join('\n');
}

/** Sends a keystroke or key code, in the same script that checks Cubase is still in front. */
export function buildKeyScript(
  appName: string,
  key: { text: string } | { code: number },
  modifiers: Modifier[] = [],
): string {
  const action = 'text' in key ? `keystroke "${escapeAppleScript(key.text)}"` : `key code ${key.code}`;
  return [
    ...header(appName),
    'tell application "System Events"',
    REQUIRE_RUNNING,
    REQUIRE_FRONTMOST,
    `${action}${usingClause(modifiers)}`,
    'end tell',
  ].join('\n');
}

/**
 * Pastes text through the clipboard, then puts the clipboard back. "keystroke" types through the
 * keyboard layout and turns accented letters into others (Cubase 13 got "ñanda" for "ñandú").
 */
function pasteLines(text: string): string[] {
  return [
    'set savedClipboard to missing value',
    'try',
    '  set savedClipboard to the clipboard',
    'end try',
    `set the clipboard to "${escapeAppleScript(text)}"`,
    'delay 0.05',
    'keystroke "v" using {command down}',
    'delay 0.2',
    'if savedClipboard is not missing value then set the clipboard to savedClipboard',
  ];
}

export function buildTypeScript(appName: string, text: string, options: { selectAll?: boolean; pressReturn?: boolean } = {}): string {
  return [
    ...header(appName),
    'tell application "System Events"',
    REQUIRE_RUNNING,
    REQUIRE_FRONTMOST,
    ...(options.selectAll ? ['keystroke "a" using {command down}', 'delay 0.05'] : []),
    ...(/[^\x20-\x7e]/.test(text) ? pasteLines(text) : [`keystroke "${escapeAppleScript(text)}"`]),
    ...(options.pressReturn ? ['delay 0.05', 'key code 36'] : []),
    'end tell',
  ].join('\n');
}

/** AppleScript reference to a menu bar item ([i]) or a menu item ([i, j, ...]) by position. */
export function menuReference(indices: number[]): string {
  if (indices.length === 0) throw new Error('A menu reference needs at least the menu bar item');
  let reference = `menu bar item ${indices[0]} of menu bar 1`;
  for (const index of indices.slice(1)) reference = `menu item ${index} of menu 1 of ${reference}`;
  return reference;
}

/** Accessibility attributes read per menu item for its shortcut and check mark, in line order. */
const MENU_SHORTCUT_ATTRIBUTES = [
  ['itemChars', 'AXMenuItemCmdChar'],
  ['itemMods', 'AXMenuItemCmdModifiers'],
  ['itemKeys', 'AXMenuItemCmdVirtualKey'],
  ['itemGlyphs', 'AXMenuItemCmdGlyph'],
  ['itemMarks', 'AXMenuItemMarkChar'],
] as const;

/**
 * Handlers for the menu list. "attributes whose name is X" gives every item a list with 0 or 1 value
 * ("value of attribute X of every menu item" fails as a whole); a missing list or value comes out as "".
 * The command character goes out as a code point, so a tab or newline shortcut cannot break the line.
 */
const MENU_LIST_HANDLERS = [
  'on axValue(lst, i)',
  '  try',
  '    set x to item i of lst',
  '    if class of x is list then',
  '      if (count of x) is 0 then return missing value',
  '      set x to item 1 of x',
  '    end if',
  '    return x',
  '  on error',
  '    return missing value',
  '  end try',
  'end axValue',
  'on axNumber(lst, i)',
  '  set x to my axValue(lst, i)',
  '  if x is missing value then return ""',
  '  try',
  '    return (x as integer) as text',
  '  on error',
  '    return ""',
  '  end try',
  'end axNumber',
  'on axCharCode(lst, i)',
  '  set x to my axValue(lst, i)',
  '  if x is missing value then return ""',
  '  try',
  '    return (id of character 1 of (x as text)) as text',
  '  on error',
  '    return ""',
  '  end try',
  'end axCharCode',
  'on axMark(lst, i)',
  '  set x to my axValue(lst, i)',
  '  if x is missing value then return "0"',
  '  try',
  '    if (length of (x as text)) > 0 then return "1"',
  '  end try',
  '  return "0"',
  'end axMark',
].join('\n');

/**
 * Lists the menu bar ([]) or the menu under the item at `indices`, one item per line:
 * enabled<TAB>submenu count<TAB>char code<TAB>modifiers<TAB>key code<TAB>glyph<TAB>checked<TAB>name.
 * The name goes last so it may hold anything but a newline; separators come out with an empty name, so line N is "menu item N".
 * The shortcut fields stay empty unless `shortcuts` is set (five more queries per menu: only for listing).
 */
export function buildMenuListScript(appName: string, indices: number[], options: { shortcuts?: boolean } = {}): string {
  const read =
    indices.length === 0
      ? [
          '    set theMenu to menu bar 1',
          '    set itemNames to name of every menu bar item of theMenu',
          '    set itemEnabled to enabled of every menu bar item of theMenu',
        ]
      : [
          `    set theMenu to menu 1 of ${menuReference(indices)}`,
          '    set itemNames to name of every menu item of theMenu',
          '    set itemEnabled to enabled of every menu item of theMenu',
          '    set itemSubs to menus of every menu item of theMenu',
        ];
  const shortcuts =
    options.shortcuts && indices.length > 0
      ? MENU_SHORTCUT_ATTRIBUTES.flatMap(([variable, attribute]) => [
          '    try',
          `      set ${variable} to value of (attributes whose name is "${attribute}") of every menu item of theMenu`,
          '    end try',
        ])
      : [];
  return [
    ...header(appName),
    'set itemSubs to {}',
    ...MENU_SHORTCUT_ATTRIBUTES.map(([variable]) => `set ${variable} to {}`),
    'tell application "System Events"',
    REQUIRE_RUNNING,
    '  tell process appName',
    ...read,
    ...shortcuts,
    '  end tell',
    'end tell',
    'set out to {}',
    'repeat with i from 1 to count of itemNames',
    '  set itemName to item i of itemNames',
    '  if itemName is missing value then set itemName to ""',
    `  set subCount to ${indices.length === 0 ? '1' : '0'}`,
    '  try',
    '    set subCount to count of (item i of itemSubs)',
    '  end try',
    '  set end of out to ((item i of itemEnabled) as text) & tab & (subCount as text) & tab & my axCharCode(itemChars, i) & tab & ' +
      'my axNumber(itemMods, i) & tab & my axNumber(itemKeys, i) & tab & my axNumber(itemGlyphs, i) & tab & my axMark(itemMarks, i) & tab & itemName',
    'end repeat',
    'set AppleScript\'s text item delimiters to linefeed',
    'set listing to out as text',
    'set AppleScript\'s text item delimiters to ""',
    'return listing',
    MENU_LIST_HANDLERS,
  ].join('\n');
}

/**
 * Clicks the menu item at `indices`, after checking (case-sensitive) that it still has the expected label:
 * the menu can change between resolving the path and clicking.
 */
export function buildMenuClickScript(appName: string, indices: number[], expectedName: string): string {
  if (indices.length < 2) throw new Error('Menu path needs at least a menu and an item');
  return [
    ...header(appName),
    'tell application "System Events"',
    REQUIRE_RUNNING,
    REQUIRE_FRONTMOST,
    '  tell process appName',
    `    set theItem to ${menuReference(indices)}`,
    '    set itemName to name of theItem',
    '    if itemName is missing value then set itemName to ""',
    '    considering case',
    `      if itemName is not "${escapeAppleScript(expectedName)}" then error "The menu changed: expected \\"${escapeAppleScript(expectedName)}\\", found \\"" & itemName & "\\"; nothing was clicked" number ${MENU_CHANGED}`,
    '    end considering',
    '    click theItem',
    '  end tell',
    'end tell',
  ].join('\n');
}

/** Accessibility attribute -> AxElementInfo field, in the order they are read. */
const FOCUS_ATTRIBUTES: Record<string, keyof AxElementInfo> = {
  AXRole: 'role',
  AXSubrole: 'subrole',
  AXRoleDescription: 'roleDescription',
  AXTitle: 'title',
  AXDescription: 'description',
  AXValue: 'value',
  AXHelp: 'help',
  AXPlaceholderValue: 'placeholder',
  AXSelectedText: 'selectedText',
  AXEnabled: 'enabled',
  AXModal: 'modal',
};

/**
 * Reads Cubase's focused window and focused UI element without activating anything, one attribute per line:
 * section<TAB>attribute<TAB>class<TAB>value, where section is app, window or element.
 * Values escape backslash, tab, linefeed and return as \\ \t \n \r (see parseFocusInfo).
 */
export function buildFocusScript(appName: string): string {
  const attributes = Object.keys(FOCUS_ATTRIBUTES)
    .map((name) => `"${name}"`)
    .join(', ');
  return [
    ...header(appName),
    'tell application "System Events"',
    REQUIRE_RUNNING,
    '  set frontName to ""',
    '  try',
    '    set frontName to name of first application process whose frontmost is true',
    '  end try',
    '  set isFront to (frontmost of process appName) as text',
    '  set winRef to missing value',
    '  try',
    '    set winRef to value of attribute "AXFocusedWindow" of process appName',
    '  end try',
    '  set elRef to missing value',
    '  try',
    '    set elRef to value of attribute "AXFocusedUIElement" of process appName',
    '  end try',
    'end tell',
    'set out to {"app" & tab & "frontApp" & tab & "text" & tab & my esc(frontName), "app" & tab & "frontmost" & tab & "boolean" & tab & isFront}',
    'if winRef is not missing value then set out to out & my describeElement("window", winRef)',
    'if elRef is not missing value then set out to out & my describeElement("element", elRef)',
    'set AppleScript\'s text item delimiters to linefeed',
    'set listing to out as text',
    'set AppleScript\'s text item delimiters to ""',
    'return listing',
    'on describeElement(prefix, el)',
    '  set found to {prefix & tab & "present" & tab & "boolean" & tab & "true"}',
    `  repeat with attrName in {${attributes}}`,
    '    set attrName to attrName as text',
    '    try',
    '      tell application "System Events" to set v to value of attribute attrName of el',
    '      if v is not missing value then',
    '        set valueClass to (class of v) as text',
    '        set AppleScript\'s text item delimiters to ", "',
    '        set valueText to v as text',
    '        set AppleScript\'s text item delimiters to ""',
    '        set end of found to prefix & tab & attrName & tab & valueClass & tab & my esc(valueText)',
    '      end if',
    '    end try',
    '  end repeat',
    '  return found',
    'end describeElement',
    'on esc(t)',
    '  set t to t as text',
    '  set t to my rep(t, "\\\\", "\\\\\\\\")',
    '  set t to my rep(t, tab, "\\\\t")',
    '  set t to my rep(t, linefeed, "\\\\n")',
    '  set t to my rep(t, return, "\\\\r")',
    '  return t',
    'end esc',
    'on rep(t, a, b)',
    '  set AppleScript\'s text item delimiters to a',
    '  set parts to text items of t',
    '  set AppleScript\'s text item delimiters to b',
    '  set t to parts as text',
    '  set AppleScript\'s text item delimiters to ""',
    '  return t',
    'end rep',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pure helpers: output parsing
// ---------------------------------------------------------------------------

/** osascript adds one newline to what the script returns; names keep their own spaces. */
function stripTrailingNewline(output: string): string {
  return output.replace(/\r?\n$/, '');
}

export function parseUiState(output: string): UiState {
  const [frontApp = '', front = 'missing', ...lines] = stripTrailingNewline(output).split('\n');
  const toNumber = (text: string | undefined) => (text && /^-?\d+$/.test(text) ? Number(text) : null);
  const windows = lines.map((line) => {
    const [title = '', width, height] = line.split('\t');
    return { title, width: toNumber(width), height: toNumber(height) };
  });
  return { frontApp, cubaseRunning: front !== 'missing', cubaseFrontmost: front === 'true', windows };
}

export function parseMenuItems(output: string): MenuItemInfo[] {
  const text = stripTrailingNewline(output);
  if (text === '') return [];
  return text.split('\n').map((line, i) => {
    // Seven fixed fields first; the name is the rest, so a tab inside a name cannot shift them.
    const parts = line.split('\t');
    const [enabled = 'false', subs = '0', char, modifiers, virtualKey, glyph, checked] = parts.slice(0, 7);
    return {
      name: parts.slice(7).join('\t'),
      index: i + 1,
      enabled: enabled === 'true',
      submenu: Number(subs) > 0,
      shortcut: decodeMenuShortcut({
        char: toInteger(char),
        modifiers: toInteger(modifiers),
        virtualKey: toInteger(virtualKey),
        glyph: toInteger(glyph),
      }),
      checked: checked === '1',
    };
  });
}

function toInteger(field: string | undefined): number | null {
  return field && /^-?\d+$/.test(field) ? Number(field) : null;
}

/** Characters AppKit uses for special keys in key equivalents (NSUpArrowFunctionKey...), and plain control characters. */
const SHORTCUT_CHARS = new Map<number, string>([
  [0x03, 'enter'],
  [0x08, 'delete'],
  [0x09, 'tab'],
  [0x0d, 'return'],
  [0x1b, 'escape'],
  [0x20, 'space'],
  [0x7f, 'delete'],
  [0xf700, 'up'],
  [0xf701, 'down'],
  [0xf702, 'left'],
  [0xf703, 'right'],
  [0xf728, 'forwarddelete'],
  [0xf729, 'home'],
  [0xf72b, 'end'],
  [0xf72c, 'pageup'],
  [0xf72d, 'pagedown'],
]);
// NSF1FunctionKey (0xF704) .. NSF12FunctionKey.
for (let n = 1; n <= 12; n++) SHORTCUT_CHARS.set(0xf703 + n, `f${n}`);

/** Carbon menu glyphs (kMenuReturnGlyph...), used when the character says nothing. */
const SHORTCUT_GLYPHS = new Map<number, string>([
  [0x02, 'tab'],
  [0x04, 'enter'],
  [0x09, 'space'],
  [0x0a, 'forwarddelete'],
  [0x0b, 'return'],
  [0x17, 'delete'],
  [0x1b, 'escape'],
  [0x1c, 'padclear'],
  [0x62, 'pageup'],
  [0x64, 'left'],
  [0x65, 'right'],
  [0x68, 'up'],
  [0x6a, 'down'],
  [0x6b, 'pagedown'],
]);
// kMenuF1Glyph (0x6F) .. kMenuF12Glyph.
for (let n = 1; n <= 12; n++) SHORTCUT_GLYPHS.set(0x6e + n, `f${n}`);

/** How a ui_key name shows in a menu (F keys and pad keys are spelled out). */
const KEY_SYMBOLS: Record<string, string> = {
  return: '↩',
  enter: '⌤',
  tab: '⇥',
  space: 'Space',
  delete: '⌫',
  forwarddelete: '⌦',
  escape: '⎋',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  home: '↖',
  end: '↘',
  pageup: '⇞',
  pagedown: '⇟',
  padenter: 'Pad⌤',
  padequals: 'Pad=',
  padclear: 'Pad⌧',
};

/** Menu order (⌃⌥⇧⌘) and the AXMenuItemCmdModifiers bit of each modifier (Command is on unless bit 8 is set). */
const SHORTCUT_MODIFIERS: { modifier: Modifier; symbol: string; on: (mask: number) => boolean }[] = [
  { modifier: 'control', symbol: '⌃', on: (mask) => (mask & 4) !== 0 },
  { modifier: 'option', symbol: '⌥', on: (mask) => (mask & 2) !== 0 },
  { modifier: 'shift', symbol: '⇧', on: (mask) => (mask & 1) !== 0 },
  { modifier: 'command', symbol: '⌘', on: (mask) => (mask & 8) === 0 },
];

/** The order of ui_keystroke's own example (["command", "shift"]). */
const MODIFIER_ORDER: Modifier[] = ['command', 'shift', 'option', 'control'];

function keyLabel(key: string): string {
  if (key in KEY_SYMBOLS) return KEY_SYMBOLS[key];
  if (/^pad./.test(key) && key in KEY_CODES) return `Pad${key.slice(3)}`;
  return key.toUpperCase();
}

/**
 * Turns a menu item's raw key equivalent into what the menu shows and what ui_keystroke / ui_key need.
 * A key code ui_key knows wins (Finder reports Delete as a control character plus key code 51),
 * then the character, then the glyph. Without a character or a key code there is no shortcut, whatever
 * the modifiers say (macOS reports 0 or 8 for items without one).
 */
export function decodeMenuShortcut(raw: RawMenuShortcut): MenuShortcut | null {
  const hasChar = raw.char !== null && raw.char > 0;
  if (!hasChar && raw.virtualKey === null) return null;
  let key = raw.virtualKey !== null ? KEY_NAMES_BY_CODE.get(raw.virtualKey) : undefined;
  if (key === undefined && hasChar) {
    key = SHORTCUT_CHARS.get(raw.char!);
    if (key === undefined && raw.char! > 0x20 && raw.char! !== 0x7f && (raw.char! < 0xf700 || raw.char! > 0xf8ff)) {
      key = String.fromCodePoint(raw.char!).toLowerCase();
    }
  }
  if (key === undefined && raw.glyph !== null) key = SHORTCUT_GLYPHS.get(raw.glyph);
  if (key === undefined) return null;
  const active = SHORTCUT_MODIFIERS.filter((m) => m.on(raw.modifiers ?? 0));
  return {
    text: active.map((m) => m.symbol).join('') + keyLabel(key),
    modifiers: MODIFIER_ORDER.filter((modifier) => active.some((m) => m.modifier === modifier)),
    key,
  };
}

/** Undoes the escaping of buildFocusScript (\\ \t \n \r). */
export function unescapeFocusValue(text: string): string {
  return text.replace(/\\([\\tnr])/g, (_, c: string) => ({ t: '\t', n: '\n', r: '\r' })[c] ?? '\\');
}

export function parseFocusInfo(output: string): FocusInfo {
  const info: FocusInfo = { frontApp: '', cubaseFrontmost: false, window: null, element: null };
  const text = stripTrailingNewline(output);
  if (text === '') return info;
  for (const line of text.split('\n')) {
    const [section, attribute = '', valueClass = '', ...rest] = line.split('\t');
    const value = unescapeFocusValue(rest.join('\t'));
    if (section === 'app') {
      if (attribute === 'frontApp') info.frontApp = value;
      else if (attribute === 'frontmost') info.cubaseFrontmost = value === 'true';
      continue;
    }
    if (section !== 'window' && section !== 'element') continue;
    const target = (info[section] ??= {});
    const field = FOCUS_ATTRIBUTES[attribute];
    if (field === undefined) continue;
    if (field === 'enabled' || field === 'modal') {
      target[field] = value === 'true';
    } else if (field !== 'valueClass') {
      target[field] = value;
      if (field === 'value') target.valueClass = valueClass;
    }
  }
  return info;
}

/** Titles that appeared or went away; windows without a title only count. */
export function diffWindows(before: WindowInfo[], after: WindowInfo[]): WindowChanges {
  const remaining = new Map<string, number>();
  for (const w of before) if (w.title) remaining.set(w.title, (remaining.get(w.title) ?? 0) + 1);
  const opened: string[] = [];
  for (const w of after) {
    if (!w.title) continue;
    const left = remaining.get(w.title) ?? 0;
    if (left > 0) remaining.set(w.title, left - 1);
    else opened.push(w.title);
  }
  const closed: string[] = [];
  for (const [title, count] of remaining) for (let i = 0; i < count; i++) closed.push(title);
  const untitled = (list: WindowInfo[]) => list.filter((w) => !w.title).length;
  return { opened, closed, untitledDelta: untitled(after) - untitled(before) };
}

/** Builds the result of a key or menu action from the UI state before and after it. */
export function describeAction(appName: string, before: UiState, after: UiState): UiActionReport {
  const changes = diffWindows(before.windows, after.windows);
  const notes: string[] = [];
  if (!after.cubaseFrontmost) {
    notes.push(
      `${appName} is no longer frontmost (front app: "${after.frontApp || 'unknown'}"). ` +
        'macOS hides plugin editors while Cubase is in the background, so its window list may be incomplete.',
    );
  }
  if (changes.untitledDelta !== 0) {
    notes.push(
      `${Math.abs(changes.untitledDelta)} window(s) without a title ${changes.untitledDelta > 0 ? 'opened' : 'closed'}: ` +
        'which one is unknown (Cubase leaves many windows untitled; short-lived ones can be tooltips).',
    );
  }
  return {
    frontApp: after.frontApp,
    cubaseFrontmost: after.cubaseFrontmost,
    frontWindow: after.windows[0]?.title ?? null,
    ...changes,
    ...(notes.length ? { notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: menu label matching
// ---------------------------------------------------------------------------

export type MatchKind = 'exact' | 'normalized' | 'accents';

/** Case, '…' vs '...', repeated or non-breaking spaces and Unicode form do not matter. */
export function normalizeMenuLabel(label: string): string {
  return label
    .normalize('NFC')
    .replace(/…/g, '...')
    .replace(/[\s ]+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripAccents(label: string): string {
  return label.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Finds a menu item by label: exact first, then normalized, then also ignoring accents.
 * Never matches a prefix: Cubase labels such as "Deshacer <acción>" change, and a prefix could hit the wrong item.
 * With repeated labels (Cubase has two "Pegar") the first one wins, as it would in AppleScript.
 */
export function matchMenuItem(items: MenuItemInfo[], label: string): { item: MenuItemInfo; matchedBy: MatchKind } | null {
  const named = items.filter((item) => item.name !== '');
  const exact = named.find((item) => item.name === label);
  if (exact) return { item: exact, matchedBy: 'exact' };
  const wanted = normalizeMenuLabel(label);
  const normalized = named.find((item) => normalizeMenuLabel(item.name) === wanted);
  if (normalized) return { item: normalized, matchedBy: 'normalized' };
  const bare = stripAccents(wanted);
  const accents = named.find((item) => stripAccents(normalizeMenuLabel(item.name)) === bare);
  if (accents) return { item: accents, matchedBy: 'accents' };
  return null;
}

/** "Archivo", "Exportar >" for submenus, "(Rehacer)" for disabled items: what an error shows of a menu. */
export function formatMenuItems(items: MenuItemInfo[]): string {
  return items
    .filter((item) => item.name !== '')
    .map((item) => {
      const label = item.submenu ? `${item.name} >` : item.name;
      return item.enabled ? label : `(${label})`;
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// Pure helpers: errors
// ---------------------------------------------------------------------------

export interface AppleScriptError {
  code: number | null;
  /** macOS's (possibly localized) text without the "0:45: execution error:" prefix and the code. */
  text: string;
}

export function parseAppleScriptError(stderr: string): AppleScriptError {
  let text = stderr.trim().split('\n').filter(Boolean).pop() ?? '';
  text = text.replace(/^\d+:\d+:\s*/, '').replace(/^(execution error|error de ejecución):\s*/i, '');
  const match = text.match(/\((-?\d+)\)\s*$/);
  const code = match ? Number(match[1]) : null;
  if (match) text = text.slice(0, match.index).trim();
  return { code, text };
}

const ACCESSIBILITY_HINT =
  'macOS denied UI control: allow the app that runs the MCP server (Claude, Terminal, iTerm...) in ' +
  'System Settings > Privacy & Security > Accessibility, then restart that app';
const AUTOMATION_HINT =
  'macOS denied sending Apple events: allow the app that runs the MCP server to control "System Events" (and Cubase) in ' +
  'System Settings > Privacy & Security > Automation';

/** Picks the hint from the error number (not every AppleScript failure is a permission problem); macOS's text goes last. */
export function describeAppleScriptError(stderr: string, context: UiContext, appName: string): string {
  const { code, text } = parseAppleScriptError(stderr);
  const appHint =
    `Cubase process "${appName}" not found: check that Cubase is running and that CUBASE_MCP_APP_NAME matches ` +
    'its process name (Activity Monitor shows it, e.g. "Cubase 13")';
  let hint: string;
  if (code === NOT_FRONTMOST || code === MENU_CHANGED) {
    return text;
  } else if (code === -25211 || code === 1002 || (code === -1719 && /assistive|asistencia|accesib/i.test(text))) {
    hint = ACCESSIBILITY_HINT;
  } else if (code === -1743) {
    hint = AUTOMATION_HINT;
  } else if (code === NOT_RUNNING || (context === 'activate' && (code === -1728 || code === -2753 || code === -43 || code === -10814))) {
    hint = appHint;
  } else if ((code === -1728 || code === -1719) && context === 'menu') {
    hint = 'Menu or menu item not found (labels are localized and some change with the project state): list them with ui_list_menu';
  } else if (code === -1719 && context === 'window') {
    hint = 'Cubase has no window in front';
  } else if (code === -1728) {
    hint = 'The UI element was not found';
  } else if (code === -1712) {
    hint = 'Cubase did not answer in time (busy, or a modal dialog is open)';
  } else {
    hint = 'AppleScript failed';
  }
  const detail = text ? `${text}${code !== null ? ` (${code})` : ''}` : code !== null ? `error ${code}` : '';
  return detail ? `${hint}. macOS: ${detail}` : hint;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class MacUi {
  constructor(
    private readonly appName: string,
    private readonly enabled: boolean,
  ) {}

  private ensureEnabled(): void {
    if (process.platform !== 'darwin') throw new Error('UI automation is only available on macOS');
    if (!this.enabled) {
      throw new Error('UI automation is disabled. Set CUBASE_MCP_ENABLE_UI=1 in the MCP server environment to enable it.');
    }
  }

  private run(script: string, context: UiContext): Promise<string> {
    return osascript(script, context, this.appName);
  }

  /** Brings Cubase to the front and returns the UI state once macOS reports it frontmost (or after ~2 s). */
  async activate(): Promise<UiState> {
    this.ensureEnabled();
    return parseUiState(await this.run(buildActivateScript(this.appName), 'activate'));
  }

  /** Front app and Cubase windows, without activating Cubase. */
  async state(): Promise<UiState> {
    this.ensureEnabled();
    return parseUiState(await this.run(buildStateScript(this.appName), 'window'));
  }

  /** Cubase's focused window and UI element as Accessibility reports them; activates Cubase only when asked. */
  async focus(options: { activate?: boolean } = {}): Promise<FocusInfo> {
    this.ensureEnabled();
    if (options.activate) await this.activate();
    return parseFocusInfo(await this.run(buildFocusScript(this.appName), 'window'));
  }

  async keystroke(text: string, modifiers: Modifier[] = []): Promise<UiActionReport> {
    return this.act(buildKeyScript(this.appName, { text }, modifiers), 'keys');
  }

  async keyCode(key: string, modifiers: Modifier[] = []): Promise<UiActionReport> {
    this.ensureEnabled();
    return this.act(buildKeyScript(this.appName, { code: keyCodeFor(key) }, modifiers), 'keys');
  }

  async typeText(text: string, options: { selectAll?: boolean; pressReturn?: boolean } = {}): Promise<UiActionReport> {
    return this.act(buildTypeScript(this.appName, text, options), 'keys');
  }

  /** Clicks a menu item by path, e.g. ["Archivo", "Exportar", "Mezcla de audio..."]. */
  async clickMenu(path: string[]): Promise<ClickMenuReport> {
    this.ensureEnabled();
    if (path.length < 2) throw new Error('Menu path needs at least a menu and an item');
    const resolved = await this.resolveMenuPath(path);
    const target = resolved.items[resolved.items.length - 1];
    const where = resolved.labels.join(' > ');
    if (target.submenu) throw new Error(`"${where}" opens a submenu: add one of its items to the path (see ui_list_menu)`);
    if (!target.enabled) throw new Error(`"${where}" is disabled in Cubase right now; nothing was clicked`);
    const report = await this.act(buildMenuClickScript(this.appName, resolved.indices, target.name), 'menu');
    return { clicked: resolved.labels, matchedBy: resolved.matchedBy, ...report };
  }

  /** Lists the menu bar (empty path) or the items of the menu at `path`, e.g. ["Transporte", "Comandos de transporte"]. */
  async listMenu(path: string[]): Promise<{ path: string[]; items: MenuItemInfo[] }> {
    this.ensureEnabled();
    if (path.length === 0) {
      return { path: [], items: parseMenuItems(await this.run(buildMenuListScript(this.appName, []), 'menu')) };
    }
    const resolved = await this.resolveMenuPath(path);
    const last = resolved.items[resolved.items.length - 1];
    if (!last.submenu) throw new Error(`"${resolved.labels.join(' > ')}" is a menu item, not a menu`);
    const items = parseMenuItems(await this.run(buildMenuListScript(this.appName, resolved.indices, { shortcuts: true }), 'menu'));
    return { path: resolved.labels, items };
  }

  /** Walks the menus level by level, matching each label against what macOS lists (one osascript per level). */
  private async resolveMenuPath(path: string[]) {
    const indices: number[] = [];
    const labels: string[] = [];
    const matchedBy: MatchKind[] = [];
    const items: MenuItemInfo[] = [];
    let level = parseMenuItems(await this.run(buildMenuListScript(this.appName, []), 'menu'));
    for (let depth = 0; depth < path.length; depth++) {
      const match = matchMenuItem(level, path[depth]);
      if (!match) {
        const parent = labels.length ? `Menu "${labels.join(' > ')}"` : 'The menu bar';
        throw new Error(
          `${parent} has no item "${path[depth]}". Available: ${formatMenuItems(level) || '(none)'}. ` +
            'Cubase labels are localized and some change with the project state (e.g. "Deshacer <acción>"); parentheses mark disabled items and ">" submenus.',
        );
      }
      indices.push(match.item.index);
      labels.push(match.item.name);
      matchedBy.push(match.matchedBy);
      items.push(match.item);
      if (depth < path.length - 1) {
        if (!match.item.submenu) throw new Error(`"${labels.join(' > ')}" has no submenu`);
        level = parseMenuItems(await this.run(buildMenuListScript(this.appName, indices), 'menu'));
      }
    }
    return { indices, labels, matchedBy, items };
  }

  /** Activates Cubase, runs the action (which re-checks the focus itself) and reports what changed. */
  private async act(script: string, context: UiContext): Promise<UiActionReport> {
    this.ensureEnabled();
    const before = await this.activate();
    if (!before.cubaseFrontmost) {
      throw new Error(`${this.appName} did not come to the front (front app: "${before.frontApp || 'unknown'}"); nothing was sent`);
    }
    await this.run(script, context);
    await delay(SETTLE_AFTER_ACTION_MS);
    const after = await this.state();
    return describeAction(this.appName, before, after);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function osascript(script: string, context: UiContext, appName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: OSASCRIPT_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject(
            new Error(
              `osascript did not finish within ${OSASCRIPT_TIMEOUT_MS / 1000} s (Cubase busy, or a modal dialog kept System Events waiting). ` +
                'The action may have run: check with ui_front_window before repeating it.',
            ),
          );
        } else {
          reject(new Error(describeAppleScriptError(stderr || error.message, context, appName)));
        }
      } else {
        resolve(stripTrailingNewline(stdout));
      }
    });
  });
}
