import { existsSync, readFileSync } from 'node:fs';

/** A key command the bridge script binds, by Cubase internal name, with its on-screen label when it differs. */
export interface CommandEntry {
  category: string;
  name: string;
  /** "Category / Name" as listed on screen in the MIDI Remote README, when it is not the internal name. */
  label?: string;
}

/** Loads build/commands.json (written by scripts/build-cubase-script.mjs). */
export function loadCommandCatalog(file: string): CommandEntry[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<CommandEntry | [string, string]>;
  // Builds before internal names were introduced stored [category, name] pairs.
  return raw.map((entry) => (Array.isArray(entry) ? { category: entry[0], name: entry[1] } : entry));
}

export interface ResolvedCommand {
  category: string;
  name: string;
  /** The label the caller used, when it had to be translated to the internal name. */
  from?: string;
}

/**
 * Maps a command given by internal name or by on-screen label to the internal name the
 * script bound. Cubase silently ignores labels, so they are never sent as they are.
 * A name the catalog does not know (a macro the user added later, a typo) is sent unchanged
 * and the script reports whether it is bound.
 */
export function resolveCommand(commands: CommandEntry[], category: string, name: string): ResolvedCommand {
  const exact = commands.find((c) => c.category === category && c.name === name);
  if (exact) return { category, name };
  const label = `${category} / ${name}`.toLowerCase();
  const matches = commands.filter((c) => c.label?.toLowerCase() === label || `${c.category} / ${c.name}`.toLowerCase() === label);
  if (matches.length === 1) {
    const [match] = matches;
    return match.category === category && match.name === name ? { category, name } : { category: match.category, name: match.name, from: `${category} / ${name}` };
  }
  if (matches.length > 1) {
    throw new Error(`"${category} / ${name}" matches several commands: ${matches.map((c) => `${c.category} / ${c.name}`).join(', ')}`);
  }
  return { category, name };
}

/**
 * Every Cubase 13 key command by internal name, with its on-screen label (commands/cubase13-internal-names.json,
 * rows [labelCategory, labelName, category, name]). Empty when the file is missing.
 */
export function loadInternalNames(file: string): CommandEntry[] {
  if (!existsSync(file)) return [];
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<[string, string, string, string]>;
  return rows.map(([labelCategory, labelName, category, name]) => {
    const label = `${labelCategory} / ${labelName}`;
    return label !== `${category} / ${name}` ? { category, name, label } : { category, name };
  });
}

/** Levenshtein distance (for close matches of a mistyped command). */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}+-]+/u).filter(Boolean));

/** How alike two command texts are, 0..~1.3: spelling, shared words, and one containing the other. */
function similarity(query: string, candidate: string): number {
  const a = query.toLowerCase().trim();
  const b = candidate.toLowerCase().trim();
  if (!a || !b) return 0;
  const spelling = 1 - distance(a, b) / Math.max(a.length, b.length);
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length / Math.max(wa.size, wb.size, 1);
  return Math.max(spelling, shared) + (a.includes(b) || b.includes(a) ? 0.3 : 0);
}

/** The commands most like "category / name" (internal names and labels), best first. */
export function closeCommands(commands: CommandEntry[], category: string, name: string, limit = 5): CommandEntry[] {
  const full = `${category} / ${name}`;
  const scored = commands.map((c) => {
    const texts = [`${c.category} / ${c.name}`, ...(c.label ? [c.label] : [])];
    const names = [c.name, ...(c.label ? [c.label.slice(c.label.indexOf(' / ') + 3)] : [])];
    const score = Math.max(...texts.map((t) => similarity(full, t)), ...names.map((n) => similarity(name, n) * 0.9));
    return { c, score };
  });
  return scored
    .filter((s) => s.score >= 0.55)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.c);
}
