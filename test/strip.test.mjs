/**
 * Channel strip, plugins, DirectAccess and selection: empty and missing plugins, objects and tags that do not
 * exist, display texts Cubase ignores, Control Room disabled, the DirectAccess tree and search, quick controls,
 * EQ and Pre filter warnings, and what selecting a channel changes besides the selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from './helpers/session.mjs';
import { staleSelectionMessage } from '../dist/cubase/client.js';

const QC0 = 'host.mTrackSelection.mMixerChannel.mQuickControls[0]';
const FQC0 = 'host.mFocusedQuickControls[0]';
const writesTo = (mock, key) => mock.requests('value.set').filter((r) => r.params.key === key);

test('objects and tags that do not exist are errors, not empty successes', async () => {
  const { call, client } = await setupServer();
  assert.match((await call('cubase_da_tree', { scope: 'mixconsole', objectId: 99999999 })).error, /object 99999999 does not exist/);
  assert.match((await call('cubase_da_get_parameters', { scope: 'mixconsole', objectId: 99999999 })).error, /does not exist/);
  assert.match((await call('cubase_da_set_parameter', { scope: 'mixconsole', objectId: 99999999, tag: 0, normalized: 0.5 })).error, /does not exist/);
  assert.match((await call('cubase_set_plugin_parameter', { channel: 'Kick', target: 'insert', slot: 1, tag: 999999, normalized: 0.5 })).error, /tag 999999 does not exist/);
  // A tag outside the indexed list that Cubase answers (the channel name, 1024) is accepted.
  const name = await client.call('da.getParam', { scope: 'selected', tag: 1024 });
  assert.equal(name.parameter.display, 'Kick');
  // Counts never come out negative.
  const tree = await call('cubase_da_tree', { scope: 'selected', maxDepth: 1 });
  assert.ok(tree.root.children.every((c) => c.paramCount >= 0 && c.childCount >= 0));
});

test('a display text Cubase ignores is reported as not applied', async () => {
  const { call, mock } = await setupServer();
  const compressor = () => mock.state.directParams['host.mTrackSelection.mMixerChannel.mInsertAndStripEffects.mStripEffects.mCompressor'];
  const before = compressor()[10].value;
  const ignored = await call('cubase_set_plugin_parameter', { channel: 'Kick', target: 'strip', module: 'compressor', parameter: 'Threshold', display: 'abc' });
  assert.match(ignored.error, /ignored the display text "abc".*still shows "-30.0 dB"/);
  assert.equal(compressor()[10].value, before);
  const ok = await call('cubase_set_plugin_parameter', { target: 'strip', module: 'compressor', parameter: 'Threshold', display: '-12' });
  assert.deepEqual([ok.applied, ok.matches, ok.changed, ok.parameter.display, ok.before.display], [true, true, true, '-12.0', '-30.0']);
  const word = await call('cubase_set_plugin_parameter', { target: 'strip', module: 'compressor', parameter: 'Character', display: 'Punch' });
  assert.equal(word.applied, true);
  const batch = await call('cubase_set_plugin_parameters', {
    target: 'strip',
    module: 'compressor',
    items: [
      { parameter: 'Threshold', display: 'loud' },
      { parameter: 'Ratio', display: '4' },
      { tag: 12, normalized: 0.5 },
    ],
  });
  // Normalized items are judged too (applied, changed, matches).
  assert.deepEqual(batch.results.map((r) => r.applied), [false, true, true]);
  assert.equal(batch.notApplied, 1);
  assert.match((await call('cubase_da_set_parameter', { scope: 'sel.strip.compressor', parameter: 'Ratio', display: 'xyz' })).error, /ignored/);
});

test('empty slots, missing plugins and tracks without instrument are flagged and their parameters refused', async () => {
  const { call, mcp } = await setupServer({
    plugins: { 'sel.ins.1': { name: 'Fortin Nameless Suite X', vendor: 'Steinberg Media Technologies', missing: true }, 'sel.strip.gate': null },
  });
  const missing = await call('cubase_get_plugin_parameters', { channel: 'Kick', target: 'insert', slot: 2 });
  assert.match(missing.error, /"Fortin Nameless Suite X" in the insert slot 2 of "Kick" is not loaded/);
  assert.match((await call('cubase_set_plugin_parameter', { target: 'insert', slot: 2, tag: 4096, normalized: 0 })).error, /not loaded/);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 3 })).error, /insert slot 3 of "Kick" is empty/);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'instrument' })).error, /"Kick" has no instrument/);
  // The slot's own controls stay reachable on purpose.
  const slot = await call('cubase_da_get_parameters', { scope: 'sel.ins.1', resolvePlugin: false });
  assert.equal(slot.parameters[2].display, '!!! Fortin Nameless Suite X !!!');
  assert.match((await call('cubase_set_strip_module', { module: 'gate', on: true })).error, /gate module of "Kick" is empty/);

  const list = await call('cubase_list_inserts');
  assert.deepEqual(list.inserts.map((i) => [i.slot, i.plugin]), [
    [1, 'Compressor'],
    [2, 'Fortin Nameless Suite X'],
  ]);
  assert.deepEqual(list.inserts[0], { slot: 1, plugin: 'Compressor', vendor: 'Steinberg Media Technologies', on: false, bypass: false, editorOpen: false });
  // Cubase reports its own vendor for a missing plugin: left out.
  assert.deepEqual([list.inserts[1].missing, 'vendor' in list.inserts[1]], [true, false]);
  assert.match(list.missingNote, /not installed/);
  assert.equal(list.instrument, null);
  assert.equal(list.strip.gate.plugin, null);
  assert.equal((await call('cubase_list_inserts', { includeEmpty: true })).inserts.length, 16);
  const strip = await call('cubase_get_channel_strip');
  assert.deepEqual(strip.inserts.map((i) => i.plugin), ['Compressor', 'Fortin Nameless Suite X']);
  assert.equal(strip.inserts[1].missing, true);
  // These tools select the channel they are given: not read-only.
  const { tools } = await mcp.listTools();
  for (const name of ['cubase_get_channel_strip', 'cubase_list_inserts', 'cubase_get_plugin_parameters']) {
    assert.equal(tools.find((t) => t.name === name).annotations.readOnlyHint, false, name);
  }
});

test('Control Room disabled is detected for reads, writes and its DirectAccess scope', async () => {
  const disabled = await setupServer({ controlRoom: false });
  assert.match((await disabled.call('cubase_control_room')).error, /Control Room is disabled/);
  assert.match((await disabled.call('cubase_control_room', { mute: true })).error, /disabled/);
  assert.deepEqual(disabled.mock.requests('value.set'), []);
  assert.match((await disabled.call('cubase_da_tree', { scope: 'controlroom', maxDepth: 2 })).error, /Control Room is disabled.*MixConsole root/);
  assert.match((await disabled.call('cubase_da_get_parameters', { scope: 'controlroom', resolvePlugin: false })).error, /Control Room is disabled/);
  assert.match((await disabled.call('cubase_da_set_parameter', { scope: 'controlroom', objectId: 27, tag: 4096, normalized: 1 })).error, /Control Room is disabled/);
  assert.equal((await disabled.client.capabilities()).controlRoomActive, false);

  const enabled = await setupServer();
  const read = await enabled.call('cubase_control_room');
  assert.equal(read.values['cr.main.mute'], false);
  assert.equal(enabled.mock.requests('state.controlRoom').length, 1);
  const muted = await enabled.call('cubase_control_room', { mute: true, level: 0.4 });
  assert.deepEqual([muted.changes.mute.state, muted.changes.mute.applied, muted.changes.level.v], [true, 'confirmed', 0.4]);
  assert.equal(muted.values['cr.main.mute'], true);
  assert.equal((await enabled.call('cubase_da_tree', { scope: 'controlroom', maxDepth: 0 })).root.title, 'Control Room');
});

test('cubase_da_tree honours maxDepth 0 and maps DirectAccess channel numbers to bank indexes', async () => {
  const { call } = await setupServer();
  await call('cubase_focus_channel', { channel: 'Snare' });
  const alone = await call('cubase_da_tree', { scope: 'selected', maxDepth: 0 });
  assert.deepEqual([alone.root.title, alone.root.children, alone.root.childCount, alone.truncated], ['Snare', undefined, 2, false]);
  const tree = await call('cubase_da_tree', { scope: 'mixconsole', maxDepth: 1 });
  const out = tree.root.children.find((c) => c.title === 'Stereo Out');
  assert.deepEqual([out.mixerChannelIndex, out.bankIndex], [-1, 5]);
});

test('cubase_da_find searches breadth first past the old 3000-node budget and reports its limits', async () => {
  const tracks = Array.from({ length: 60 }, (_, i) => `Track ${i}`);
  // Past channel ~40, where the old depth-first search ran out of nodes.
  tracks[47] = 'G L Clean';
  // 74 nodes per channel, like Cubase: the channel, Input Filter, EQ and 71 more.
  const { call } = await setupServer({ tracks, daNodesPerChannel: 71 });
  const found = await call('cubase_da_find', { titleContains: 'G L Clean' });
  assert.deepEqual([found.results.length, found.results[0].title, found.results[0].bankIndex, found.truncated], [1, 'G L Clean', 47, false]);
  assert.ok(found.visited > 3000, String(found.visited));
  const small = await call('cubase_da_find', { titleContains: 'G L Clean', maxNodes: 3000 });
  assert.equal(small.results.length, 1);
  const cut = await call('cubase_da_find', { titleContains: 'Node 70', maxNodes: 100 });
  assert.deepEqual([cut.truncated, cut.visited], [true, 100]);
  const capped = await call('cubase_da_find', { titleContains: 'Input Filter', maxResults: 3 });
  assert.deepEqual([capped.results.length, capped.maxResultsReached], [3, true]);
  const under = await call('cubase_da_find', { titleContains: 'EQ', objectId: found.results[0].id, maxDepth: 1 });
  assert.equal(under.results.length, 1);
});

test('scope "selected" resolves to the channel, and filters can search the child objects', async () => {
  const { call } = await setupServer();
  await call('cubase_focus_channel', { channel: 'Kick' });
  const channel = await call('cubase_da_get_parameters', { scope: 'selected' });
  assert.deepEqual([channel.object.title, channel.resolved, channel.objectId === channel.baseObjectId], ['Kick', false, true]);
  const child = await call('cubase_da_get_parameters', { scope: 'selected', resolvePlugin: true });
  assert.deepEqual([child.object.title, child.resolved], ['Input Filter', true]);
  assert.deepEqual((await call('cubase_da_get_parameters', { scope: 'selected', filter: 'gain' })).parameters, []);
  const deep = await call('cubase_da_get_parameters', { scope: 'selected', filter: 'gain', searchChildren: true });
  assert.deepEqual(deep.parameters.map((p) => [p.objectTitle, p.title]), [
    ['Input Filter', 'Gain'],
    ['EQ', 'EQ 1 Gain'],
  ]);
  assert.equal(deep.total, 2);
  // A write by tag without resolvePlugin goes to the channel, not to its Input Filter.
  const write = await call('cubase_da_set_parameter', { scope: 'selected', parameter: 'Volume', normalized: 0.5 });
  assert.equal(write.parameter.title, 'Volume');
});

test('quick controls: nothing assigned is not written, an assigned one is verified, focused ones too', async () => {
  const { call, client, mock } = await setupServer();
  const empty = await call('cubase_set_quick_control', { channel: 'Kick', index: 1, value: 0.5 });
  assert.deepEqual([empty.track, empty.assigned, empty.written], ['Kick', false, false]);
  assert.match(empty.warning, /no parameter assigned/);
  assert.deepEqual(writesTo(mock, 'sel.qc.0'), []);
  mock.setValueTitle(QC0, 'Compressor', 'Threshold');
  const set = await call('cubase_set_quick_control', { index: 1, value: 0.5 });
  assert.deepEqual([set.track, set.assigned, set.parameter, set.owner, set.verified, set.state.v], ['Kick', true, 'Threshold', 'Compressor', true, 0.5]);

  // An unassigned focused quick control reports the previous write back (one write behind).
  const echo = await client.writeAndRead('fqc.0', 0.5);
  assert.equal(echo.v, 0);
  const focusedEmpty = await call('cubase_set_quick_control', { index: 1, value: 0.3, focused: true });
  assert.deepEqual([focusedEmpty.assigned, focusedEmpty.written], [false, false]);
  assert.equal(writesTo(mock, 'fqc.0').length, 1);
  mock.setValueTitle(FQC0, 'Frequency', 'Band 1 Freq');
  const focused = await call('cubase_set_quick_control', { index: 1, value: 0.3, focused: true });
  assert.deepEqual([focused.assigned, focused.parameter, focused.verified], [true, 'Band 1 Freq', true]);
  assert.match((await call('cubase_set_quick_control', { index: 1, value: 0.3, focused: true, disarm: true })).error, /not both/);
});

test('Pre filter slopes in dB/Oct, rounded steps, and warnings for cuts that are off', async () => {
  const { call, mock } = await setupServer();
  const db = await call('cubase_set_prefilter', { channel: 'Kick', lowCutSlopeDb: 12, highCutSlope: 0.6 });
  assert.deepEqual([db.lowCutSlope.v, db.lowCutSlope.dbPerOct, db.highCutSlope.v, db.highCutSlope.dbPerOct], [0.25, 12, 0.5, 24]);
  assert.match(db.warning, /low cut is off.*high cut is off/);
  assert.match((await call('cubase_set_prefilter', { lowCutSlope: 0.5, lowCutSlopeDb: 24 })).error, /only one of lowCutSlope, lowCutSlopeDb/);
  const on = await call('cubase_set_prefilter', { lowCutOn: true, lowCutHz: 80 });
  assert.equal(on.warning, undefined);
  // Gain, phase and low cut go through the bank: the channel is not selected.
  const selectedBefore = mock.state.selectedIndex;
  const bank = await call('cubase_set_prefilter', { channel: 'Snare', gainDb: -6, lowCutHz: 100 });
  assert.deepEqual([bank.track, bank.selected, bank.gain.withinTolerance], ['Snare', false, true]);
  assert.match(bank.warning, /low cut is off/);
  assert.equal(mock.state.selectedIndex, selectedBefore);
});

test('EQ values written to a band that is off say so', async () => {
  const { call } = await setupServer();
  const off = await call('cubase_set_eq_band', { channel: 'Kick', band: 2, gainDb: 3 });
  assert.equal(off.bandOn, false);
  assert.match(off.warning, /Band 2 is off/);
  const on = await call('cubase_set_eq_band', { band: 2, gainDb: 3, on: true });
  assert.deepEqual([on.bandOn, on.warning], [true, undefined]);
});

test('a stale selection names the channel the sel.* values still belong to', async () => {
  const { call, mock } = await setupServer();
  await call('cubase_focus_channel', { channel: 'Lead Vox' });
  mock.selectTrackWithoutMixerChannel();
  const strip = await call('cubase_get_channel_strip');
  assert.match(strip.error, /still points at "Lead Vox"/);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1 })).error, /still points at "Lead Vox"/);
  assert.match(staleSelectionMessage({ title: '', values: {} }), /is not bound to any channel/);
});

test('cubase_select_track says when the selection did not move', async () => {
  const { call } = await setupServer({ selectionTimeoutMs: 400 });
  await call('cubase_focus_channel', { channel: 'Stereo Out' });
  const end = await call('cubase_select_track', { direction: 'next' });
  assert.deepEqual([end.previous, end.selected, end.changed, end.moved], ['Stereo Out', 'Stereo Out', false, false]);
  assert.match(end.note, /last track/);
  const back = await call('cubase_select_track', { direction: 'prev' });
  assert.deepEqual([back.previous, back.selected, back.changed, back.moved, back.note], ['Stereo Out', 'Lead Vox', true, true, undefined]);
});

test('selecting reports the previous selection and the record arm, and can disarm and restore', async () => {
  const { call, mock } = await setupServer({ recordFollowsSelection: true });
  const record = (i) => mock.state.project[i].values.get('mValue.mRecordEnable');
  await call('cubase_focus_channel', { channel: 'Kick' });
  const eq = await call('cubase_set_eq_band', { channel: 'Snare', band: 1, gainDb: 2 });
  assert.deepEqual(eq.sideEffects, { previousSelection: 'Kick', selectionChanged: true, recordEnabled: true, armedBySelection: true });
  // Already selected: not selected (nor armed) again.
  const writes = writesTo(mock, 'ch.1.selected').length;
  const again = await call('cubase_get_channel_strip', { channel: 'Snare' });
  assert.deepEqual([again.sideEffects.selectionChanged, again.sideEffects.armedBySelection], [false, false]);
  assert.equal(writesTo(mock, 'ch.1.selected').length, writes);

  const disarmed = await call('cubase_list_inserts', { channel: 'Bass DI', disarm: true });
  assert.deepEqual([disarmed.sideEffects.armedBySelection, disarmed.sideEffects.disarmed, disarmed.sideEffects.recordEnabled], [true, 'confirmed', false]);
  assert.equal(record(2), 0);

  const restored = await call('cubase_get_plugin_parameters', { channel: 'Lead Vox', target: 'insert', slot: 1, restoreSelection: true });
  // Selecting Bass DI again arms it: it was disarmed before, so the restore disarms it (as live on 15 Oct 2026).
  assert.deepEqual(restored.sideEffects.restoredSelection, { channel: 'Bass DI', applied: 'confirmed', disarmed: 'confirmed' });
  assert.equal(mock.state.selectedIndex, 2);
  assert.equal(record(2), 0);
  assert.equal(record(4), 0);
  assert.match((await call('cubase_get_channel_strip', { disarm: true })).error, /only apply with "channel"/);
});

test('rename refuses blank names, and descriptions warn about openEditor and hidden editor windows', async () => {
  const { call, mcp, mock } = await setupServer();
  assert.match((await call('cubase_rename_channel', { channel: 'Kick', name: '   ' })).error, /Invalid arguments|too_small|at least 1/);
  assert.equal(mock.state.selectedIndex, -1);
  const { tools } = await mcp.listTools();
  for (const name of ['cubase_set_channel_state', 'cubase_set_insert', 'cubase_set_strip_module']) {
    const { description } = tools.find((t) => t.name === name);
    assert.match(description, /record-arms/, name);
    assert.match(description, /editorOpen in cubase_get_channel_strip/, name);
  }
});
