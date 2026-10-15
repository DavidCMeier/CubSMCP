import { join, relative, isAbsolute, sep } from 'node:path';
import type { SnapshotPage } from './client.js';

/**
 * Mix snapshots. Channels are identified by Cubase's unique channel id, with the name and its
 * occurrence (first "BASS", second "BASS"...) as a fallback, because projects repeat channel names.
 */

export interface SnapshotChannel {
  uid: string | null;
  name: string;
  /** 1 for the first channel with this name in project order, 2 for the second... */
  occurrence: number;
  values: Record<string, number | null>;
}

export interface MixSnapshot {
  version: 2;
  name: string;
  createdAt: string;
  allPages: boolean;
  /**
   * A channel was soloed when the snapshot was taken: Cubase then shows solo-implied mutes and solos, so mute
   * and solo were not saved (null) and are not restored.
   */
  soloActive?: boolean;
  channels: SnapshotChannel[];
}

/** Fields Cubase shows solo-implied values for while a channel is soloed. */
export const SOLO_MASKED_FIELDS = ['mute', 'solo'];

/** Saved for information (the channel followed its automation), never restored. */
export const INFO_FIELDS = ['autoRead'];

/**
 * Fields that automation can override. Cubase does not tell which parameters of a channel have automation data, so
 * with automation read on every one of them may follow its automation as soon as the transport moves (solo cannot be automated).
 */
export function isAutomatable(field: string): boolean {
  return field !== 'solo' && !INFO_FIELDS.includes(field);
}

/** Whether a channel's values (in `fields` order) say automation read is on. */
export function automationReadOn(fields: string[], values: Array<number | null>): boolean {
  const i = fields.indexOf('autoRead');
  return i >= 0 && (values[i] ?? 0) > 0.5;
}

/**
 * Path of a snapshot inside the snapshot folder. The name loses a ".json" ending and every character outside
 * letters, digits, "_", "-" and "." becomes "_", so it cannot name another folder ("../x" -> ".._x.json").
 */
export function snapshotPath(dir: string, name: string): string {
  const base = name.trim().replace(/\.json$/i, '').replace(/[^\w.-]+/g, '_');
  if (!base || /^\.+$/.test(base)) throw new Error(`"${name}" is not a usable snapshot name: use letters, digits, "_", "-" or "."`);
  const file = join(dir, `${base}.json`);
  const inside = relative(dir, file);
  if (!inside || inside.split(sep)[0] === '..' || isAbsolute(inside)) throw new Error(`"${name}" is not a usable snapshot name`);
  return file;
}

/** Values closer than this need no write. */
const UNCHANGED = 0.0005;
/** Read-backs closer than this count as restored (Cubase snaps some controls, e.g. the 0 dB fader detent). */
export const RESTORED = 0.01;
/** A read-back this close to the value before the write means Cubase ignored the write. */
export const IGNORED = 0.0005;

/** Builds a snapshot from bank pages, skipping channels seen twice (by uid, e.g. a page that only repeats the last channel). */
export class SnapshotCollector {
  readonly channels: SnapshotChannel[] = [];
  private readonly seen = new Set<string>();
  private readonly occurrences = new Map<string, number>();

  /** Names of the channels Cubase showed soloed (the soloed ones and the ones they feed). */
  readonly soloed: string[] = [];

  /** Channels with automation read on, named like channel references ("G L#2" for the second "G L"). */
  readonly automated: string[] = [];

  add(page: SnapshotPage): void {
    const solo = page.fields.indexOf('solo');
    for (const channel of page.channels) {
      const key = channel.uid ?? `${channel.index}:${channel.title}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const occurrence = (this.occurrences.get(channel.title) ?? 0) + 1;
      this.occurrences.set(channel.title, occurrence);
      const values: Record<string, number | null> = {};
      page.fields.forEach((field, i) => {
        values[field] = channel.values[i] ?? null;
      });
      this.channels.push({ uid: channel.uid, name: channel.title, occurrence, values });
      if (solo >= 0 && (channel.values[solo] ?? 0) > 0.5) this.soloed.push(channel.title);
      if (automationReadOn(page.fields, channel.values)) this.automated.push(occurrence > 1 ? `${channel.title}#${occurrence}` : channel.title);
    }
  }

  /** True when a channel was soloed: mute and solo are then left out (null), since Cubase showed solo-implied values. */
  get soloActive(): boolean {
    return this.soloed.length > 0;
  }

  /** The channels to save: without mute and solo when a solo was active. */
  result(): SnapshotChannel[] {
    if (!this.soloActive) return this.channels;
    return this.channels.map((c) => ({ ...c, values: { ...c.values, ...Object.fromEntries(SOLO_MASKED_FIELDS.map((f) => [f, null])) } }));
  }
}

/**
 * Checks that parsed JSON is a mix snapshot and fills in what older snapshots lack: snapshots saved before
 * version 2 have no uid or occurrence, so the occurrence is rebuilt from file order. Entries that are not
 * objects are left out. A snapshot with a channel saved soloed comes from a time Cubase showed solo-implied
 * mutes and solos (or from before this was checked): its mute and solo values are dropped.
 */
