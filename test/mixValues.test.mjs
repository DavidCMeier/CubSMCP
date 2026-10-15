/**
 * Mixer values, seeks and snapshots: what Cubase applied, searches that do not write the extremes, -oo,
 * real ranges, plugin switches, solo-implied mute reads, values that belong to no channel and snapshot files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seekMonotonic } from '../dist/cubase/client.js';
import { FADER_CURVE, displayResolution, parseSwitch } from '../dist/cubase/display.js';
import { matchChannels, normalizeSnapshot, snapshotPath } from '../dist/cubase/snapshot.js';
import { sendDestination } from '../dist/tools/common.js';
import { bigProject, setupCubase, setupServer } from './helpers/session.mjs';

const real = (mock, i, field) => mock.state.project[i].values.get(`mValue.m${field}`) ?? 0;
/** Normalized values the server wrote to a key. */
const writesTo = (mock, key) => mock.requests('value.set').filter((r) => r.params.key === key).map((r) => r.params.value);

test('a seek reports the value Cubase applied, not the one it asked for', async () => {
  // A fader with a wide detent: anything between 0.70 and 0.85 lands on 0.79 ("0.00").
  const fader = (n) => {
    const v = n > 0.7 && n < 0.85 ? 0.79 : n;
    return { v, d: v <= 0 ? '-oo' : (40 * Math.log10(v / 0.79)).toFixed(2), u: 'dB' };
  };
  const result = await seekMonotonic(async (n) => fader(n), 0, { start: fader(0.5), curve: FADER_CURVE });
  assert.deepEqual([result.display, result.normalized, result.withinTolerance, result.iterations], ['0.00', 0.79, true, 1]);
  // Unreachable inside the detent: the closest value seen, read back, and withinTolerance from that read.
  const near = await seekMonotonic(async (n) => fader(n), -1, { start: fader(0.5), curve: FADER_CURVE });
  assert.equal(near.normalized, 0.79);
  assert.equal(near.withinTolerance, false);
  assert.equal(near.display, '0.00');
});

test('a seek goes on until Cubase shows the target, not the first value within tolerance', async () => {
  const { client } = await setupCubase();
  const volume = await client.seekDisplay('ch.2.volume', -3);
  assert.equal(volume.display, '-3.00', JSON.stringify(volume));
  assert.ok(volume.iterations <= 24);
  const gain = await client.seekDisplay('ch.1.pre.gain', -12.3);
  assert.equal(gain.display, '-12.30');
  const freq = await client.seekDisplay('sel.eq.2.freq', 2500);
  assert.deepEqual([freq.display, freq.units], ['2.50', 'kHz']);
  const pan = await client.seekDisplay('ch.1.pan', -30);
  assert.equal(pan.display, 'L30');
  const threshold = await client.seekDirectParameter('sel.strip.compressor', { title: 'Threshold' }, -20);
  assert.equal(threshold.display, '-20.0');
  const attack = await client.seekDirectParameter('sel.strip.compressor', { title: 'Attack' }, 10);
  assert.equal(attack.display, '10.0');
  // Resolution is counted in parsed units.
  assert.deepEqual([displayResolution('1.20', 'kHz'), displayResolution('-3.14', 'dB'), displayResolution('L32', ''), displayResolution('-oo', 'dB')], [10, 0.01, 1, null]);
});

test('seeks never write the extremes of a live parameter, and write nothing when the value already matches', async () => {
  const { client, mock } = await setupCubase();
  for (const [key, target] of [
    ['ch.2.volume', -6],
    ['ch.2.pan', 40],
    ['ch.2.pre.gain', 6],
    ['ch.2.pre.lowCutFreq', 120],
    ['ch.2.send.0.level', -12],
  ]) {
    await client.seekDisplay(key, target);
    const writes = writesTo(mock, key);
    assert.ok(writes.length > 0, key);
    assert.ok(writes.every((v) => v > 0 && v < 1), `${key}: ${writes}`);
  }
  const before = mock.requests('value.set').length;
  const again = await client.seekDisplay('ch.2.pan', 40);
  assert.deepEqual([again.iterations, again.display], [0, 'R40']);
  assert.equal(mock.requests('value.set').length, before);
  // A plugin parameter without known curve starts from its value.
  await client.seekDirectParameter('sel.strip.compressor', { title: 'Threshold' }, -24);
  const daWrites = mock.requests('da.setParam').map((r) => r.params.value);
  assert.ok(daWrites.every((v) => v > 0 && v < 1), String(daWrites));
});

