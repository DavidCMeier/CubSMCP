/**
 * Transport, markers and key commands: the cursor is checked through the DirectAccess transport time,
 * marker commands that do nothing are reported, and transport key commands are written as values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimeDisplay, parseTimeDisplay } from '../dist/cubase/display.js';
import { setupServer } from './helpers/session.mjs';

const playing = (mock) => mock.state.hostValues.get('host.mTransport.mValue.mStart').value > 0.5;

test('transport times parse and format like Cubase shows them', () => {
  assert.equal(parseTimeDisplay('0:01:23.000'), 83);
  assert.equal(parseTimeDisplay('1:23.456'), 83.456);
  assert.equal(parseTimeDisplay(' 1:00:00.5 '), 3600.5);
  assert.equal(parseTimeDisplay('5. 1. 1.   0'), null);
  assert.equal(formatTimeDisplay(83.4567), '0:01:23.457');
  assert.equal(formatTimeDisplay(3725), '1:02:05.000');
});

test('forward and rewind move the cursor through the transport time and do not stop playback', async () => {
  const { call, mock } = await setupServer();
  mock.setTime(60);
  const forward = await call('cubase_transport', { action: 'forward' });
  assert.equal(forward.applied, 'confirmed', JSON.stringify(forward));
  assert.equal(mock.time(), 65);
  assert.deepEqual([forward.before.time, forward.state.position.time, forward.moved], ['0:01:00.000', '0:01:05.000', true]);
  assert.equal((await call('cubase_transport', { action: 'rewind', seconds: 10 })).applied, 'confirmed');
  assert.equal(mock.time(), 55);

  // While playing: the cursor moves and playback goes on.
  await call('cubase_transport', { action: 'play' });
  const during = await call('cubase_transport', { action: 'forward', seconds: 20 });
  assert.equal(during.state.playing, true);
  assert.ok(playing(mock));
  assert.equal(mock.time(), 75);
  await call('cubase_transport', { action: 'stop' });
  assert.ok(!playing(mock));

  assert.equal((await call('cubase_transport', { action: 'locate', to: '0:00:10.250' })).applied, 'confirmed');
  assert.equal(mock.time(), 10.25);
  assert.equal((await call('cubase_transport', { action: 'locate', to: 30 })).state.position.seconds, 30);
  assert.match((await call('cubase_transport', { action: 'locate', to: 'soon' })).error, /not a time/);
  assert.match((await call('cubase_transport', { action: 'play', seconds: 3 })).error, /only applies to forward and rewind/);
  assert.match((await call('cubase_transport', { action: 'locate' })).error, /needs "to"/);
});

test('transport commands report the cursor before and after', async () => {
  const { call, mock } = await setupServer();
  mock.setTime(42);
  const end = await call('cubase_transport', { action: 'go_to_end' });
  assert.deepEqual([end.sent, end.moved, end.state.position.time], [true, true, '0:05:06.786']);
  const state = await call('cubase_get_transport_state');
  assert.deepEqual(state.position, { time: '0:05:06.786', seconds: 306.786, leftLocator: '0:03:02.439', rightLocator: '0:03:11.385' });
  const left = await call('cubase_transport', { action: 'go_to_left_locator' });
  assert.equal(left.state.position.seconds, 182.439);
  // Without markers, Locate Next Marker goes to the project end (live, 14 Oct 2026); from there it has nothing
  // to act on: Cubase does nothing, and moved says so.
  const next = await call('cubase_transport', { action: 'next_marker' });
  assert.deepEqual([next.moved, next.state.position.time], [true, '0:05:06.786']);
  const again = await call('cubase_transport', { action: 'next_marker' });
  assert.equal(again.moved, false);
});

test('cubase_go_to_marker says when the marker does not exist and puts the cursor back', async () => {
  const { call, mock } = await setupServer({ confirmMs: 500 });
  mock.setTime(60);
  const missing = await call('cubase_go_to_marker', { number: 9 });
  assert.deepEqual([missing.markerFound, missing.verified, missing.moved], [false, true, false], JSON.stringify(missing));
  assert.match(missing.note, /no marker 9/);
  assert.equal(mock.time(), 60);

  mock.state.markers = { 2: 12.5, 3: 60 };
  const found = await call('cubase_go_to_marker', { number: 2 });
  assert.deepEqual([found.markerFound, found.moved, found.position.seconds], [true, true, 12.5]);
  // Already on it: found, not moved.
  mock.setTime(60);
  const here = await call('cubase_go_to_marker', { number: 3 });
  assert.deepEqual([here.markerFound, here.moved, mock.time()], [true, false, 60], JSON.stringify(here));

  mock.state.cycleMarkers = { 1: [20, 30] };
  const cycle = await call('cubase_go_to_marker', { number: 1, cycle: true });
  assert.deepEqual([cycle.markerFound, cycle.position.leftLocator, cycle.position.rightLocator], [true, '0:00:20.000', '0:00:30.000']);
  const noCycle = await call('cubase_go_to_marker', { number: 4, cycle: true });
  assert.equal(noCycle.markerFound, false);
  assert.deepEqual([mock.time(4030), mock.time(4031)], [20, 30], 'locators put back');
  // Already showing cycle marker 1: found.
  assert.equal((await call('cubase_go_to_marker', { number: 1, cycle: true })).markerFound, true);
});

test('measuring from a missing marker fails before playing; a cycle marker starts at its left locator', async () => {
  const { call, mock } = await setupServer({ confirmMs: 500 });
  mock.state.meterLevels = { Kick: 0.5 };
  mock.setTime(100);
  const missing = await call('cubase_measure_levels', { seconds: 1, fromMarker: 1 });
  assert.match(missing.error, /Marker 1 was not found.*Nothing was played/);
  assert.equal(mock.requests('meters.reset').length, 0);
  assert.match((await call('cubase_gain_stage', { seconds: 2, fromCycleMarker: 2 })).error, /Cycle marker 2 was not found/);

  // The command only sets the locators (as in the mock): the cursor is sent to the left locator before playing.
  mock.state.cycleMarkers = { 1: [20, 30] };
  let startedAt = null;
  mock.state.onRequest = (request) => {
    if (request.method === 'value.set' && request.params.key === 'tr.start' && request.params.value === 1) startedAt = mock.time();
  };
  const measured = await call('cubase_measure_levels', { seconds: 1, fromCycleMarker: 1 });
  assert.equal(startedAt, 20);
  assert.deepEqual(measured.section, { cycleMarker: 1, from: '0:00:20.000', to: '0:00:30.000', seconds: 1 });
  assert.equal(measured.channels[0].name, 'Kick');
  // Again with the locators already on it: still found (the probe moves them away and the marker brings them back).
  mock.state.cycleMarkers[2] = [40, 40.5];
  mock.setTime(40, 4030);
  mock.setTime(40.5, 4031);
  const short = await call('cubase_measure_levels', { seconds: 1, fromCycleMarker: 2 });
  assert.equal(startedAt, 40);
  assert.ok(short.warnings.some((w) => /longer than cycle marker 2/.test(w)), JSON.stringify(short));
  assert.deepEqual([mock.time(4030), mock.time(4031)], [40, 40.5]);

  // A cycle marker command that only moves the cursor: the section starts there, and the answer says so.
  mock.state.cycleMarkers[3] = [70, 80];
  mock.state.cycleRecallIgnored = true;
  const cursorOnly = await call('cubase_measure_levels', { seconds: 1, fromCycleMarker: 3 });
  assert.equal(startedAt, 70);
  assert.ok(cursorOnly.warnings.some((w) => /moved the cursor but not the locators/.test(w)), JSON.stringify(cursorOnly));
});

test('Transport Start, Stop and toggles run as transport values and are confirmed; other commands say sent, not confirmed', async () => {
  const { call, mock } = await setupServer();
  const start = await call('cubase_run_command', { category: 'Transport', name: 'Start' });
  assert.deepEqual([start.via, start.state, start.applied], ['tr.start', true, 'confirmed'], JSON.stringify(start));
  assert.ok(playing(mock));
  assert.ok(!mock.state.commandsRun.some(([c, n]) => c === 'Transport' && n === 'Start'));
  const stop = await call('cubase_run_command', { category: 'transport', name: 'stop' });
  assert.deepEqual([stop.via, stop.applied], ['tr.stop', 'confirmed']);
  assert.ok(!playing(mock));
  const cycle = await call('cubase_run_command', { category: 'Transport', name: 'Cycle' });
  assert.deepEqual([cycle.via, cycle.state], ['tr.cycle', true]);

  const save = await call('cubase_run_command', { category: 'File', name: 'Save' });
  assert.deepEqual([save.sent, save.confirmed], [true, false]);
  assert.match(save.note, /no feedback/);
  const sequence = await call('cubase_run_command_sequence', {
    steps: [
      { category: 'Transport', name: 'Start', waitMs: 0 },
      { category: 'Transport', name: 'Stop', waitMs: 0 },
      { category: 'Edit', name: 'Undo', waitMs: 0 },
    ],
  });
  assert.deepEqual(
    sequence.results.map((r) => [r.ok, r.applied ?? null, r.sent ?? null]),
    [
      [true, 'confirmed', null],
      [true, 'confirmed', null],
      [true, null, true],
    ],
  );

  const { tools } = await (await setupServer()).mcp.listTools();
  const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
  for (const name of ['cubase_run_command', 'cubase_run_command_sequence', 'cubase_undo', 'cubase_create_bus_for_selection', 'cubase_save_project', 'cubase_export_audio_mixdown']) {
    assert.ok(destructive.includes(name), name);
  }
});

test('cubase_list_commands: category and search ignore case, and the descriptions say so', async () => {
  const { call, mcp } = await setupServer();
  const lower = await call('cubase_list_commands', { category: 'transport', limit: 600 });
  const exact = await call('cubase_list_commands', { category: 'Transport', limit: 600 });
  assert.equal(lower.total, exact.total);
  assert.ok(lower.total > 40);
  assert.equal((await call('cubase_list_commands', { category: 'Trans' })).total, 0);
  assert.ok((await call('cubase_list_commands', { search: 'TRANSPORT / start' })).total >= 1);
  const { tools } = await mcp.listTools();
  const list = tools.find((t) => t.name === 'cubase_list_commands');
  assert.doesNotMatch(JSON.stringify(list), /Exact category/);
  assert.match(list.inputSchema.properties.category.description, /ignoring case/);
  assert.match(tools.find((t) => t.name === 'cubase_run_command').description, /ignoring case/);
});

test('positions work with the primary time format on bars and beats, which is put back afterwards', async () => {
  // Live (15 Oct 2026): with bars and beats, a time written as "0:01:54.816" landed on bar 3.
  const { call, mock, client } = await setupServer();
  await client.call('da.setParam', { scope: 'transport', tag: 4025, resolvePlugin: false, value: 0 });
  const located = await call('cubase_transport', { action: 'locate', to: 114.816 });
  assert.equal(located.applied, 'confirmed', JSON.stringify(located));
  assert.equal(mock.time(), 114.816);
  assert.equal(located.state.position.seconds, 114.816);
  const state = await call('cubase_get_transport_state');
  assert.equal(state.position.seconds, 114.816);
  const format = await client.call('da.getParam', { scope: 'transport', tag: 4025, resolvePlugin: false });
  assert.equal(format.parameter.display, 'Compases+Tiempos');
});