export function normalizeSnapshot(data: unknown, file = 'The file'): MixSnapshot {
  const raw = data as (Partial<Omit<MixSnapshot, 'channels'>> & { channels?: unknown }) | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.channels)) {
    throw new Error(`${file} is not a mix snapshot: it has no "channels" list (save one with cubase_snapshot_mix)`);
  }
  const entries = (raw.channels as unknown[]).filter((c): c is Partial<SnapshotChannel> => Boolean(c) && typeof c === 'object' && !Array.isArray(c));
  if (entries.length === 0) throw new Error(`${file} is a mix snapshot without channels: nothing to restore`);
  const occurrences = new Map<string, number>();
  let channels = entries.map((channel) => {
    const name = typeof channel.name === 'string' ? channel.name : '';
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const values = channel.values && typeof channel.values === 'object' && !Array.isArray(channel.values) ? channel.values : {};
    return {
      uid: typeof channel.uid === 'string' ? channel.uid : null,
      name,
      occurrence: typeof channel.occurrence === 'number' ? channel.occurrence : occurrence,
      values,
    };
  });
  const soloActive = raw.soloActive === true || channels.some((c) => typeof c.values.solo === 'number' && c.values.solo > 0.5);
  if (soloActive) {
    channels = channels.map((c) => ({ ...c, values: { ...c.values, ...Object.fromEntries(SOLO_MASKED_FIELDS.map((f) => [f, null])) } }));
  }
  return {
    version: 2,
    name: typeof raw.name === 'string' ? raw.name : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    allPages: raw.allPages === true,
    ...(soloActive ? { soloActive } : {}),
    channels,
  };
}

export interface LiveChannel {
  /** Identifies the channel while restoring: its uid, or page and index without one. */
  key: string;
  title: string;
  uid: string | null;
}

/**
 * Matches live channels, in project order, to snapshot channels: by unique id first and then, for
 * whatever is left on both sides, by name in project order. Done over the whole project at once so a
 * new channel with a repeated name cannot take the place of the one the snapshot saved.
 * partial: the live channels are only part of the project (one bank page of a whole-project snapshot). Then
 * only saved channels without uid and with a name nobody else has in the snapshot are paired by name (a
 * repeated name could take another page's values), and saved channels not seen are notChecked, not unmatched.
 */
export function matchChannels(
  snapshot: MixSnapshot,
  live: LiveChannel[],
  options: { partial?: boolean } = {},
): { matches: Map<string, SnapshotChannel>; unmatched: string[]; notChecked: number } {
  const matches = new Map<string, SnapshotChannel>();
  const used = new Set<SnapshotChannel>();
  const byUid = new Map(snapshot.channels.filter((c) => c.uid).map((c) => [c.uid as string, c]));
  const unique: LiveChannel[] = [];
  const seen = new Set<string>();
  for (const channel of live) {
    // A channel seen twice (a page that repeats the last channel) counts once.
    if (seen.has(channel.key)) continue;
    seen.add(channel.key);
    unique.push(channel);
    const hit = channel.uid ? byUid.get(channel.uid) : undefined;
    if (hit) {
      matches.set(channel.key, hit);
      used.add(hit);
    }
  }
  // Leftovers on both sides are paired in project order, name by name.
  const leftovers = new Map<string, SnapshotChannel[]>();
  const nameCount = new Map<string, number>();
  for (const channel of snapshot.channels) nameCount.set(channel.name, (nameCount.get(channel.name) ?? 0) + 1);
  for (const channel of snapshot.channels) {
    if (used.has(channel)) continue;
    if (options.partial && (channel.uid || nameCount.get(channel.name) !== 1)) continue;
    const list = leftovers.get(channel.name) ?? [];
    list.push(channel);
    leftovers.set(channel.name, list);
  }
  for (const channel of unique) {
    if (matches.has(channel.key)) continue;
    const hit = leftovers.get(channel.title)?.shift();
    if (hit) {
      matches.set(channel.key, hit);
      used.add(hit);
    }
  }
  const missing = snapshot.channels.filter((c) => !used.has(c));
  if (options.partial) return { matches, unmatched: [], notChecked: missing.length };
  const unmatched = missing.map((c) => (c.occurrence > 1 ? `${c.name}#${c.occurrence}` : c.name)); // the label channel references use
  return { matches, unmatched, notChecked: 0 };
}

/**
 * Fields of a live channel that differ from the snapshot, as writes. A field the live channel reports
 * no value for (null: a send without destination, a control the channel does not have) is not written,
 * nor are the fields saved for information (autoRead).
 */
export function pendingWrites(
  fields: string[],
  live: Array<number | null>,
  target: SnapshotChannel,
): Array<{ field: string; value: number }> {
  const writes: Array<{ field: string; value: number }> = [];
  fields.forEach((field, i) => {
    const value = target.values[field];
    if (value === null || value === undefined || INFO_FIELDS.includes(field)) return;
    const current = live[i];
    if (current === null || current === undefined || Math.abs(current - value) < UNCHANGED) return;
    writes.push({ field, value });
  });
  return writes;
}
