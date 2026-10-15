/**
 * Meters and gain staging: every bank page, channel types, the fader taken out of post-fader peaks,
 * what was left out, and an average that does not depend on when it is read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelKind } from '../dist/cubase/client.js';
import { bigProject, setupServer } from './helpers/session.mjs';

/** Normalized fader value the mock shows as `db` (its fader curve is 6 + 40 log10 v). */
const faderFor = (db) => 10 ** ((db - 6) / 40);
/** Meter level the bridge turns into `db` dBFS (1.0 is +3.01 dBFS). */
const meterFor = (db) => 10 ** ((db - 3.01) / 20);

test('channel kinds come from the DirectAccess internal names', () => {
  assert.deepEqual(
    ['Audio 14', 'GroupChannel 3', 'FxChannel 2', 'VCA 1', 'OutputChannel', 'InputChannel', 'Instrument 4', 'Sampler 1', 'MIDI 2', 'Synth', 'MidiChannel', 'Something'].map((n) => channelKind(n)),
    ['audio', 'group', 'fx', 'vca', 'output', 'input', 'instrument', 'sampler', 'midi', 'instrument', 'midi', 'unknown'],
  );
});

test('cubase_measure_levels measures the page shown now, or every bank page with allPages, and says which', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  mock.state.meterLevels = { 'Track 010': 0.5, Trompeta: 0.3, Doubler: 0.4 };
  const page = await call('cubase_measure_levels', { seconds: 1 });
  assert.deepEqual(
    page.channels.map((c) => c.name),
    ['Track 010'],
  );
  assert.equal(page.pagesMeasured, 1);
  assert.match(page.pageNote, /allPages/);

  const all = await call('cubase_measure_levels', { seconds: 1, allPages: true });
  assert.equal(all.error, undefined, JSON.stringify(all));
  assert.equal(all.pagesMeasured, 3);
  assert.equal(all.channelsOnPages, 137);
  assert.deepEqual(
    all.channels.map((c) => [c.name, c.page, c.position]),
    [
      ['Track 010', 1, 10],
      ['Trompeta', 2, 60],
      ['Doubler', 3, 136],
    ],
  );
  // One playback per page, and the bank is back on its first page.
  assert.equal(mock.requests('meters.reset').length, 4);
  assert.equal(mock.state.bankOffset, 0);
  assert.equal(all.bankWarning, undefined);
});

test('the meter average counts time while playing only, so cubase_get_meters gives the same value later', async () => {
  const { call, mock, client } = await setupServer({ tracks: bigProject() });
  mock.state.meterLevels = { 'Track 010': 0.5 };
  const measured = await call('cubase_measure_levels', { seconds: 1 });
  const [channel] = measured.channels;
  // A constant level: the average equals the peak (within rounding; under load a callback can land at the stop).
  assert.ok(Math.abs(channel.averageDb - channel.peakDb) <= 0.2, JSON.stringify(channel));
  // After the stop the meter falls: many callbacks with low levels, which must not count.
  for (const level of [0.3, 0.1, 0.01, 0.001]) mock.setHostValue('host.mMixConsole.channel10.mValue.mVUMeter', level);
  const later = await call('cubase_get_meters');
  const again = later.channels.find((c) => c.name === 'Track 010');
  assert.deepEqual([again.peakDb, again.averageDb], [channel.peakDb, channel.averageDb]);
  assert.ok(again.playedSeconds >= 0.9 && again.playedSeconds < 6, String(again.playedSeconds));
  assert.equal(later.bankMoved, undefined);
  // Raw reads use the same definition.
  const raw = await client.getValue('ch.10.meter');
  assert.ok(Math.abs(raw.avg - 0.5) < 0.02, JSON.stringify(raw));

  await call('cubase_bank', { action: 'next' });
  const moved = await call('cubase_get_meters');
  assert.equal(moved.bankMoved, true);
  assert.match(moved.warning, /another page/);
});

