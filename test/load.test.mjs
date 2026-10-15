/**
 * Bridge load and timing: small answers, MIDI Remote stalls, lost and late replies, serialized
 * measurements, request sessions and Cubase applying switches late. The mock simulates each of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CubaseBridge } from '../dist/bridge/midiBridge.js';
import { bigProject, setupCubase, setupServer } from './helpers/session.mjs';

/** Fast stall recovery for tests: 150 ms per request, pings of 100 ms, 1.5 s in all. */
const STALLS = { timeoutMs: 150, recovery: { windowMs: 1500, pingTimeoutMs: 100 } };

/** state.channels requests that asked for every value of the bank. */
const wholeBankReads = (mock) => mock.requests('state.channels').filter((r) => r.params.includeValues !== false);

async function biggestAnswer(client, sinceId) {
  const { requests } = await client.call('debug.requests');
  return Math.max(...requests.filter((r) => r.id >= sinceId && r.method !== 'debug.requests').map((r) => r.chunks ?? 0));
}

test('cubase_get_channel, cubase_list_channels and cubase://mixer never read the whole bank with values', async () => {
  const { call, mock, mcp, bridge, client } = await setupServer({ tracks: bigProject() });
  const from = bridge.firstId;
  const channel = await call('cubase_get_channel', { channel: 'Trompeta' });
  assert.deepEqual([channel.name, channel.position, channel.volume.units, channel.inputGain.display], ['Trompeta', 60, 'dB', '0.00']);
  const list = await call('cubase_list_channels');
  assert.equal(list.channels.length, 48);
  assert.deepEqual(Object.keys(list.channels[1]), ['index', 'name', 'uid', 'kind', 'volume', 'pan', 'mute', 'solo', 'inputGain', 'sends']);
  const mixer = await mcp.readResource({ uri: 'cubase://mixer' });
  assert.equal(JSON.parse(mixer.contents[0].text).channels.length, 48);
  assert.deepEqual(wholeBankReads(mock), []);
  // Every answer stays small (a whole bank page with values was ~730 SysEx chunks).
  assert.ok((await biggestAnswer(client, from)) <= 30);
});

test('reads and absolute writes wait out a stall and are sent again; pulses, actions and commands are sent once', async () => {
  const { client, mock, bridge } = await setupCubase(STALLS);
  mock.state.stallUntil = Date.now() + 400;
  const value = await client.getValue('ch.0.volume');
  assert.equal(value.u, 'dB');
  assert.ok(mock.requests('value.get').length >= 2);
  assert.ok(mock.requests('ping').length >= 1);
  assert.equal(bridge.stats.stalls, 1);

  mock.state.dropReplies = 1;
  await client.setValue('ch.1.pan', 0.25);
  assert.equal(mock.requests('value.set').length, 2);

  for (const [send, method] of [
    [() => client.runAction('bank.next'), 'action.run'],
    [() => client.pulse('tr.stop'), 'value.pulse'],
    [() => client.runCommand('File', 'Save'), 'command.run'],
  ]) {
    mock.state.dropReplies = 1;
    await assert.rejects(send(), (error) => /sent once and not resent/.test(error.message) && /reply lost/.test(error.message) && error.replyLost === true);
    assert.equal(mock.requests(method).length, 1, method);
  }
  // It ran all the same.
  assert.equal(mock.state.actionsRun.length, 1);
  assert.deepEqual(mock.state.commandsRun.at(-1), ['File', 'Save']);

  // A stall longer than the window fails within it, after at most two resends.
  mock.state.stallUntil = Date.now() + 60_000;
  const before = mock.requests('value.get').length;
  const started = Date.now();
  await assert.rejects(client.getValue('ch.0.volume'), /did not answer "value.get".*waiting out a MIDI Remote stall/);
  assert.ok(Date.now() - started < 2500);
  assert.ok(mock.requests('value.get').length - before <= 3);
  mock.state.stallUntil = 0;
});

test('late answers are counted and reported, not taken for another request', async () => {
  const { client, mock, bridge } = await setupCubase(STALLS);
  const late = [];
  bridge.on('lateAnswer', (event) => late.push(event));
  mock.state.delayNextReplyMs = 300;
  const value = await client.getValue('ch.2.pan');
  assert.equal(value.d, 'C');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(bridge.stats.lateAnswers, 1);
  assert.equal(late[0].method, 'value.get');
});

