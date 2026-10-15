import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { createMockCubase, TRACKS } from './helpers/mockCubase.mjs';
import { CubaseBridge } from '../dist/bridge/midiBridge.js';
import { CubaseClient } from '../dist/cubase/client.js';
import { encodeMessage, decodeFrame, MessageAssembler, MessageKind } from '../dist/bridge/protocol.js';
import { meterToDb, parseDisplay } from '../dist/cubase/display.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(root, 'build', 'cubase', 'Local', 'MCP', 'CubaseBridge', 'MCP_CubaseBridge.js');

async function setup() {
  const mock = createMockCubase();
  mock.load(scriptPath);
  const bridge = new CubaseBridge(mock.transport, 2000);
  await bridge.connect();
  mock.activate();
  await new Promise((resolve) => setImmediate(resolve));
  const client = new CubaseClient(bridge, 1, { bankTimeoutMs: 300 });
  return { mock, bridge, client };
}

test('generated Cubase script is valid ES5', () => {
  const code = readFileSync(scriptPath, 'utf8');
  assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: 5, sourceType: 'script' }));
});

test('protocol round-trips chunked unicode payloads', () => {
  const value = { text: 'Guitarra ñ — ' + 'x'.repeat(1000), n: 42 };
  const frames = encodeMessage(MessageKind.Response, 77, value, 64);
  assert.ok(frames.length > 10);
  for (const frame of frames) assert.ok(frame.slice(1, -1).every((b) => b < 0x80));
  const assembler = new MessageAssembler();
  let result = null;
  for (const frame of frames) result = assembler.push(decodeFrame(frame)) ?? result;
  assert.deepEqual(result.value, value);
});

test('display parsing handles Cubase formats', () => {
  assert.equal(parseDisplay('-6.02', 'dB').value, -6.02);
  assert.equal(parseDisplay('-oo', 'dB').value, Number.NEGATIVE_INFINITY);
  assert.equal(parseDisplay('L32', '').value, -32);
  assert.equal(parseDisplay('R100', '').value, 100);
  // Real Cubase 13 formats seen on a live project.
  assert.equal(parseDisplay('-oodB', '').value, Number.NEGATIVE_INFINITY);
  assert.equal(parseDisplay('L', '').value, -100);
  assert.equal(parseDisplay('R', '').value, 100);
  assert.equal(parseDisplay('C', '').value, 0);
  assert.equal(parseDisplay('1.20', 'kHz').value, 1200);
  assert.equal(parseDisplay('850.0', 'Hz').value, 850);
});

test('meter values convert to the dB Cubase 13 displays', () => {
  // Pairs read from a live Cubase 13 meter: normalized value -> display.
  assert.equal(meterToDb(0.26468199491500854), -8.5);
  assert.equal(meterToDb(0.01600014418363571), -32.9);
  assert.equal(meterToDb(0), null);
  assert.equal(meterToDb(null), null);
});

test('script answers ping and capabilities', async () => {
  const { client, bridge } = await setup();
  const ping = await client.ping();
  assert.equal(ping.pong, true);
  assert.equal(ping.activated, true);
  const caps = await client.capabilities();
  assert.equal(caps.capabilities.directAccess, true);
  assert.ok(caps.valueCount > 500);
  assert.ok(caps.commandCount > 400);
  assert.ok(caps.actions.includes('bank.next'));
  assert.equal(bridge.lastHello?.event, 'hello');
});

test('lists channels with names and values', async () => {
  const { client } = await setup();
  const { channels } = await client.channels(true);
  assert.deepEqual(
    channels.map((c) => c.title),
    TRACKS,
  );
  assert.equal(channels[0].values['ch.0.volume'].u, 'dB');
});

test('seeks a fader to a dB target', async () => {
  const { client } = await setup();
  const result = await client.seekDisplay('ch.2.volume', -6.5);
  assert.ok(result.withinTolerance, JSON.stringify(result));
  assert.ok(Math.abs(result.achieved + 6.5) <= 0.15);
});

test('seeks pan and EQ frequency in real units', async () => {
  const { client } = await setup();
  const pan = await client.seekDisplay('ch.1.pan', -30);
  assert.ok(Math.abs(pan.achieved + 30) <= 1, JSON.stringify(pan));
  const freq = await client.seekDisplay('sel.eq.2.freq', 2500);
  assert.ok(Math.abs(freq.achieved - 2500) <= 25, JSON.stringify(freq));
});

test('sets booleans and verifies them', async () => {
  const { client } = await setup();
  const result = await client.setBool('ch.3.mute', true);
  assert.equal(result.verified, true);
  const state = await client.getValue('ch.3.mute');
  assert.equal(state.v, 1);
});

test('reports the state a switch ends up in, not whether it was verified', async () => {
  const { client } = await setup();
  const on = await client.setBool('ch.3.mute', true);
  assert.equal(on.state, true);
  const off = await client.setBool('ch.3.mute', false);
  assert.deepEqual([off.state, off.verified], [false, true]);
});