test('cubase_gain_stage leaves out buses by type, takes the fader out of the peak and explains what it skipped', async () => {
  const tracks = ['Kick', 'Snare', 'Bass DI', 'Group 1', 'Lead Vox', 'Stereo Out', 'Quiet', 'Pad'];
  const server = await setupServer({ tracks });
  server.mock.state.meterLevels = {
    Kick: meterFor(-12),
    Snare: meterFor(-28.5),
    'Group 1': meterFor(-6),
    'Lead Vox': meterFor(-20),
    'Stereo Out': meterFor(-3),
    Quiet: meterFor(-62),
    Pad: meterFor(-45),
  };
  await server.client.setValue('ch.1.volume', faderFor(-11.6));
  await server.client.setValue('ch.6.volume', faderFor(0));
  await server.client.setValue('ch.7.volume', faderFor(0));
  const result = await server.call('cubase_gain_stage', { seconds: 2, excludeNames: ['lead vox'] });
  assert.equal(result.error, undefined, JSON.stringify(result));
  const step = (name) => result.plan.find((p) => p.channel === name);
  // Fader -11.6 dB, post-fader peak -28.5 dBFS, target -10: +6.9 dB.
  assert.deepEqual([step('Snare').faderDb, step('Snare').preFaderPeakDb, step('Snare').changeDb], [-11.6, -16.9, 6.9]);
  assert.match(step('Quiet').skipped, /signal too low/);
  assert.deepEqual([step('Pad').changeDb, step('Pad').capped, step('Pad').neededChangeDb], [18, true, 35]);
  assert.ok(result.warnings.some((w) => /Pad: the change was capped at \+18 dB/.test(w)));
  assert.deepEqual(
    result.excluded.map((e) => [e.channel, e.reason]),
    [
      ['Group 1', 'group channel'],
      ['Lead Vox', 'excludeNames'],
      ['Stereo Out', 'output channel'],
    ],
  );
  assert.equal(step('Group 1'), undefined);
  assert.equal(step('Bass DI').skipped, 'no signal');

  // Without compensation the post-fader peak is used as it is.
  const raw = await server.call('cubase_gain_stage', { seconds: 2, channels: ['Snare'], compensateFader: false });
  assert.deepEqual([raw.plan.length, raw.plan[0].changeDb, raw.plan[0].faderDb], [1, 18, undefined]);

  // Everything excluded: an empty plan says why.
  const none = await server.call('cubase_gain_stage', { seconds: 2, excludeKinds: ['audio', 'group', 'output'] });
  assert.deepEqual(none.plan, []);
  assert.match(none.message, /left out by excludeKinds or excludeNames/);
});

test('cubase_gain_stage resolves names before playing and, with allPages, writes on the page it measured', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  mock.state.meterLevels = { Trompeta: meterFor(-7.4), 'Track 010': meterFor(-20) };
  const wrong = await call('cubase_gain_stage', { seconds: 2, channels: ['Nope'] });
  assert.match(wrong.error, /Nope/);
  assert.equal(mock.requests('meters.reset').length, 0, 'nothing played');
  // Trompeta is on page 2: without allPages it is not on the page shown now.
  assert.match((await call('cubase_gain_stage', { seconds: 2, channels: ['Trompeta'] })).error, /current bank page/);

  const result = await call('cubase_gain_stage', { seconds: 2, channels: ['Trompeta'], allPages: true, targetPeakDb: -16, apply: true });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.pagesMeasured, 1, 'only the page with Trompeta played');
  const [trompeta] = result.plan;
  assert.deepEqual([trompeta.channel, trompeta.page, trompeta.index, trompeta.applied], ['Trompeta', 2, 12, true]);
  const gain = mock.state.project.find((c) => c.title === 'Trompeta').values.get('mPreFilter.mGain');
  assert.ok(Math.abs(-48 + 96 * gain - trompeta.newInputGainDb) < 0.2, String(gain));
  // The slot that shows index 12 on page 1 kept its gain.
  assert.equal(mock.state.project[12].values.get('mPreFilter.mGain') ?? 0.5, 0.5);
  assert.equal(mock.state.bankOffset, 0);
});