test('the fader reaches -oo with "-inf", and levels stop at the ranges Cubase has', async () => {
  const { call, mock } = await setupServer();
  const off = await call('cubase_set_volume', { channel: 'Snare', volumeDb: '-inf' });
  assert.deepEqual([off.display, off.normalized, off.withinTolerance], ['-oo', 0, true]);
  assert.equal(real(mock, 1, 'Volume'), 0);
  const send = await call('cubase_set_send', { channel: 'Snare', slot: 1, levelDb: '-inf' });
  assert.deepEqual([send.level.display, send.level.withinTolerance], ['-oo', true]);
  const mix = await call('cubase_apply_mix', { changes: [{ channel: 'Kick', volumeDb: '-inf', sends: [{ slot: 2, levelDb: '-inf' }] }] });
  assert.deepEqual([mix.results[0].volume, mix.results[0].send2, mix.applied], ['-oo', '-oo', 1]);
  // Two equal infinities are a hit.
  const minusInf = await seekMonotonic(async (n) => ({ v: n, d: n === 0 ? '-oo' : '-10.00', u: 'dB' }), Number.NEGATIVE_INFINITY, {
    start: { v: 0, d: '-oo', u: 'dB' },
  });
  assert.deepEqual([minusInf.iterations, minusInf.withinTolerance], [0, true]);

  for (const [name, args] of [
    ['cubase_set_volume', { channel: 0, volumeDb: 12 }],
    ['cubase_set_send', { channel: 0, slot: 1, levelDb: 6.5 }],
    ['cubase_set_input_gain', { channel: 0, gainDb: 50 }],
    ['cubase_set_prefilter', { channel: 0, gainDb: -49 }],
    ['cubase_apply_mix', { changes: [{ channel: 0, volumeDb: 12 }] }],
    ['cubase_apply_mix', { changes: [{ channel: 0, inputGainDb: 48.5 }] }],
    ['cubase_apply_mix', { changes: [{ channel: 0, sends: [{ slot: 1, levelDb: 7 }] }] }],
  ]) {
    assert.match((await call(name, args)).error ?? '', /Invalid arguments|too_big|less than or equal/, `${name} ${JSON.stringify(args)}`);
  }
  const top = await call('cubase_set_volume', { channel: 0, volumeDb: 6.02 });
  assert.equal(top.withinTolerance, true);
});

test('cubase_apply_mix lists values Cubase did not reach and does not count them as applied', async () => {
  const { call, mock } = await setupServer();
  mock.state.ignored = /channel1\.mValue\.mVolume$/;
  const result = await call('cubase_apply_mix', {
    changes: [
      { channel: 'Kick', volumeDb: -6 },
      { channel: 'Snare', volumeDb: -10, pan: 20 },
    ],
  });
  assert.deepEqual([result.applied, result.partial], [1, 1]);
  const [kick, snare] = result.results;
  assert.equal(kick.notReached, undefined);
  assert.equal(kick.volume, '-6.00');
  assert.deepEqual(snare.notReached, ['volume: wanted -10, got 2.12']);
  assert.equal(snare.pan, 'R20');
  // A single seek says it too, and that the control ends before the target.
  const single = await call('cubase_set_volume', { channel: 'Snare', volumeDb: -10 });
  assert.deepEqual([single.withinTolerance, single.clamped], [false, true]);
});

