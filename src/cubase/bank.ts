/**
 * Channel references and mixer bank arithmetic, kept free of I/O so they can be tested alone.
 *
 * Cubase's MIDI Remote mixer bank is a window of `size` slots over the MixConsole channels. It moves
 * by offset, not by fixed pages: next = min(offset + size, total - 1), prev = max(offset - size, 0),
 * shifts move it by one, reset goes back to 0. From a reset the pages start at 0, size, 2*size..., and
 * a next from the last page leaves a page with only the last channel. The script cannot read or set
 * the offset, so the server works it out from the channels' unique ids.
 */

/**
 * A channel named exactly: name is taken literally (no "#N" suffix is read), occurrence picks the Nth channel with
 * that exact name in MixConsole order, and exact (default true) turns off the prefix and substring fallbacks.
 */
export interface ChannelSpec {
  name: string;
  occurrence?: number;
  exact?: boolean;
}

export type ChannelRef = number | string | ChannelSpec;

export type BankAction = 'reset' | 'next' | 'prev' | 'shiftLeft' | 'shiftRight';

export type ParsedChannelRef = { kind: 'index'; index: number } | ({ kind: 'name'; name: string } & NameOptions);

/** How a name is matched: exact only (no prefix or substring), the Nth exact match, literal (no "#N" suffix). */
export interface NameOptions {
  exact?: boolean;
  occurrence?: number;
  literal?: boolean;
}

/** How a channel reference was resolved. */
export type MatchKind = 'index' | 'exact' | 'occurrence' | 'prefix' | 'substring';

/** A channel seen while paging through the bank. */
export interface BankEntry {
  /** 1-based bank page counted from the first channel (after a bank reset). */
  page: number;
  /** Bank index of the channel on that page. */
  index: number;
  /** 0-based position in MixConsole bank order. */
  position: number;
  title: string;
  uid: string | null;
}

export interface NameMatch extends BankEntry {
  matchedBy: MatchKind;
}

/**
 * Reads a channel reference. Numbers, and texts made only of digits (MCP clients sometimes send "12"),
 * are bank indexes. Other texts are names; blank names and number-like texts that are not valid indexes
 * ("37.5", "-1") are rejected instead of being searched as names.
 */
export function parseChannelRef(ref: ChannelRef): ParsedChannelRef {
  if (ref !== null && typeof ref === 'object') {
    const name = String(ref.name ?? '').trim();
    if (!name) throw new Error('Channel name is blank: pass a bank index or a channel name');
    const { occurrence } = ref;
    if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1)) {
      throw new Error(`occurrence must be a whole number from 1 (got ${occurrence})`);
    }
    if (occurrence !== undefined && ref.exact === false) throw new Error('occurrence counts the channels with exactly this name: it cannot be used with exact: false');
    return { kind: 'name', name, exact: ref.exact !== false, literal: true, ...(occurrence !== undefined ? { occurrence } : {}) };
  }
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 0) throw new Error(`Channel index must be a whole number from 0 (got ${ref})`);
    return { kind: 'index', index: ref };
  }
  const text = String(ref ?? '').trim();
  if (!text) throw new Error('Channel name is blank: pass a bank index or a channel name');
  if (/^\d+$/.test(text)) return { kind: 'index', index: Number(text) };
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) {
    throw new Error(`Channel "${text}" is not a valid bank index: indexes are whole numbers from 0 (see cubase_list_channels)`);
  }
  return { kind: 'name', name: text };
}

/** Short label for messages: "G L" (page 1, index 37, uid ...). */
export function describeEntry(entry: BankEntry): string {
  return `"${entry.title}" (page ${entry.page}, index ${entry.index}${entry.uid ? `, uid ${entry.uid}` : ''})`;
}

/** A reference for messages: a name, an index, or {name, occurrence} as JSON. */
export function describeRef(ref: ChannelRef): string {
  return typeof ref === 'object' && ref !== null ? JSON.stringify(ref) : String(ref);
}

function ambiguous(name: string, how: string, candidates: BankEntry[], hint: string): Error {
  const shown = candidates.slice(0, 12).map(describeEntry).join(', ');
  const more = candidates.length > 12 ? ` and ${candidates.length - 12} more` : '';
  const error = new Error(`Channel "${name}" is ambiguous: ${candidates.length} channels ${how}: ${shown}${more}. ${hint}`);
  (error as Error & { candidates?: BankEntry[] }).candidates = candidates;
  return error;
}

/**
 * Finds a channel by name among bank entries (in MixConsole order), ignoring case: an exact name, then
 * "name#N" for the Nth channel with that exact name, then a unique prefix, then a unique substring.
 * Several matches at the first level that has any throw an error that lists them (page, index and uid).
 * options.exact stops after the exact name, options.occurrence picks the Nth channel with the exact name, and
 * options.literal does not read a "#N" suffix (the name is the whole text).
 */
