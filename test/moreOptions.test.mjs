/**
 * Options added after testing every option against Cubase 13 (transport, commands and undo, diagnostics):
 * locators, returnOnStop, bar steps and nudges, the marker list, meter filters, the Edit menu after an undo,
 * unbound commands, waiting for a value after a command, the catalog, compact outputs, raw keys by channel name
 * and the request filters of the script log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bigProject, setupServer } from './helpers/session.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const playing = (mock) => mock.state.hostValues.get('host.mTransport.mValue.mStart').value > 0.5;

test('set_locators sets and reads back the locators, the right one first when they move past it', async () => {
  const { call, mock } = await setupServer();
  const both = await call('cubase_transport', { action: 'set_locators', left: 200, right: '0:03:30.250' });
  assert.equal(both.applied, 'confirmed', JSON.stringify(both));
  assert.deepEqual([mock.time(4030), mock.time(4031)], [200, 210.25]);
  assert.deepEqual(both.requested, { right: '0:03:30.250', left: '0:03:20.000' });
  assert.deepEqual([both.before.leftLocator, both.state.position.leftLocator], ['0:03:02.439', '0:03:20.000']);
  // Writes go by display: the milliseconds stay.
  assert.equal((await call('cubase_transport', { action: 'set_locators', left: 12.345 })).state.position.leftLocator, '0:00:12.345');
  assert.equal(mock.time(4031), 210.25);

  assert.match((await call('cubase_transport', { action: 'set_locators' })).error, /needs left, right or both/);
  assert.match((await call('cubase_transport', { action: 'set_locators', left: 'soon' })).error, /left "soon" is not a time/);
  assert.match((await call('cubase_transport', { action: 'set_locators', left: 20, right: 10 })).error, /right must be after left/);
  assert.match((await call('cubase_transport', { action: 'play', left: 10 })).error, /only apply to set_locators/);
});

test('returnOnStop is read and set through DirectAccess; the tempo is reported as not available', async () => {
  const { call } = await setupServer();
  const state = await call('cubase_get_transport_state');
  assert.deepEqual([state.returnOnStop, state.signature, state.tempo], [false, '4/4', null], JSON.stringify(state));
  assert.match(state.tempoNote, /not available/i);
  const on = await call('cubase_transport', { action: 'return_on_stop_on' });
  assert.deepEqual([on.returnOnStop, on.applied], [true, 'confirmed']);
  assert.equal((await call('cubase_get_transport_state')).returnOnStop, true);
  assert.equal((await call('cubase_transport', { action: 'return_on_stop_off' })).returnOnStop, false);
  const { tools } = await (await setupServer()).mcp.listTools();
  assert.match(tools.find((t) => t.name === 'cubase_get_transport_state').description, /tempo is not available/i);
});

test('step_bar, step_back_bar and the nudges move the cursor through DirectAccess, or the key command when the button did nothing', async () => {
  const { call, mock } = await setupServer({ confirmMs: 400 });
  mock.setTime(61);
  const step = await call('cubase_transport', { action: 'step_bar' });
  assert.deepEqual([step.via, step.moved, step.before.time, step.state.position.time], ['directAccess', true, '0:01:01.000', '0:01:02.000'], JSON.stringify(step));
  assert.equal((await call('cubase_transport', { action: 'step_back_bar' })).state.position.seconds, 60);
  assert.equal((await call('cubase_transport', { action: 'nudge_forward' })).state.position.seconds, 61);
  assert.equal((await call('cubase_transport', { action: 'nudge_back' })).state.position.seconds, 60);
  assert.ok(!mock.state.commandsRun.some(([, n]) => /Step|Nudge/.test(n)));

  mock.state.transportButtonsIgnored = true;
  const fallback = await call('cubase_transport', { action: 'step_bar' });
  assert.deepEqual([fallback.via, fallback.moved, mock.time()], ['Transport / Step Bar', true, 62]);
  // At the project start nothing moves, and the answer says so.
  mock.setTime(0);
  const stuck = await call('cubase_transport', { action: 'step_back_bar' });
  assert.deepEqual([stuck.via, stuck.moved], [null, false]);
  assert.match(stuck.note, /Neither the DirectAccess button nor Transport \/ Step Back Bar/);
  assert.equal(mock.time(), 0);
});

test('cubase_list_markers walks Locate Next Marker from the start, tells the project end from markers and puts the cursor back', async () => {
  const { call, mock } = await setupServer({ confirmMs: 300 });
  mock.setTime(42);
  const none = await call('cubase_list_markers');
  assert.deepEqual([none.count, none.markers, none.projectEnd.seconds, none.cursorRestored, none.complete], [0, [], 306.786, true, true], JSON.stringify(none));
  assert.match(none.note, /names or IDs/);

  mock.state.markers = { 1: 12.5, 2: 60, 5: 100.25 };
  const listed = await call('cubase_list_markers');
  assert.deepEqual(
    listed.markers.map((m) => [m.number, m.time, m.seconds]),
    [
      [1, '0:00:12.500', 12.5],
      [2, '0:01:00.000', 60],
      [3, '0:01:40.250', 100.25],
    ],
  );
  assert.equal(mock.time(), 42);
  const limited = await call('cubase_list_markers', { maxMarkers: 2 });
  assert.deepEqual([limited.markers.length, limited.complete], [2, false]);
  assert.equal(mock.time(), 42);

  await call('cubase_transport', { action: 'play' });
  assert.match((await call('cubase_list_markers')).error, /stop it first/);
  await call('cubase_transport', { action: 'stop' });
  assert.ok(!playing(mock));
});

test('cubase_get_meters keeps only the channels asked for, or the ones with signal', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  mock.state.meterLevels = { 'Track 010': 0.5, 'G L Clean': 0.2 };
  await call('cubase_measure_levels', { seconds: 1 });
  const signal = await call('cubase_get_meters', { onlyWithSignal: true });
  assert.deepEqual([signal.total, signal.returned, signal.channels.map((c) => c.name)], [48, 2, ['Track 010', 'G L Clean']], JSON.stringify(signal.channels));
  const some = await call('cubase_get_meters', { channels: ['G L Clean', 3, 10] });
  assert.deepEqual(
    some.channels.map((c) => [c.index, c.peakDb === null]),
    [
      [3, true],
      [10, false],
      [41, false],
    ],
  );
  const both = await call('cubase_get_meters', { channels: [3, 10], onlyWithSignal: true });
  assert.deepEqual(both.channels.map((c) => c.index), [10]);
  // Meters only exist on the page shown now: a channel on another page is an error, and the bank does not move.
  assert.match((await call('cubase_get_meters', { channels: ['Trompeta'] })).error, /channels:.*not found|channels:.*current bank page/s);
  assert.equal(mock.state.bankOffset, 0);
});

/** A fake MacUi whose Edit menu follows an undo history kept in the mock (Edit / Undo pops it). */
function historyUi(mock, steps) {
  const history = [...steps];
  const redo = [];
  mock.state.onCommand = (category, name) => {
    if (category === 'Edit' && name === 'Undo' && history.length > 0) redo.push(history.pop());
    if (category === 'Edit' && name === 'Redo' && redo.length > 0) history.push(redo.pop());
  };
  const state = async () => ({ frontApp: 'Cubase 13', cubaseRunning: true, cubaseFrontmost: true, windows: [{ title: '', width: 1600, height: 1000 }] });
  return {
    activate: state,
    state,
    async listMenu(path) {
      if (path.length === 0) return { path, items: ['Cubase', 'Archivo', 'Edición'].map((name, i) => ({ name, index: i + 1, enabled: true, submenu: true })) };
      const last = (list) => list[list.length - 1];
      return {
        path,
        items: [
          { name: history.length ? `Deshacer ${last(history)}` : 'Deshacer', index: 1, enabled: history.length > 0, submenu: false },
          { name: redo.length ? `Rehacer ${last(redo)}` : 'Rehacer', index: 2, enabled: redo.length > 0, submenu: false },
        ],
      };
    },
  };
}