test('plugin switches take valueInUnits 1/0, mode lists ask for display, and a failed search restores the value', async () => {
  const { call, mock } = await setupServer();
  const params = () => mock.state.directParams['host.mTrackSelection.mMixerChannel.mInsertAndStripEffects.mStripEffects.mCompressor'];
  const on = await call('cubase_set_plugin_parameter', { channel: 'Kick', target: 'strip', module: 'compressor', parameter: 'AutoMakeUp', valueInUnits: 1 });
  assert.deepEqual([on.display, on.achieved, on.withinTolerance, on.iterations], ['On', 1, true, 1]);
  const off = await call('cubase_set_plugin_parameter', { target: 'strip', module: 'compressor', parameter: 'AutoMakeUp', valueInUnits: 0 });
  assert.deepEqual([off.display, off.withinTolerance], ['Off', true]);
  // A mode list has no units: nothing is written.
  const writes = mock.requests('da.setParam').length;
  const mode = await call('cubase_set_plugin_parameter', { target: 'strip', module: 'compressor', parameter: 'Character', valueInUnits: 2 });
  assert.match(mode.error, /display .*or normalized/);
  assert.equal(mock.requests('da.setParam').length, writes);
  // Display texts the parameter shows are typed in.
  await call('cubase_set_plugin_parameter', { target: 'strip', module: 'compressor', parameter: 'Character', display: 'Vintage' });
  assert.equal(params()[14].toDisplay(params()[14].value)[0], 'Vintage');
  // Units on an "Off" switch: the search meets "On", fails and puts the switch back.
  const wrong = await call('cubase_da_set_parameter', { scope: 'sel.strip.compressor', parameter: 'AutoMakeUp', valueInUnits: 250 });
  assert.match(wrong.error, /switch/);
  assert.equal(params()[13].value, 0);
  // Raw seeks only take continuous keys, and reject switch displays.
  assert.match((await call('cubase_seek_raw_value', { key: 'ch.0.mute', target: 1 })).error, /not a continuous value/);
  assert.equal(parseSwitch('Activ.'), true);
  assert.equal(parseSwitch('Desact.'), false);
  assert.equal(parseSwitch('-6.0'), null);
});

test('mute and solo: solo-implied reads are flagged, writes go solo off, mute, solo on, and mutes are always written', async () => {
  const { call, mock } = await setupServer();
  // "Kick" muted and soloed: the soloed channel reads its own mute off, the others mute on, Stereo Out solo on.
  await call('cubase_set_channel_state', { channel: 'Kick', mute: true });
  await call('cubase_set_channel_state', { channel: 'Kick', solo: true });
  const kick = await call('cubase_get_channel', { channel: 'Kick' });
  assert.deepEqual([kick.mute, kick.solo, kick.soloActive], [false, true, true]);
  const snare = await call('cubase_get_channel', { channel: 'Snare' });
  assert.deepEqual([snare.mute, snare.soloActive], [true, true]);
  assert.match(snare.note, /solo-implied/);
  const list = await call('cubase_list_channels', { fields: ['mute'] });
  assert.equal(list.soloActive, true);
  assert.match(list.note, /solo-implied/);

  // A mute written while a channel is soloed cannot be read back.
  const masked = await call('cubase_set_channel_state', { channel: 'Snare', mute: true });
  assert.deepEqual([masked.results[0].maskedBySolo, masked.results[0].applied], [true, 'unconfirmed']);
  assert.equal(real(mock, 1, 'Mute'), 1);
  const mix = await call('cubase_apply_mix', { changes: [{ channel: 'Bass DI', mute: true }] });
  assert.deepEqual(mix.results[0].unverified, ['mute (masked by an active solo)']);
  assert.deepEqual([mix.applied, mix.partial], [0, 1]);

  // Solo off first, then the mute is written although it read off: Kick ends unmuted.
  const cleared = await call('cubase_set_channel_state', { channel: 'Kick', mute: false, solo: false });
  assert.deepEqual(
    cleared.results.map((r) => [r.key, r.on, r.verified]),
    [
      ['ch.0.solo', false, true],
      ['ch.0.mute', false, true],
    ],
  );
  assert.deepEqual([real(mock, 0, 'Mute'), real(mock, 0, 'Solo')], [0, 0]);
  assert.equal(cleared.note, undefined);
  // Solo on goes last.
  const both = await call('cubase_set_channel_state', { channel: 'Kick', solo: true, mute: false });
  assert.deepEqual(both.results.map((r) => r.key), ['ch.0.mute', 'ch.0.solo']);
});