test('cubase_gain_stage reads only the input gains it plans with and always returns the plan', async () => {
  const { call, mock, bridge } = await setupServer({ ...STALLS, recovery: { windowMs: 600, pingTimeoutMs: 100 } });
  mock.state.meterLevels = { Kick: 0.5, Snare: 0.25, 'Lead Vox': 0.8, 'Stereo Out': 0.9 };
  const dry = await call('cubase_gain_stage', { seconds: 2 });
  assert.deepEqual(wholeBankReads(mock), []);
  const gainReads = mock.requests('value.get').filter((r) => r.params.keys.some((k) => k.endsWith('pre.gain')));
  assert.deepEqual(gainReads.flatMap((r) => r.params.keys), ['ch.0.pre.gain', 'ch.1.pre.gain', 'ch.4.pre.gain']);
  assert.deepEqual(
    dry.plan.filter((p) => p.newInputGainDb !== undefined).map((p) => [p.channel, p.currentInputGainDb]),
    [
      ['Kick', 0],
      ['Snare', 0],
      ['Lead Vox', 0],
    ],
  );
  assert.equal(dry.plan.find((p) => p.channel === 'Bass DI').skipped, 'no signal');
  assert.equal(mock.state.hostValues.get('host.mTransport.mValue.mStart').value, 0, 'stopped');

  // Cubase stalls on the first gain write: that step reports the error, the rest are not applied.
  mock.state.onRequest = (request) => {
    if (request.method === 'value.set' && request.params.key.endsWith('pre.gain') && !mock.state.stallUntil) mock.state.stallUntil = Date.now() + 60_000;
  };
  const applied = await call('cubase_gain_stage', { seconds: 2, apply: true });
  mock.state.stallUntil = 0;
  mock.state.onRequest = null;
  assert.equal(applied.error, undefined, JSON.stringify(applied));
  assert.equal(applied.applied, false);
  assert.match(applied.warning, /Writing the input gain of "Kick" failed/);
  const [kick, snare, vox] = ['Kick', 'Snare', 'Lead Vox'].map((name) => applied.plan.find((p) => p.channel === name));
  assert.deepEqual([kick.applied, typeof kick.error], [false, 'string']);
  assert.match(snare.notApplied, /stopped after the error on "Kick"/);
  assert.match(vox.notApplied, /stopped/);
  assert.ok(bridge.stats.stalls > 0);
});

test('measurements run one at a time instead of interleaving transport and meter resets', async () => {
  const { call, mock } = await setupServer();
  mock.state.meterLevels = { Kick: 0.5 };
  const [a, b, reset] = await Promise.all([
    call('cubase_measure_levels', { seconds: 1 }),
    call('cubase_measure_levels', { seconds: 1 }),
    call('cubase_reset_meters'),
  ]);
  assert.equal(a.channels[0].name, 'Kick');
  assert.equal(b.channels[0].name, 'Kick');
  assert.equal(reset.reset, true);
  const steps = mock.state.requestLog
    .map((r) =>
      r.method === 'meters.reset' ? 'reset' : r.method === 'value.set' && r.params.key === 'tr.start' ? 'play' : r.method === 'value.pulse' && r.params.key === 'tr.stop' ? 'stop' : null,
    )
    .filter(Boolean);
  // In whatever order the calls got their turn, each play comes right after its reset and before its stop.
  assert.deepEqual([...steps].sort(), ['play', 'play', 'reset', 'reset', 'reset', 'stop', 'stop']);
  steps.forEach((step, i) => {
    if (step === 'play') assert.deepEqual([steps[i - 1], steps[i + 1]], ['reset', 'stop'], steps.join());
  });
});

test('cubase_status reports when the script started even when its hello came before the server', async () => {
  const { call, bridge } = await setupServer({ activateFirst: true });
  assert.equal(bridge.lastHello, undefined);
  const status = await call('cubase_status');
  assert.equal(status.lastHello, undefined);
  assert.match(status.scriptStartedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(status.scriptActivatedDuringSession, null);
  assert.equal(status.serverSession, bridge.session);
  assert.match(status.lastAnswerAt, /^\d{4}-/);
  const live = await setupServer();
  assert.match((await live.call('cubase_status')).scriptActivatedDuringSession, /^\d{4}-/);
});

test('request ids and sessions tell server processes apart in the script log', async () => {
  const { call, mock, bridge } = await setupServer();
  // A second server process on the same buses.
  const other = new CubaseBridge(mock.transport, 2000);
  await other.connect();
  assert.notEqual(other.session, bridge.session);
  assert.notEqual(other.firstId, bridge.firstId);
  const [mine, theirs] = await Promise.all([bridge.request('value.get', { keys: ['ch.0.volume'] }), other.request('ping')]);
  assert.ok(mine['ch.0.volume']);
  assert.equal(theirs.pong, true);
  // Each one got only its own answers.
  assert.ok(bridge.stats.foreignAnswers >= 1);
  assert.ok(other.stats.foreignAnswers >= 1);
  const log = await call('cubase_get_script_log', { requests: true });
  assert.equal(log.serverSession, bridge.session);
  assert.match(log.scriptStartedAt, /^\d{4}-/);
  const ping = log.requests.find((r) => r.session === other.session);
  assert.equal(ping.fromThisServer, false);
  assert.ok(log.requests.filter((r) => r.session === bridge.session).every((r) => r.fromThisServer));
  assert.equal(log.oldestId, log.requests[0].id);
  // Scripts that do not record the session: told apart by the ids this process used.
  assert.ok(bridge.ownsId(bridge.firstId));
  assert.ok(!bridge.ownsId(bridge.firstId - 1));
});

test('switches wait for Cubase to apply them late and never pulse', async () => {
  const { client, mock } = await setupCubase({ confirmMs: 1200 });
  mock.state.lag = [{ pattern: /mMute$/, ms: 300 }];
  const late = await client.setBool('ch.3.mute', true);
  assert.deepEqual([late.state, late.verified, late.applied], [true, true, 'confirmed']);

  // Later than the wait: reported as unconfirmed, and nothing switches it back when it lands.
  mock.state.lag = [{ pattern: /mSolo$/, ms: 2000 }];
  const slow = await client.setBool('ch.3.solo', true);
  assert.deepEqual([slow.state, slow.verified, slow.applied], [false, false, 'unconfirmed']);
  assert.deepEqual(mock.requests('value.pulse'), []);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await client.getValue('ch.3.solo')).v, 1);

  // Normalized writes too.
  mock.state.lag = [{ pattern: /mLowCutSlope$/, ms: 300 }];
  const slope = await client.writeAndRead('sel.pre.lowCutSlope', 0.75);
  assert.deepEqual([slope.v, slope.applied], [0.75, 'confirmed']);
  mock.state.ignored = /mHighCutSlope$/;
  const ignored = await client.writeAndRead('sel.pre.highCutSlope', 0.75);
  assert.deepEqual([ignored.v, ignored.applied], [0, 'unconfirmed']);
});

