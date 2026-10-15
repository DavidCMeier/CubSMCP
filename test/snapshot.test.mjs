import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotCollector, matchChannels, normalizeSnapshot, pendingWrites } from '../dist/cubase/snapshot.js';

const fields = ['volume', 'mute'];
const page = (channels) => ({ fields, channels });
const ch = (index, title, uid, values) => ({ index, title, uid, values });

test('collector numbers repeated names and skips channels a later page repeats', () => {
  const collector = new SnapshotCollector();
  collector.add(page([ch(0, 'BASS', 'a', [0.7, 0]), ch(1, 'BASS', 'b', [0.5, 1])]));
  // A later page repeats channel "b" (Cubase pages by offset, so pages can overlap).
  collector.add(page([ch(0, 'BASS', 'b', [0.5, 1]), ch(1, 'G L', 'c', [0.6, 0])]));
  assert.deepEqual(
    collector.channels.map((c) => [c.uid, c.name, c.occurrence, c.values.volume]),
    [
      ['a', 'BASS', 1, 0.7],
      ['b', 'BASS', 2, 0.5],
      ['c', 'G L', 1, 0.6],
    ],
  );
});

const live = (key, title, uid) => ({ key, title, uid });

test('matching prefers the unique id over a new channel with the same name', () => {
  const snapshot = normalizeSnapshot({
    channels: [
      { uid: 'a', name: 'BASS', values: { volume: 0.7 } },
      { uid: 'old-id', name: 'BASS', values: { volume: 0.5 } },
    ],
  });
  // "x" is a new BASS placed first; "a" is the saved one; the second saved BASS changed its id.
  const { matches, unmatched } = matchChannels(snapshot, [live('x', 'BASS', 'x'), live('a', 'BASS', 'a'), live('y', 'BASS', 'y')]);
  assert.equal(matches.get('a').values.volume, 0.7);
  // Left over on both sides: the second saved BASS goes to the first unmatched live BASS by name.
  assert.equal(matches.get('x').values.volume, 0.5);
  assert.equal(matches.has('y'), false);
  assert.deepEqual(unmatched, []);
});

test('matching skips channels seen twice and restores old snapshots by name order', () => {
  const snapshot = normalizeSnapshot({
    channels: [
      { name: 'G L', values: { volume: 0.1 } },
      { name: 'G L', values: { volume: 0.2 } },
      { name: 'Solo', values: { volume: 0.3 } },
    ],
  });
  const { matches, unmatched } = matchChannels(snapshot, [live('p', 'G L', 'p'), live('q', 'G L', 'q'), live('q', 'G L', 'q')]);
  assert.equal(matches.get('p').values.volume, 0.1);
  assert.equal(matches.get('q').values.volume, 0.2);
  assert.deepEqual(unmatched, ['Solo']);
  // Repeated names get the same "name#N" label channel references use.
  const second = normalizeSnapshot({ channels: [{ name: 'V L', values: {} }, { name: 'V L', values: {} }] });
  assert.deepEqual(matchChannels(second, [live('a', 'V L', 'a')]).unmatched, ['V L#2']);
});

test('only changed values are written', () => {
  const target = { uid: 'a', name: 'BASS', occurrence: 1, values: { volume: 0.7, mute: 0, pan: null } };
  assert.deepEqual(pendingWrites(['volume', 'mute', 'pan'], [0.7001, 1, 0.5], target), [{ field: 'mute', value: 0 }]);
  // A fader moved by ~0.1 dB is still restored.
  assert.deepEqual(pendingWrites(['volume'], [0.705], target), [{ field: 'volume', value: 0.7 }]);
});