test('writeAndRead returns the value Cubase applied', async () => {
  const { client } = await setup();
  const state = await client.writeAndRead('ch.2.pan', 0.25);
  assert.equal(state.v, 0.25);
  assert.equal(state.d, 'L50');
});

test('focuses a channel by name', async () => {
  const { client } = await setup();
  const result = await client.focusChannel('lead');
  assert.equal(result.verified, true);
  assert.equal(result.selectedTitle, 'Lead Vox');
});

test('reports a stale selection when the selected track has no mixer channel', async () => {
  const { client, mock } = await setup();
  await client.focusChannel('lead');
  assert.deepEqual(await client.selection(), {
    title: 'Lead Vox',
    hasMixerChannel: true,
    bankSelected: [{ index: 4, title: 'Lead Vox' }],
  });
  mock.selectTrackWithoutMixerChannel();
  // Cubase empties the selection object's title, but the sel.* values keep naming the old channel.
  const selected = await client.selected();
  assert.equal(selected.title, '');
  assert.equal(selected.values['sel.volume'].t, 'Lead Vox');
  assert.deepEqual(await client.selection(), { title: null, hasMixerChannel: false, bankSelected: [] });
});

test('polls the selection with a small answer and logs requests', async () => {
  const { client } = await setup();
  await client.focusChannel('lead');
  const info = await client.selectionInfo();
  assert.deepEqual(Object.keys(info).sort(), ['bankSelected', 'selectedFlag', 'title', 'uid']);
  assert.deepEqual([info.title, info.uid], ['Lead Vox', 'uid-4-Lead Vox']);
  const { requests } = await client.call('debug.requests');
  // The last entry is debug.requests itself, still unanswered while it builds the list.
  assert.equal(requests.at(-1).method, 'debug.requests');
  const poll = requests.at(-2);
  assert.equal(poll.method, 'state.selection');
  assert.equal(poll.chunks, 1);
});

test('reads the mix for snapshots in small answers and pages the bank', async () => {
  const { client, mock } = await setup();
  const page = await client.readSnapshotPage();
  assert.ok(page.fields.includes('pre.lowCutFreq'));
  assert.deepEqual(page.channels.map((c) => c.title), TRACKS);
  assert.equal(new Set(page.channels.map((c) => c.uid)).size, TRACKS.length);
  assert.equal(page.channels[0].values.length, page.fields.length);
  const { requests } = await client.call('debug.requests');
  assert.ok(requests.filter((r) => r.method === 'snapshot.read').every((r) => r.chunks <= 20));
  assert.equal(page.size, 48);
  // Six channels fit in one page, which is not full: paging stops after it.
  const visited = [];
  const paging = await client.forEachBankPage(async (n) => {
    visited.push(n);
  });
  assert.deepEqual(visited, [0]);
  assert.equal(paging.bankRestored, true);
  assert.deepEqual(mock.state.actionsRun.map((a) => a.split('.').pop()), ['mResetBank']);
  // Now the server knows the first page: when the bank already shows it, nothing moves.
  const before = mock.state.actionsRun.length;
  await client.forEachBankPage(async () => true);
  assert.equal(mock.state.actionsRun.length - before, 0);
  // The bank goes back to its page even when a visit fails.
  await assert.rejects(client.forEachBankPage(async () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(mock.state.bankOffset, 0);
});

test('ping reports the script start time', async () => {
  const { client } = await setup();
  const ping = await client.ping();
  assert.equal(typeof ping.startedAt, 'number');
});

test('runs key commands and actions', async () => {
  const { client, mock } = await setup();
  await client.runCommand('File', 'Save');
  await client.runAction('bank.next');
  assert.deepEqual(mock.state.commandsRun.at(-1), ['File', 'Save']);
  assert.equal(mock.state.actionsRun.length, 1);
  await assert.rejects(client.runCommand('Nope', 'Missing'), /not bound/);
  // An empty name names what was asked instead of "undefined".
  await assert.rejects(client.runCommand('', ''), (error) => /not bound in script: "" \/ ""/.test(error.message) && !/undefined/.test(error.message));
});

test('DirectAccess lists and sets plugin parameters', async () => {
  const { client } = await setup();
  const params = await client.call('da.params', { scope: 'sel.ins.0' });
  assert.equal(params.total, 3);
  assert.equal(params.parameters[0].title, 'Threshold');
  const set = await client.call('da.setParam', { scope: 'sel.ins.0', title: 'ratio', value: 0.5 });
  assert.equal(set.parameter.value, 0.5);
  const seek = await client.seekDirectParameter('sel.strip.compressor', { title: 'Threshold' }, -18);
  assert.ok(seek.withinTolerance, JSON.stringify(seek));
  const tree = await client.call('da.tree', { scope: 'mixconsole', maxDepth: 2 });
  assert.equal(tree.root.title, 'VST Mixer');
  assert.deepEqual(tree.root.children.map((c) => c.title), TRACKS);
  assert.equal(tree.root.children[0].children[0].title, 'Input Filter');
});

test('unknown methods return errors instead of hanging', async () => {
  const { client } = await setup();
  await assert.rejects(client.call('does.not.exist'), /Unknown method/);
});