test('with UI automation, cubase_undo also returns the Edit menu after the undo', async () => {
  const session = await setupServer({ enableUi: true });
  session.ctx.ui = historyUi(session.mock, ['Añadir pista', 'Ajustar nombre de pista']);
  const first = await session.call('cubase_undo', { scope: 'edit' });
  assert.deepEqual([first.step, first.stepAfter], ['Ajustar nombre de pista', 'Añadir pista'], JSON.stringify(first));
  assert.deepEqual(first.menuAfter, {
    undo: { label: 'Deshacer Añadir pista', enabled: true },
    redo: { label: 'Rehacer Ajustar nombre de pista', enabled: true },
  });
  const second = await session.call('cubase_undo', { scope: 'edit' });
  assert.deepEqual([second.step, second.stepAfter], ['Añadir pista', null]);
  const redo = await session.call('cubase_undo', { scope: 'edit', redo: true });
  assert.deepEqual([redo.step, redo.stepAfter], ['Añadir pista', 'Ajustar nombre de pista']);
  // Without UI automation nothing is read from the menu.
  const plain = await (await setupServer()).call('cubase_undo', { scope: 'edit' });
  assert.equal('stepAfter' in plain, false);
});

test('an unbound command is an error before anything is sent, with close matches; cubase_list_commands can show unbound ones', async () => {
  const { call, mock } = await setupServer();
  const typo = await call('cubase_run_command', { category: 'Transport', name: 'Play from Selection Strat' });
  assert.match(typo.error, /not a command the bridge script binds, so nothing was sent/);
  assert.match(typo.error, /Close commands you can run: Transport \/ Play from Selection Start/);
  const unbound = await call('cubase_run_command', { category: 'Media', name: 'Rescan Disk' });
  assert.match(unbound.error, /is a Cubase command, but the bridge script does not bind it.*user-commands\.txt \(\[Media\] then Rescan Disk\)/);
  const label = await call('cubase_run_command', { category: 'Media', name: 'Rescan' });
  assert.match(label.error, /Close Cubase commands that are not bound .*Media \/ Rescan Disk/);
  assert.deepEqual(mock.state.commandsRun, []);
  // Labels still resolve to internal names.
  assert.equal((await call('cubase_run_command', { category: 'Transport', name: 'Activate Metronome' })).from, 'Transport / Activate Metronome');

  const sequence = await call('cubase_run_command_sequence', {
    steps: [
      { category: 'Transport', name: 'Nope', waitMs: 0 },
      { category: 'File', name: 'Save', waitMs: 0 },
    ],
  });
  assert.deepEqual([sequence.results.length, sequence.results[0].ok, sequence.stoppedBy], [1, false, 'step 1: error']);
  assert.ok(!mock.state.commandsRun.some(([c]) => c === 'File'));

  const bound = await call('cubase_list_commands', { search: 'rescan disk' });
  assert.equal(bound.total, 0);
  const all = await call('cubase_list_commands', { search: 'rescan disk', includeUnbound: true });
  assert.deepEqual(
    all.commands.map((c) => [c.category, c.name, c.inCatalog]),
    [['Media', 'Rescan Disk', false]],
  );
  assert.equal(all.notInCatalog, 1);
  const media = await call('cubase_list_commands', { category: 'media', includeUnbound: true, limit: 600 });
  assert.ok(media.commands.find((c) => c.name === 'Open MediaBay').inCatalog);
  assert.ok(media.notInCatalog > 30);
});

