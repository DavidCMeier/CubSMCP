/**
 * Options added after testing every option against Cubase 13 (channel strip and plugins): the verdict of normalized
 * plugin writes, EQ types by name and the full Q range, valueInUnits in batches, reads by tag, exact and regex
 * title matches (and the ambiguity error), matchedTotal, select_track jumps, the focused quick controls and
 * explicit empty flags.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from './helpers/session.mjs';
import { EQ_TYPE_NAMES } from './helpers/mockCubase.mjs';

const STRIP_COMPRESSOR = 'host.mTrackSelection.mMixerChannel.mInsertAndStripEffects.mStripEffects.mCompressor';
const INSERT_1 = 'host.mTrackSelection.mMixerChannel.mInsertAndStripEffects.viewer(MCP Insert 0)';
const EQ_TYPE = (band) => `host.mTrackSelection.mMixerChannel.mChannelEQ.mBand${band}.mFilterType`;

test('normalized plugin writes report before, changed, matches and applied, and a write Cubase ignores is flagged', async () => {
  const { call, mock } = await setupServer();
  const ratio = await call('cubase_set_plugin_parameter', { channel: 'Kick', target: 'insert', slot: 1, parameter: 'Ratio', normalized: 0.5 });
  assert.deepEqual([ratio.applied, ratio.changed, ratio.matches, ratio.before.value, ratio.parameter.value, ratio.requested], [true, true, true, 0.2, 0.5, 0.5], JSON.stringify(ratio));
  assert.equal(ratio.warning, undefined);
  const same = await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, tag: 11, normalized: 0.5 });
  assert.deepEqual([same.applied, same.changed, same.matches], [true, false, true]);

  // A read-only parameter (a gain reduction meter) ignores the write.
  const meter = await call('cubase_set_plugin_parameter', { target: 'strip', module: 'compressor', parameter: 'GR', normalized: 0.7 });
  assert.deepEqual([meter.applied, meter.changed, meter.matches], [false, false, false]);
  assert.match(meter.warning, /did not take 0.7: "GR" still shows "-?0.0 dB"/);

  const batch = await call('cubase_set_plugin_parameters', {
    target: 'strip',
    module: 'compressor',
    items: [
      { tag: 10, normalized: 0.25 },
      { parameter: 'GR', normalized: 0.5 },
    ],
  });
  assert.deepEqual(batch.results.map((r) => [r.applied, r.changed, r.before.value]), [
    [true, true, 0.5],
    [false, false, 0],
  ]);
  assert.equal(batch.notApplied, 1);
  assert.equal(mock.state.directParams[STRIP_COMPRESSOR][10].value, 0.25);

  // The channel output ignores writes (Cubase 13): da_set_parameter says so too.
  const output = await call('cubase_da_set_parameter', { scope: 'selected', tag: 4102, normalized: 0.3 });
  assert.equal(output.applied, false, JSON.stringify(output));
});

test('cubase_set_eq_band takes the type by name, checks it against the display and lists the types', async () => {
  const { call, mock } = await setupServer();
  const listed = await call('cubase_set_eq_band', { band: 1, listTypes: true });
  assert.deepEqual(listed.types, EQ_TYPE_NAMES[1]);
  assert.equal(mock.requests('value.set').length, 0);
  assert.equal(mock.state.selectedIndex, -1);

  const hp = await call('cubase_set_eq_band', { channel: 'Kick', band: 1, type: 'high pass 2' });
  assert.deepEqual([hp.type.name, hp.type.display, hp.type.previous, hp.type.applied, hp.type.changed], ['High Pass II', 'High Pass II', 'Parametric I', true, true], JSON.stringify(hp));
  assert.ok(Math.abs(mock.state.hostValues.get(EQ_TYPE(1)).value - 3 / 7) < 1e-9);
  const mid = await call('cubase_set_eq_band', { band: 2, type: 'Parametric II', listTypes: true });
  assert.deepEqual([mid.type.display, mid.type.normalized, mid.types], ['Parametric II', 1, ['Parametric I', 'Parametric II']]);

  // An unknown name is refused before anything is selected or written.
  const writes = mock.requests('value.set').length;
  const unknown = await call('cubase_set_eq_band', { channel: 'Snare', band: 2, type: 'Low Shelf I' });
  assert.match(unknown.error, /Band 2 has no EQ type "Low Shelf I". Its types: Parametric I, Parametric II/);
  assert.equal(mock.requests('value.set').length, writes);
  assert.equal(mock.state.project[mock.state.selectedIndex].title, 'Kick');
  assert.match((await call('cubase_set_eq_band', { band: 1, type: 'Parametric I', typeNormalized: 0 })).error, /only one of type, typeNormalized/);

  // A Cubase whose list differs: the old type is put back and the call fails.
  const original = EQ_TYPE_NAMES[4][2];
  EQ_TYPE_NAMES[4][2] = 'Low Cut 12';
  try {
    const wrong = await call('cubase_set_eq_band', { band: 4, type: 'Low Pass I' });
    assert.match(wrong.error, /Cubase shows "Low Cut 12" at step 2 of band 4, not "Low Pass I".*put back to "Parametric I"/);
    assert.equal(mock.state.hostValues.get(EQ_TYPE(4)).value, 0);
  } finally {
    EQ_TYPE_NAMES[4][2] = original;
  }
});

test('the EQ Q goes down to 0, the bottom of Cubase\'s range', async () => {
  const { call } = await setupServer();
  await call('cubase_set_eq_band', { channel: 'Kick', band: 2, q: 4 });
  const zero = await call('cubase_set_eq_band', { band: 2, q: 0 });
  assert.deepEqual([zero.q.achieved, zero.q.withinTolerance], [0, true], JSON.stringify(zero.q));
  const low = await call('cubase_set_eq_band', { band: 2, q: 0.05 });
  assert.ok(Math.abs(low.q.achieved - 0.05) < 0.02 && low.q.withinTolerance, JSON.stringify(low.q));
  assert.match((await call('cubase_set_eq_band', { band: 2, q: -0.1 })).error, /greater than or equal to 0/);
});

test('cubase_set_plugin_parameters takes valueInUnits per item, in order, and a failed item does not stop the others', async () => {
  const { call, mock } = await setupServer();
  const params = () => mock.state.directParams[STRIP_COMPRESSOR];
  const batch = await call('cubase_set_plugin_parameters', {
    channel: 'Kick',
    target: 'strip',
    module: 'compressor',
    items: [
      { parameter: 'Threshold', valueInUnits: -20 },
      { tag: 11, normalized: 0.5 },
      { parameter: 'Nope', valueInUnits: 3 },
      { parameter: 'Attack', valueInUnits: 10 },
      { parameter: 'Character', valueInUnits: 2 },
    ],
  });
  const [threshold, ratio, nope, attack, character] = batch.results;
  assert.deepEqual([threshold.title, threshold.requestedUnits, threshold.display, threshold.applied], ['Threshold', -20, '-20.0', true], JSON.stringify(threshold));
  assert.deepEqual([ratio.tag, ratio.applied], [11, true]);
  assert.match(nope.error, /Parameter not found: Nope/);
  assert.ok(Math.abs(attack.achieved - 10) <= 0.2 && attack.applied, JSON.stringify(attack));
  // A mode list has no units: an error, and the parameter keeps its value.
  assert.match(character.error, /display .*or normalized/);
  assert.equal(params()[14].value, 0);
  assert.equal(batch.failed, 2);
  assert.equal(params()[11].value, 0.5);
  // The normalized item went in one request of its own, between the searches.
  assert.equal(mock.requests('da.setParams').length, 1);
  assert.match((await call('cubase_set_plugin_parameters', { target: 'strip', module: 'compressor', items: [{ tag: 10, normalized: 0.5, valueInUnits: -3 }] })).error, /exactly one/);
});

test('plugin and DirectAccess parameters can be read by tag', async () => {
  const { call } = await setupServer();
  const one = await call('cubase_get_plugin_parameters', { channel: 'Kick', target: 'insert', slot: 1, tag: 11 });
  assert.deepEqual(one.parameters.map((p) => [p.tag, p.title, p.index]), [[11, 'Ratio', 1]], JSON.stringify(one));
  const two = await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, tags: [12, 10], fields: ['tag', 'display'] });
  assert.deepEqual(two.parameters, [
    { tag: 12, display: '10.1', index: 2 },
    { tag: 10, display: '-30.0', index: 0 },
  ]);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, tag: 999 })).error, /tag 999 does not exist/);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, tag: 10, filter: 'thr' })).error, /filter or tag\/tags/);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, tag: 10, tags: [11] })).error, /only one of tag, tags/);
  // A tag outside the indexed list (the channel name) has no index.
  const name = await call('cubase_da_get_parameters', { scope: 'selected', tag: 1024 });
  assert.deepEqual(name.parameters.map((p) => [p.title, p.display, p.index]), [['Name', 'Kick', null]]);
  assert.match((await call('cubase_da_get_parameters', { scope: 'selected', tags: [4096], searchChildren: true })).error, /searchChildren applies to filter/);
});

test('title filters match contains, exact or regex, count the matches, and an ambiguous title is not written', async () => {
  const { call, mock } = await setupServer();
  const contains = await call('cubase_get_plugin_parameters', { channel: 'Kick', target: 'insert', slot: 1, filter: 'at' });
  assert.deepEqual([contains.parameters.map((p) => p.title), contains.matchedTotal, contains.total], [['Ratio', 'Attack'], 2, 3]);
  const exact = await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, filter: 'ratio', match: 'exact' });
  assert.deepEqual([exact.parameters.map((p) => p.title), exact.matchedTotal], [['Ratio'], 1]);
  const regex = await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, filter: '^(thr|att)', match: 'regex' });
  assert.deepEqual(regex.parameters.map((p) => p.title), ['Threshold', 'Attack']);
  // With a filter, offset and limit count the matches.
  const page = await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, filter: 'a', offset: 1, limit: 1 });
  assert.deepEqual([page.parameters.map((p) => p.title), page.matchedTotal], [['Attack'], 2]);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, filter: '(', match: 'regex' })).error, /Invalid regular expression "\("/);
  assert.match((await call('cubase_get_plugin_parameters', { target: 'insert', slot: 1, match: 'exact' })).error, /give a filter/);

  // Two titles contain "at": an error listing them, nothing written.
  const insert = () => mock.state.directParams[INSERT_1];
  const ambiguous = await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, parameter: 'at', normalized: 0.9 });
  assert.match(ambiguous.error, /"at" matches 2 parameters: "Ratio" \(tag 11\), "Attack" \(tag 12\)\. Give the whole title/);
  assert.deepEqual([insert()[11].value, insert()[12].value], [0.2, 0.1]);
  const seek = await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, parameter: 'at', valueInUnits: 5 });
  assert.match(seek.error, /matches 2 parameters/);
  // The search failed on its first read: only the refused write above reached the script, and nothing moved.
  assert.equal(mock.requests('da.setParam').length, 1);
  assert.deepEqual([insert()[11].value, insert()[12].value], [0.2, 0.1]);
  // A title equal to the text wins over the ones that contain it ("Ratio" and "Ratio Mode").
  const ratio = await call('cubase_set_plugin_parameter', { target: 'strip', module: 'compressor', parameter: 'ratio', normalized: 0.4 });
  assert.equal(ratio.parameter.title, 'Ratio');
  const attack = await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, parameter: '^att', match: 'regex', normalized: 0.3 });
  assert.deepEqual([attack.parameter.title, insert()[12].value], ['Attack', 0.3]);
  assert.match((await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, tag: 12, match: 'exact', normalized: 0.3 })).error, /match only applies to parameter/);
  assert.match((await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, parameter: 'Rat', match: 'exact', normalized: 0.3 })).error, /Parameter not found: Rat \(match exact\)/);

  // DirectAccess reads and searches take the same modes.
  const deep = await call('cubase_da_get_parameters', { scope: 'selected', filter: 'gain', searchChildren: true });
  assert.deepEqual([deep.matchedTotal, deep.total], [2, 2]);
  const exactGain = await call('cubase_da_get_parameters', { scope: 'selected', filter: 'gain', match: 'exact', searchChildren: true });
  assert.deepEqual([exactGain.parameters.map((p) => p.objectTitle), exactGain.matchedTotal], [['Input Filter'], 1]);
  const flat = await call('cubase_da_get_parameters', { scope: 'selected', filter: 'u', limit: 1 });
  assert.deepEqual([flat.parameters.map((p) => p.title), flat.matchedTotal, flat.total], [['Volume'], 2, 3]);
  const kicks = await call('cubase_da_find', { titleContains: '^(kick|snare)$', match: 'regex', maxDepth: 1 });
  assert.deepEqual(kicks.results.map((r) => r.title), ['Kick', 'Snare']);
  const exactFind = await call('cubase_da_find', { titleContains: 'eq', match: 'exact', maxDepth: 2 });
  assert.equal(exactFind.results.length, 6);
  assert.ok(exactFind.results.every((r) => r.title === 'EQ'));
});

test('cubase_select_track jumps to the first or last track or to a track by name, and counts the steps', async () => {
  const { call } = await setupServer({ selectionTimeoutMs: 300 });
  await call('cubase_focus_channel', { channel: 'Snare' });
  const first = await call('cubase_select_track', { to: 'first' });
  assert.deepEqual([first.previous, first.selected, first.changed, first.reachedEnd, first.steps], ['Snare', 'Kick', true, true, 2], JSON.stringify(first));
  const last = await call('cubase_select_track', { to: 'last' });
  assert.deepEqual([last.selected, last.reachedEnd, last.steps], ['Stereo Out', true, 6]);
  // A name with a mixer channel is selected through the mixer (stepping misses tracks in collapsed folders).
  const bass = await call('cubase_select_track', { name: 'bass di' });
  assert.deepEqual([bass.selected, bass.found, bass.steps, bass.changed, bass.via], ['Bass DI', true, 0, true, 'mixer'], JSON.stringify(bass));
  const here = await call('cubase_select_track', { name: 'Bass DI' });
  assert.deepEqual([here.found, here.steps, here.changed], [true, 0, false]);
  // Stepping (direction given) that does not find the name puts the selection back where it started.
  const none = await call('cubase_select_track', { name: 'Nope', direction: 'prev' });
  assert.deepEqual([none.found, none.selected], [false, 'Bass DI'], JSON.stringify(none));
  assert.match(none.note, /No track named "Nope".*put back on "Bass DI"/);
  const capped = await call('cubase_select_track', { to: 'last', maxSteps: 2 });
  assert.deepEqual([capped.steps, capped.selected, capped.reachedEnd], [2, 'Lead Vox', null]);
  assert.match(capped.note, /maxSteps/);
  const one = await call('cubase_select_track', { direction: 'next' });
  assert.deepEqual([one.selected, one.moved, one.steps], ['Stereo Out', true, 1]);
  assert.match((await call('cubase_select_track', { to: 'first', direction: 'next' })).error, /Give to alone/);
  assert.match((await call('cubase_select_track', {})).error, /Give direction/);
});

test('cubase_get_focused_quick_controls reads the target and the quick controls that follow the focus', async () => {
  const { call, mock, mcp } = await setupServer();
  mock.setFocusedTitle('Frequency');
  mock.setValueTitle('host.mFocusedQuickControls[0]', 'Frequency', '');
  const read = await call('cubase_get_focused_quick_controls');
  assert.equal(read.target, 'Frequency', JSON.stringify(read));
  assert.equal(read.quickControls.length, 8);
  assert.deepEqual(
    [read.quickControls[0].index, read.quickControls[0].assigned, read.quickControls[0].owner, read.quickControls[0].parameter],
    [1, true, 'Frequency', null],
  );
  assert.equal(read.quickControls[1].assigned, false);
  assert.match(read.note, /only the owner/);
  assert.ok('locked' in read);
  const { tools } = await mcp.listTools();
  assert.equal(tools.find((t) => t.name === 'cubase_get_focused_quick_controls').annotations.readOnlyHint, true);
});

test('empty insert slots and strip modules say empty: true where they are listed', async () => {
  const { call } = await setupServer({ plugins: { 'sel.strip.gate': null } });
  const list = await call('cubase_list_inserts', { channel: 'Kick', includeEmpty: true });
  assert.deepEqual([list.inserts[0].plugin, 'empty' in list.inserts[0], list.inserts[1].plugin, list.inserts[1].empty], ['Compressor', false, null, true]);
  assert.deepEqual([list.strip.gate.empty, 'empty' in list.strip.compressor], [true, false]);
  const strip = await call('cubase_get_channel_strip', { sections: ['strip'] });
  assert.equal(strip.strip.gate.empty, true);
});