test('snapshots leave out mute and solo while a channel is soloed; restores clear solos before restoring mutes', async () => {
  const { call, mock, ctx } = await setupServer();
  await call('cubase_set_channel_state', { channel: 'Snare', mute: true });
  const clean = await call('cubase_snapshot_mix', { name: 'clean' });
  assert.equal(clean.soloActive, undefined);

  // Kick soloed, Snare unmuted underneath (Cubase shows it muted, solo-implied).
  await call('cubase_set_channel_state', { channel: 'Kick', solo: true });
  await call('cubase_set_channel_state', { channel: 'Snare', mute: false });
  const soloed = await call('cubase_snapshot_mix', { name: 'soloed' });
  assert.equal(soloed.soloActive, true);
  assert.match(soloed.warning, /"Kick", "Stereo Out"/);
  const saved = JSON.parse(readFileSync(join(ctx.config.snapshotDir, 'soloed.json'), 'utf8'));
  assert.equal(saved.soloActive, true);
  assert.ok(saved.channels.every((c) => c.values.mute === null && c.values.solo === null));

  const restored = await call('cubase_restore_mix', { snapshot: 'clean' });
  assert.deepEqual(restored.solosCleared, ['Kick', 'Stereo Out']);
  assert.deepEqual([real(mock, 0, 'Solo'), real(mock, 1, 'Mute')], [0, 1]);
  const snare = restored.results.find((r) => r.channel === 'Snare');
  assert.deepEqual([snare.changed, snare.verified], [['mute'], true]);

  // A snapshot taken with a solo active does not touch mute or solo.
  await call('cubase_set_channel_state', { channel: 'Kick', solo: true });
  const fromSoloed = await call('cubase_restore_mix', { snapshot: 'soloed' });
  assert.match(fromSoloed.soloNote, /not restored/);
  assert.equal(fromSoloed.solosCleared, undefined);
  assert.equal(real(mock, 0, 'Solo'), 1);
});

test('values that belong to no channel are flagged, not written, not saved', async () => {
  const { client, mock, call } = await setupServer();
  // Bank slot 40 is empty (six channels) but keeps values; writes to it are refused by the script.
  const empty = await client.getValues(['ch.40.volume', 'ch.2.volume', 'ch.2.send.0.level']);
  assert.equal(empty['ch.40.volume'].stale, true);
  assert.equal(empty['ch.2.volume'].stale, undefined);
  assert.equal(empty['ch.2.send.0.level'].stale, true, 'a send without destination');
  await assert.rejects(client.setValue('ch.40.volume', 0.5), /Bank slot 40 is empty/);
  mock.setSendTitle(2, 0, '1- FX Reverb');
  mock.setSendTitle(2, 1, '2');
  assert.equal((await client.getValues(['ch.2.send.0.level']))['ch.2.send.0.level'].stale, undefined);
  // The selection objects after selecting a track without mixer channel.
  await client.focusChannel('Lead Vox');
  assert.equal((await client.getValues(['sel.volume']))['sel.volume'].stale, undefined);
  mock.selectTrackWithoutMixerChannel();
  assert.equal((await client.getValues(['sel.volume']))['sel.volume'].stale, true);

  // Snapshots save only the sends with a destination.
  const page = await client.readSnapshotPage();
  const level = (slot) => page.fields.indexOf(`send.${slot}.level`);
  const bass = page.channels.find((c) => c.title === 'Bass DI');
  assert.equal(typeof bass.values[level(0)], 'number');
  assert.deepEqual([bass.values[level(1)], bass.values[level(7)]], [null, null]);

  // Sends: destination without the "N- " prefix, warning without one.
  const routed = await call('cubase_set_send', { channel: 'Bass DI', slot: 1, on: true });
  assert.deepEqual([routed.destination, routed.warning], ['FX Reverb', undefined]);
  const unrouted = await call('cubase_set_send', { channel: 'Bass DI', slot: 2, on: true });
  assert.equal(unrouted.destination, null);
  assert.match(unrouted.warning, /no destination/);
  const channel = await call('cubase_get_channel', { channel: 'Bass DI' });
  assert.deepEqual(channel.sends.map((s) => [s.slot, s.destination, s.prePost]), [[1, 'FX Reverb', 'post']]);
  assert.deepEqual(
    [sendDestination(['1'], 0), sendDestination(['8- V Plate'], 0), sendDestination([], 3), sendDestination(['', '', '', '', '', '', '', '8- V Plate'], 7), sendDestination(['FX'], 0)],
    [null, '8- V Plate', null, 'V Plate', 'FX'],
  );
});