test('waitFor polls a raw value after a command and reports reached or timedOut', async () => {
  const { call, client, mock } = await setupServer();
  await client.setValue('ch.1.volume', 0.5);
  const undo = await call('cubase_run_command', {
    category: 'MixConsole History',
    name: 'Undo MixConsole Step',
    waitFor: { key: 'ch.1.volume', changed: true },
  });
  assert.deepEqual([undo.waitFor.reached, undo.waitFor.before.v, undo.waitFor.after.v], [true, 0.5, 0.8], JSON.stringify(undo));
  assert.equal(undo.note, undefined);
  const timeout = await call('cubase_run_command', { category: 'File', name: 'Save', waitFor: { key: 'tr.cycle', value: 1, timeoutMs: 300 } });
  assert.deepEqual([timeout.sent, timeout.waitFor.reached, timeout.waitFor.timedOut], [true, false, true]);
  assert.match(timeout.note, /no feedback/);
  const display = await call('cubase_run_command', { category: 'File', name: 'Save', waitFor: { key: 'ch.1.volume', value: '2.12', timeoutMs: 300 } });
  assert.equal(display.waitFor.reached, true, JSON.stringify(display.waitFor));

  const before = mock.state.commandsRun.length;
  assert.match((await call('cubase_run_command', { category: 'File', name: 'Save', waitFor: { key: 'ch.1.nope', changed: true } })).error, /waitFor.key.*Nothing was sent/);
  assert.match((await call('cubase_run_command', { category: 'File', name: 'Save', waitFor: { key: 'tr.cycle', value: 1, changed: true } })).error, /value or changed/);
  assert.equal(mock.state.commandsRun.length, before);

  const sequence = await call('cubase_run_command_sequence', {
    steps: [
      { category: 'File', name: 'Save', waitMs: 0, waitFor: { key: 'tr.cycle', value: 1, timeoutMs: 200 } },
      { category: 'Edit', name: 'Undo', waitMs: 0 },
    ],
  });
  assert.deepEqual([sequence.results.length, sequence.results[0].waitFor.reached, sequence.stoppedBy], [1, false, 'step 1: waitFor tr.cycle timed out']);
  const goOn = await call('cubase_run_command_sequence', {
    stopOnError: false,
    steps: [
      { category: 'File', name: 'Save', waitMs: 0, waitFor: { key: 'tr.cycle', value: 1, timeoutMs: 200 } },
      { category: 'Edit', name: 'Undo', waitMs: 0 },
    ],
  });
  assert.equal(goOn.results.length, 2);
});