export function matchChannelName(entries: BankEntry[], name: string, where = 'any mixer bank page', options: NameOptions = {}): NameMatch {
  const needle = name.toLowerCase();
  const exact = entries.filter((e) => e.title.toLowerCase() === needle);
  if (options.occurrence !== undefined) {
    const n = options.occurrence;
    if (exact.length === 0) throw new Error(`No channel is named exactly "${name}" in ${where}`);
    if (n > exact.length) {
      throw new Error(`There ${exact.length === 1 ? 'is 1 channel' : `are ${exact.length} channels`} named "${name}" (occurrence 1..${exact.length}): ${exact.map(describeEntry).join(', ')}`);
    }
    return { ...exact[n - 1], matchedBy: n === 1 && exact.length === 1 ? 'exact' : 'occurrence' };
  }
  if (exact.length === 1) return { ...exact[0], matchedBy: 'exact' };
  if (exact.length > 1) {
    // "Bass" and "BASS": the one written exactly like the request wins.
    const sameCase = exact.filter((e) => e.title === name);
    if (sameCase.length === 1) return { ...sameCase[0], matchedBy: 'exact' };
    throw ambiguous(
      name,
      'have this name',
      exact,
      `Add #N for the Nth one in MixConsole order (e.g. "${exact[0].title}#2" or {"name": ${JSON.stringify(exact[0].title)}, "occurrence": 2}), or pass the bank index of one on the current page.`,
    );
  }
  const occurrence = options.literal ? null : /^(.*?)\s*#(\d+)$/.exec(name);
  if (occurrence && occurrence[1].trim()) {
    const base = occurrence[1].trim();
    const same = entries.filter((e) => e.title.toLowerCase() === base.toLowerCase());
    const n = Number(occurrence[2]);
    if (same.length > 0) {
      if (n >= 1 && n <= same.length) return { ...same[n - 1], matchedBy: 'occurrence' };
      throw new Error(`There ${same.length === 1 ? 'is 1 channel' : `are ${same.length} channels`} named "${base}" (use #1..#${same.length}): ${same.map(describeEntry).join(', ')}`);
    }
  }
  if (options.exact) throw new Error(`No channel is named exactly "${name}" in ${where} (exact match: prefixes and substrings are not tried)`);
  for (const [kind, test] of [
    ['prefix', (title: string) => title.startsWith(needle)],
    ['substring', (title: string) => title.includes(needle)],
  ] as const) {
    const hits = entries.filter((e) => test(e.title.toLowerCase()));
    if (hits.length === 1) return { ...hits[0], matchedBy: kind };
    if (hits.length > 1) {
      throw ambiguous(name, `${kind === 'prefix' ? 'start with' : 'contain'} it`, hits, 'Pass the exact name (add #N if it repeats) or the bank index of one on the current page.');
    }
  }
  throw new Error(`Channel "${name}" not found in ${where}`);
}

/** Bank offset after an action, for a bank of `total` channels and `size` slots. */
export function applyBankAction(offset: number, action: BankAction, total: number, size: number): number {
  const last = Math.max(total - 1, 0);
  switch (action) {
    case 'reset':
      return 0;
    case 'next':
      return Math.min(offset + size, last);
    case 'prev':
      return Math.max(offset - size, 0);
    case 'shiftLeft':
      return Math.max(offset - 1, 0);
    case 'shiftRight':
      return Math.min(offset + 1, last);
  }
}

/** Shortest list of bank actions found to move the bank from one offset (null = unknown) to another. */
export function planBankMoves(from: number | null, to: number, total: number, size: number): BankAction[] {
  const repeat = (action: BankAction, n: number): BankAction[] => Array.from({ length: Math.max(n, 0) }, () => action);
  /** To a page offset (a multiple of size): next/prev from a page offset, or reset and next, whichever is shorter. */
  const toPage = (page: number): BankAction[] => {
    const viaReset: BankAction[] = ['reset', ...repeat('next', page / size)];
    if (from !== null && from % size === 0 && from < total) {
      const steps = page / size - from / size;
      const direct = repeat(steps > 0 ? 'next' : 'prev', Math.abs(steps));
      return direct.length <= viaReset.length ? direct : viaReset;
    }
    return viaReset;
  };
  const base = Math.floor(to / size) * size;
  const options: BankAction[][] = [[...toPage(base), ...repeat('shiftRight', to - base)]];
  if (to !== base && base + size <= total - 1) options.push([...toPage(base + size), ...repeat('shiftLeft', base + size - to)]);
  // The page after the last one shows only the last channel.
  if (to === total - 1 && to !== base) options.push([...toPage(base), 'next']);
  if (from !== null) options.push(repeat(to > from ? 'shiftRight' : 'shiftLeft', Math.abs(to - from)));
  return options.reduce((best, option) => (option.length < best.length ? option : best));
}