test('a write Cubase ignores is listed once and not written again', async () => {
  const { call, mock, ctx } = await setupServer();
  // Stereo Out (slot 5) shows a send title left over from another channel; Cubase ignores writes to it.
  mock.setSendTitle(5, 7, '8- V Plate');
  await call('cubase_snapshot_mix', { name: 'out' });
  const file = join(ctx.config.snapshotDir, 'out.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  snapshot.channels.find((c) => c.name === 'Stereo Out').values['send.7.level'] = 0.3;
  writeFileSync(file, JSON.stringify(snapshot));
  mock.state.ignored = /channel5\.mSends\[7\]\.mLevel$/;
  const first = await call('cubase_restore_mix', { snapshot: 'out' });
  assert.deepEqual(first.ignoredByCubase, [{ channel: 'Stereo Out', fields: ['send.7.level'] }]);
  assert.equal(first.notVerified, 0);
  const before = mock.requests('value.setMany').length;
  const second = await call('cubase_restore_mix', { snapshot: 'out' });
  assert.deepEqual(second.ignoredByCubase, [{ channel: 'Stereo Out', fields: ['send.7.level'] }]);
  assert.equal(second.changedChannels, 0);
  assert.equal(mock.requests('value.setMany').length, before);
});

test('snapshot names stay inside the snapshot folder', async () => {
  const dir = '/tmp/snaps';
  assert.equal(snapshotPath(dir, '../x.json'), '/tmp/snaps/.._x.json');
  assert.equal(snapshotPath(dir, 'a/b.json'), '/tmp/snaps/a_b.json');
  assert.equal(snapshotPath(dir, 'ok'), '/tmp/snaps/ok.json');
  assert.equal(snapshotPath(dir, 'v1 before bus'), '/tmp/snaps/v1_before_bus.json');
  for (const bad of ['.json', '..json', '..', ' ']) assert.throws(() => snapshotPath(dir, bad), /not a usable snapshot name/, bad);
  const { call, ctx } = await setupServer();
  const saved = await call('cubase_snapshot_mix', { name: '../escape.json', allPages: false });
  assert.equal(saved.file, join(ctx.config.snapshotDir, '.._escape.json'));
  assert.deepEqual((await call('cubase_list_snapshots')).snapshots.map((s) => [s.name, s.file]), [['.._escape', '.._escape.json']]);
  // Restoring by the same name finds it.
  assert.equal((await call('cubase_restore_mix', { snapshot: '../escape.json' })).file, saved.file);
});

test('restoring something that is not a snapshot fails with a clear error before touching Cubase', async () => {
  assert.throws(() => normalizeSnapshot({ name: 'x' }, 'x.json'), /x\.json is not a mix snapshot/);
  assert.throws(() => normalizeSnapshot(null, 'n.json'), /not a mix snapshot/);
  assert.throws(() => normalizeSnapshot([1, 2], 'a.json'), /not a mix snapshot/);
  assert.throws(() => normalizeSnapshot({ channels: [null, 3] }, 'e.json'), /without channels/);
  const kept = normalizeSnapshot({ channels: [null, { name: 'BASS', values: { volume: 0.5 } }] });
  assert.deepEqual(kept.channels.map((c) => [c.name, c.uid, c.occurrence]), [['BASS', null, 1]]);
  const { call, mock, ctx } = await setupServer();
  const before = mock.state.requestLog.length;
  const pkg = await call('cubase_restore_mix', { snapshot: join(ctx.config.projectRoot, 'package.json') });
  assert.match(pkg.error, /package\.json is not a mix snapshot: it has no "channels" list/);
  const readme = await call('cubase_restore_mix', { snapshot: join(ctx.config.projectRoot, 'README.md') });
  assert.match(readme.error, /not valid JSON/);
  assert.match((await call('cubase_restore_mix', { snapshot: 'nope' })).error, /No snapshot "nope"/);
  assert.equal(mock.state.requestLog.length, before);
});

test('restoring one bank page of a whole-project snapshot does not call the other pages unmatched', async () => {
  const snapshot = normalizeSnapshot({
    allPages: true,
    channels: [
      { uid: 'a', name: 'BASS', values: {} },
      { uid: 'b', name: 'G L', values: {} },
      { name: 'Solo', values: {} },
      { name: 'V L', values: {} },
      { name: 'V L', values: {} },
    ],
  });
  const live = [
    { key: 'a', title: 'BASS', uid: 'a' },
    { key: 'x', title: 'G L', uid: 'x' },
    { key: 'y', title: 'Solo', uid: 'y' },
    { key: 'z', title: 'V L', uid: 'z' },
  ];
  const partial = matchChannels(snapshot, live, { partial: true });
  // By uid; by name only a saved channel without uid and with a unique name.
  assert.deepEqual([...partial.matches.keys()], ['a', 'y']);
  assert.deepEqual([partial.unmatched, partial.notChecked], [[], 3]);

  const { call } = await setupServer({ tracks: bigProject() });
  await call('cubase_snapshot_mix', { name: 'all' });
  const page = await call('cubase_restore_mix', { snapshot: 'all', allPages: false });
  assert.deepEqual([page.matched, page.unmatched, page.notOnThisPage], [48, [], 89]);
  assert.match(page.notOnThisPageNote, /allPages: true/);
});

test('raw values: pre/post as words, parameter and channel names apart from the owner, applied versus requested', async () => {
  const { call, client, mock, mcp } = await setupServer();
  const raw = await call('cubase_get_raw_values', { keys: ['ch.2.send.0.prePost', 'ch.2.volume'] });
  assert.equal(raw['ch.2.send.0.prePost'].prePost, 'post');
  assert.equal(raw['ch.2.volume'].ch, 'Bass DI');
  mock.setSendTitle(2, 0, '1- FX Reverb');
  const pre = await call('cubase_set_send', { channel: 'Bass DI', slot: 1, preFader: true });
  assert.deepEqual([pre.preFader.state, pre.preFader.prePost], [true, 'pre']);
  assert.equal((await call('cubase_get_raw_values', { keys: ['ch.2.send.0.prePost'] }))['ch.2.send.0.prePost'].prePost, 'pre');
  const description = (await mcp.listTools()).tools.find((t) => t.name === 'cubase_get_raw_values').description;
  assert.match(description, /v 1 is pre-fader/);

  // A quick control: owned by the plugin (t), assigned to a parameter (n).
  await client.focusChannel('Kick');
  mock.setValueTitle('host.mTrackSelection.mMixerChannel.mQuickControls[0]', 'Compressor', 'Threshold');
  const qc = (await call('cubase_get_raw_values', { keys: ['sel.qc.0'] }))['sel.qc.0'];
  assert.deepEqual([qc.t, qc.n, qc.ch], ['Compressor', 'Threshold', 'Kick']);
  const strip = await call('cubase_get_channel_strip');
  assert.equal(strip.quickControls[0].title, 'Threshold');

  // Snapped or ignored writes say so.
  const applied = await client.writeAndRead('ch.2.pan', 0.25);
  assert.deepEqual([applied.requested, applied.differsFromRequest], [0.25, false]);
  mock.state.ignored = /channel2\.mValue\.mPan$/;
  const ignored = await client.writeAndRead('ch.2.pan', 0.75);
  assert.deepEqual([ignored.v, ignored.requested, ignored.differsFromRequest], [0.25, 0.75, true]);
});

test('automation read: snapshots count the channels, restores leave their automated values alone unless forced, writes warn', async () => {
  const { call, client, mock, ctx } = await setupServer();
  const volume = async (i) => (await client.getValue(`ch.${i}.volume`)).v;
  // Bass DI follows its automation.
  await call('cubase_set_channel_state', { channel: 'Bass DI', automationRead: true });
  const saved = await call('cubase_snapshot_mix', { name: 'auto' });
  assert.equal(saved.automationRead, 1);
  assert.match(saved.automationNote, /"Bass DI".*writeAutomated/);
  const file = join(ctx.config.snapshotDir, 'auto.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(snapshot.channels.map((c) => c.values.autoRead), [0, 0, 1, 0, 0, 0]);

  // The cursor moved: the automation moved Bass DI's fader and pan; Kick was moved by hand.
  await client.setValues([
    { key: 'ch.2.volume', value: 0.5 },
    { key: 'ch.2.pan', value: 0.3 },
    { key: 'ch.0.volume', value: 0.6 },
  ]);
  const restored = await call('cubase_restore_mix', { snapshot: 'auto' });
  assert.equal(restored.changedChannels, 1, JSON.stringify(restored));
  assert.deepEqual(restored.results.map((r) => [r.channel, r.changed]), [['Kick', ['volume']]]);
  assert.deepEqual(restored.automated, [{ channel: 'Bass DI', index: 2, page: 1, uid: 'uid-2-Bass DI', fields: ['volume', 'pan'] }]);
  assert.match(restored.automatedNote, /cursor moved.*writeAutomated: true/);
  assert.deepEqual([await volume(2), await volume(0)], [0.5, 0.8]);

  const forced = await call('cubase_restore_mix', { snapshot: 'auto', writeAutomated: true });
  assert.deepEqual([forced.changedChannels, forced.automatedWritten, forced.automated], [1, ['Bass DI'], undefined]);
  assert.match(forced.automatedWarning, /overrides/);
  assert.equal(await volume(2), 0.8);

  // autoRead itself is never written, also from a snapshot that saved it on (or an old one without it).
  snapshot.channels[0].values.autoRead = 1;
  delete snapshot.channels[2].values.autoRead;
  writeFileSync(file, JSON.stringify(snapshot));
  await call('cubase_restore_mix', { snapshot: 'auto' });
  const written = mock.requests('value.setMany').flatMap((r) => r.params.items.map((item) => item.key));
  assert.ok(!written.some((key) => key.endsWith('.autoRead')), written.join(', '));

  // Writes to a channel with automation read on warn; the others do not.
  const fader = await call('cubase_set_volume', { channel: 'Bass DI', volumeDb: -6 });
  assert.match(fader.warning, /"Bass DI" has automation read on/);
  const pan = await call('cubase_set_pan', { channel: 'Bass DI', normalized: 0.5 });
  assert.match(pan.warning, /automation read on/);
  assert.equal((await call('cubase_set_volume', { channel: 'Kick', volumeDb: -6 })).warning, undefined);
  const mix = await call('cubase_apply_mix', {
    changes: [
      { channel: 'Bass DI', volumeDb: -3 },
      { channel: 'Kick', volumeDb: -3 },
    ],
  });
  assert.match(mix.results[0].warnings[0], /automation read on/);
  assert.equal(mix.results[1].warnings, undefined);
});

test('a MIDI channel reads null for the Pre section and sends it lacks, whatever its bank slot showed before', async () => {
  // As in the live test: "Superior Drummer 3 01" is a MIDI track channel. Slot 10 shows it on page 1 and audio
  // channels on pages 2 and 3; slot 20 shows an audio channel on page 1 and a MIDI channel on page 2.
  const tracks = bigProject();
  tracks[10] = 'Superior Drummer 3 01';
  tracks[68] = 'MIDI Keys';
  const { call, client, mock, ctx } = await setupServer({ tracks, kinds: { 'Superior Drummer 3 01': 'MIDI 10', 'MIDI Keys': 'MIDI 68' } });
  // The audio channels on those slots have another input gain and a routed first send.
  mock.setSendTitle(10, 0, '1- FX Reverb');
  mock.setSendTitle(20, 0, '1- FX Reverb');
  await client.setValues([
    { key: 'ch.20.pre.gain', value: 0.6 },
    { key: 'ch.20.send.0.level', value: 0.3 },
  ]);
  for (const i of [58, 106]) {
    mock.state.project[i].values.set('mPreFilter.mGain', 0.6);
    mock.state.project[i].values.set('mSends[0].mLevel', 0.3);
  }
  await call('cubase_snapshot_mix', { name: 'midi-1' });
  // The slot of "Superior Drummer 3 01" now keeps the values of the audio channel page 3 showed in it.
  assert.equal((await client.getValue('ch.10.pre.gain')).v, 0.6);
  await call('cubase_snapshot_mix', { name: 'midi-2' });
  const load = (name) => JSON.parse(readFileSync(join(ctx.config.snapshotDir, `${name}.json`), 'utf8')).channels;
  const [first, second] = [load('midi-1'), load('midi-2')];
  const missing = ['pre.gain', 'pre.phase', 'pre.lowCutOn', 'pre.lowCutFreq', ...[0, 1, 7].flatMap((s) => [`send.${s}.level`, `send.${s}.on`, `send.${s}.prePost`])];
  for (const name of ['Superior Drummer 3 01', 'MIDI Keys']) {
    const [a, b] = [first.find((c) => c.name === name), second.find((c) => c.name === name)];
    assert.deepEqual(a.values, b.values, name);
    for (const field of missing) assert.equal(a.values[field], null, `${name} ${field}`);
    assert.equal(typeof a.values.volume, 'number');
  }
  // The audio channels on the same slots keep theirs.
  for (const uid of ['uid-20-Track 020', 'uid-58-Track 058', 'uid-106-Track 106']) {
    const audio = second.find((c) => c.uid === uid);
    assert.deepEqual([audio.values['pre.gain'], audio.values['send.0.level']], [0.6, 0.3], uid);
  }
  // Nothing phantom to restore.
  const restored = await call('cubase_restore_mix', { snapshot: 'midi-1' });
  assert.deepEqual([restored.changedChannels, restored.results], [0, []]);
});