test('the catalog binds the Media browsers, Shuttle, selection playback and marker helpers, and no omitted category', () => {
  const catalog = JSON.parse(readFileSync(join(root, 'build', 'commands.json'), 'utf8'));
  const bound = new Set(catalog.map((c) => `${c.category} / ${c.name}`));
  for (const name of [
    'Media / Open MediaBay',
    'Transport / Shuttle Play 1x',
    'Transport / Shuttle Play Reverse 1/8x',
    'Transport / Play from Selection Start',
    'Transport / Exchange Locator Positions',
    'Transport / Set Marker 1',
    'Transport / Nudge Cursor Right',
    'Marker / Insert Marker',
    'Zoom / Zoom Cycle Marker 1',
  ]) {
    assert.ok(bound.has(name), name);
  }
  assert.ok(catalog.length >= 630, String(catalog.length));
  assert.deepEqual(
    catalog.filter((c) => /^(Score|ADM|HeadTracking|VRPlayer|Game Audio|MediaInspector)/.test(c.category)),
    [],
  );
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`${catalog.length} comandos`));
});

test('cubase_get_plugin_parameters gives only some fields or the titles; cubase_get_channel_strip gives only some sections', async () => {
  const { call, mock } = await setupServer();
  const titles = await call('cubase_get_plugin_parameters', { channel: 'Kick', target: 'insert', slot: 1, titlesOnly: true });
  assert.deepEqual(titles.titles, ['10: Threshold', '11: Ratio', '12: Attack'], JSON.stringify(titles));
  assert.equal(titles.parameters, undefined);
  const fields = await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, fields: ['tag', 'display'] });
  assert.deepEqual(fields.parameters[0], { tag: 10, display: '-30.0', index: 0 });
  assert.deepEqual(mock.requests('da.params').at(-1).params.fields, ['tag', 'display']);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, fields: ['tag'], titlesOnly: true })).error, /fields or titlesOnly/);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, fields: ['colour'] })).error, /Invalid enum value|invalid/i);

  const strip = await call('cubase_get_channel_strip', { sections: ['eq', 'sends'] });
  assert.equal(strip.track, 'Kick');
  assert.deepEqual(strip.sections, ['eq', 'sends']);
  assert.equal(strip.eq.length, 4);
  assert.ok(Array.isArray(strip.sends));
  for (const absent of ['preFilter', 'inserts', 'strip', 'quickControls', 'volume']) assert.equal(strip[absent], undefined, absent);
  const channel = await call('cubase_get_channel_strip', { sections: ['channel', 'inserts'] });
  assert.ok(channel.volume && channel.inserts.length >= 1 && 'instrument' in channel, JSON.stringify(channel));
  assert.equal(channel.eq, undefined);
  const before = mock.requests('plugins.selected').length;
  await call('cubase_get_channel_strip', { sections: ['pre'] });
  assert.equal(mock.requests('plugins.selected').length, before);
});