test('selecting a channel waits for a late selection and sends the same write again, never a pulse', async () => {
  const { client, mock } = await setupCubase({ selectionTimeoutMs: 1500 });
  mock.state.lag = [{ pattern: /mSelected$/, ms: 700 }];
  const late = await client.focusChannel('Lead Vox');
  assert.deepEqual([late.verified, late.applied, late.selectedTitle], [true, 'confirmed', 'Lead Vox']);
  mock.state.lag = [];
  mock.state.ignored = /channel2\.mValue\.mSelected$/;
  const never = await client.focusChannel('Bass DI');
  assert.deepEqual([never.verified, never.applied], [false, 'unconfirmed']);
  const writes = mock.requests('value.set').filter((r) => r.params.key === 'ch.2.selected');
  assert.deepEqual(
    writes.map((r) => r.params.value),
    [1, 1],
  );
  assert.deepEqual(mock.requests('value.pulse'), []);
});

test('cubase_set_prefilter reports the slopes Cubase applied', async () => {
  const { call, mock } = await setupServer();
  mock.state.lag = [{ pattern: /CutSlope$/, ms: 300 }];
  const result = await call('cubase_set_prefilter', { channel: 'Kick', lowCutSlope: 0.5, highCutSlope: 1 });
  assert.deepEqual([result.lowCutSlope.v, result.lowCutSlope.applied, result.highCutSlope.v], [0.5, 'confirmed', 1]);
});

test('answers stay small: compact JSON, real sends only, key summaries and capped lists', async () => {
  const { mcp, call, mock } = await setupServer({ tracks: bigProject() });
  // A send with a destination on bank slot 2; the other 383 send slots have none.
  mock.state.bankChannels[2].mSends.getByIndex(0).mOnTitleChange({}, {}, 'FX Reverb');
  const raw = await mcp.callTool({ name: 'cubase_list_channels', arguments: {} });
  const text = raw.content[0].text;
  assert.ok(!text.includes('\n'), 'compact JSON');
  assert.ok(text.length < 12_000, `${text.length} characters`);
  const list = JSON.parse(text);
  assert.deepEqual(list.channels[2].sends, [{ slot: 1, to: 'FX Reverb', level: '-oo dB', on: false }]);
  assert.ok(list.channels.filter((c) => c.index !== 2).every((c) => c.sends.length === 0));
  const paged = await call('cubase_list_channels', { fields: ['mute'], offset: 40, limit: 5 });
  assert.deepEqual([paged.count, paged.offset, paged.returned, paged.channels[0].index], [48, 40, 5, 40]);
  assert.deepEqual(Object.keys(paged.channels[0]), ['index', 'name', 'uid', 'kind', 'mute']);
  assert.match(paged.note, /offset 45/);
  const channel = await call('cubase_get_channel', { channel: 'Track 001' });
  assert.deepEqual(channel.sends, []);

  const keys = await call('cubase_list_value_keys');
  assert.ok(keys.count > 1500);
  assert.equal(keys.patterns['ch.N.send.N.level'], 48 * 8);
  assert.ok(JSON.stringify(keys).length < 6000);
  assert.ok((await call('cubase_list_value_keys', { prefix: 'ch.3.' })).keys.includes('ch.3.volume'));

  const tree = await call('cubase_da_tree', { scope: 'mixconsole' });
  for (const key of ['color', 'uid', 'uniqueName', 'mixerChannelVisible']) assert.ok(!(key in tree.root), key);
  assert.equal(tree.root.paramCount, 0);
  assert.ok('color' in (await call('cubase_da_tree', { scope: 'mixconsole', details: true })).root);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, limit: 500 })).error, /200/);
});