test('raw keys by channel name resolve on any bank page and put the bank back; ch.<name> is an error that says how to write it', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  const read = await call('cubase_get_raw_values', {
    keys: ['ch.0.volume', 'ch[G L Clean].volume', { channel: 'Trompeta', field: 'mute' }, 'ch[G L#2].volume', 'ch[Kick].volume', 'ch[Doubler Vox].nope', 'ch.99.nope'],
  });
  assert.ok(read['ch.0.volume'].d);
  assert.deepEqual([read['ch[G L Clean].volume'].resolvedKey, read['ch[G L Clean].volume'].channel.title], ['ch.41.volume', 'G L Clean'], JSON.stringify(read));
  assert.deepEqual([read['ch[Trompeta].mute'].resolvedKey, read['ch[Trompeta].mute'].channel.page], ['ch.12.mute', 2]);
  assert.equal(read['ch[G L#2].volume'].channel.index, 37);
  assert.match(read['ch[Kick].volume'].error, /not found/);
  assert.match(read['ch[Doubler Vox].nope'].error, /"nope" is not a field/);
  assert.deepEqual(read.unknownKeys, ['ch.99.nope']);
  assert.equal(mock.state.bankOffset, 0);

  assert.match((await call('cubase_get_raw_values', { keys: ['ch.G L Clean.volume'] })).error, /Write "ch\[G L Clean\]\.volume"/);
  assert.match((await call('cubase_set_raw_value', { key: 'ch.Trompeta.volume', value: 0.3 })).error, /ch\[Trompeta\]\.volume/);
  assert.match((await call('cubase_set_raw_value', { key: 'ch.0.nope', value: 0.3 })).error, /nothing was written/);

  const written = await call('cubase_set_raw_value', { key: 'ch[Trompeta].volume', value: 0.3 });
  assert.deepEqual([written.resolvedKey, written.channel.title, written.v], ['ch.12.volume', 'Trompeta', 0.3], JSON.stringify(written));
  assert.equal(mock.state.project[60].values.get('mValue.mVolume'), 0.3);
  const object = await call('cubase_set_raw_value', { key: { channel: { name: 'G L', occurrence: 2 }, field: 'volume' }, value: 0.4 });
  assert.equal(object.resolvedKey, 'ch.37.volume');
  assert.equal(mock.state.project[37].values.get('mValue.mVolume'), 0.4);
  assert.equal(mock.state.bankOffset, 0);
});

test('cubase_get_script_log filters the requests by count, method and server', async () => {
  const { call, bridge, client } = await setupServer();
  for (let i = 0; i < 5; i++) await client.ping();
  const last = await call('cubase_get_script_log', { requests: true, requestCount: 3 });
  assert.equal(last.requests.length, 3);
  assert.ok(last.oldestId <= last.requests[0].id);
  assert.ok(last.requestsKept >= 6);
  const pings = await call('cubase_get_script_log', { requests: true, method: 'ping', requestCount: 50 });
  assert.ok(pings.requests.length >= 5 && pings.requests.every((r) => r.method === 'ping'), JSON.stringify(pings.requests));
  const mine = await call('cubase_get_script_log', { requests: true, onlyThisServer: true, requestCount: 50 });
  assert.ok(mine.requests.every((r) => r.fromThisServer && r.session === bridge.session));
  // Defaults: 20 requests at most.
  for (let i = 0; i < 25; i++) await client.ping();
  assert.equal((await call('cubase_get_script_log', { requests: true })).requests.length, 20);
});
