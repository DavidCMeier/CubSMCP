import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bigProject, setupServer } from './helpers/session.mjs';

/** Every object in a JSON schema, nested ones included. */
function objectSchemas(schema, path = '$', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.type === 'object' || schema.properties) out.push({ path, schema });
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) value.forEach((v, i) => objectSchemas(v, `${path}.${key}[${i}]`, out));
    else if (value && typeof value === 'object') objectSchemas(value, `${path}.${key}`, out);
  }
  return out;
}

test('every tool schema rejects unknown keys, nested objects included', async () => {
  const { mcp, call } = await setupServer();
  const { tools } = await mcp.listTools();
  assert.ok(tools.length > 50);
  const open = [];
  for (const tool of tools) {
    for (const { path, schema } of objectSchemas(tool.inputSchema)) {
      if (path.includes('.properties.') && !schema.properties) continue; // a property named like a keyword
      if (schema.additionalProperties !== false) open.push(`${tool.name} ${path}`);
    }
  }
  assert.deepEqual(open, []);
  // And validation enforces it: a typo is an error, not an empty success.
  const typo = await call('cubase_set_channel_state', { channel: 0, bypass: true });
  assert.match(typo.error, /Unrecognized key/);
  const nested = await call('cubase_apply_mix', { changes: [{ channel: 0, volumeDb: -6, colour: 'red' }] });
  assert.match(nested.error, /Unrecognized key/);
  const noArgs = await call('cubase_get_meters', { channel: 43 });
  assert.match(noArgs.error, /Unrecognized key/);
  const item = await call('cubase_set_plugin_parameters', { target: 'insert', slot: 1, items: [{ parameter: 'EQ1Thresh', value: 0.5 }] });
  assert.match(item.error, /Unrecognized key/);
});

test('blank channel names and blank command names are rejected', async () => {
  const { call, mock } = await setupServer();
  for (const channel of [' ', '\t', '']) {
    const result = await call('cubase_get_channel', { channel });
    assert.ok(result.error, JSON.stringify(result));
  }
  assert.ok((await call('cubase_focus_channel', { channel: ' ' })).error);
  assert.ok((await call('cubase_gain_stage', { excludeNames: [''] })).error);
  assert.equal(mock.state.selectedIndex, -1);
  const blank = await call('cubase_run_command', { category: '', name: '' });
  assert.match(blank.error, /Invalid arguments/);
  assert.ok((await call('cubase_run_command_sequence', { steps: [{ category: 'File', name: ' ' }] })).error);
  // What clients send for 37.5 or -1 once their schema turned it into text.
  const coerced = await call('cubase_get_channel', { channel: '37.5' });
  assert.match(coerced.error, /not a valid bank index/);
  const digits = await call('cubase_get_channel', { channel: '4' });
  assert.equal(digits.name, 'Lead Vox');
});

test('contradictory or empty arguments fail before anything is written', async () => {
  const { call, mock } = await setupServer();
  const writes = () => [...mock.state.hostValues.values()].map((r) => r.value).join();
  const before = writes();
  assert.match((await call('cubase_set_send', { channel: 0, slot: 1, levelDb: -8, normalized: 0.9, on: true })).error, /only one of levelDb, normalized/);
  assert.match((await call('cubase_set_volume', { channel: 0, volumeDb: -6, normalized: 0.5 })).error, /only one of volumeDb, normalized/);
  assert.match((await call('cubase_set_volume', { channel: 0 })).error, /Give one of volumeDb, normalized/);
  assert.match((await call('cubase_set_quick_control', { channel: 3, index: 1, value: 0.5, focused: true })).error, /not both/);
  assert.match((await call('cubase_set_channel_state', { channel: 0 })).error, /Nothing to change/);
  assert.match((await call('cubase_set_prefilter', { channel: 'Kick' })).error, /Nothing to change/);
  assert.match(
    (await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, parameter: 'Ratio', tag: 11, normalized: 0.5 })).error,
    /only one of parameter, tag/,
  );
  assert.match((await call('cubase_set_plugin_parameter', { target: 'insert', slot: 1, parameter: 'Ratio', display: '2', normalized: 0.5 })).error, /only one of/);
  assert.match((await call('cubase_set_plugin_parameter', { target: 'insert', module: 'gate', slot: 1, parameter: 'Ratio', normalized: 0.5 })).error, /module only applies/);
  assert.match((await call('cubase_set_plugin_parameters', { target: 'insert', slot: 1, items: [{ parameter: 'Threshold' }] })).error, /normalized, display or valueInUnits/);
  assert.equal(writes(), before);
  assert.equal(mock.state.selectedIndex, -1);
});

test('channel tools say which channel they acted on', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  const volume = await call('cubase_set_volume', { channel: 'G L#2', normalized: 0.5 });
  assert.deepEqual([volume.channel, volume.index, volume.position, volume.page, volume.uid, volume.matchedBy], ['G L', 37, 37, 1, 'uid-37-G L', 'occurrence']);
  const ambiguous = await call('cubase_set_volume', { channel: 'G L', normalized: 0.5 });
  assert.match(ambiguous.error, /"G L" \(page 1, index 35, uid uid-35-G L\), "G L" \(page 1, index 37, uid uid-37-G L\)/);
  // The exact form: {name, occurrence} instead of "G L#2", and no prefix fallback.
  const exact = await call('cubase_set_volume', { channel: { name: 'G L', occurrence: 2 }, normalized: 0.5 });
  assert.deepEqual([exact.index, exact.uid, exact.matchedBy], [37, 'uid-37-G L', 'occurrence']);
  assert.match((await call('cubase_get_channel', { channel: { name: 'Trompe' } })).error, /No channel is named exactly "Trompe"/);
  assert.equal((await call('cubase_get_channel', { channel: { name: 'Trompe', exact: false } })).name, 'Trompeta');
  assert.match((await call('cubase_get_channel', { channel: { name: 'Trompeta', colour: 1 } })).error, /Unrecognized key/);
  const channel = await call('cubase_get_channel', { channel: 'Trompeta' });
  assert.deepEqual([channel.name, channel.index, channel.position, channel.page], ['Trompeta', 12, 60, 2]);
  assert.equal(mock.state.bankOffset, 0);
  const strip = await call('cubase_get_channel_strip', { channel: 'Doubler' });
  assert.deepEqual([strip.track, strip.channel.index, strip.channel.position], ['Doubler', 40, 136]);
  // An index on an empty slot is an error, not a channel called "".
  const small = await setupServer();
  assert.match((await small.call('cubase_set_volume', { channel: 43, normalized: 0.5 })).error, /Bank slot 43 is empty/);
});

test('cubase_apply_mix pins indexes to the starting page and puts the bank back', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  await call('cubase_bank', { action: 'reset' });
  await call('cubase_bank', { action: 'next' });
  const result = await call('cubase_apply_mix', {
    changes: [
      { channel: 'Nope', mute: true },
      { channel: 2, mute: true },
      { channel: 'Trompeta', solo: true },
      { channel: 'Doubler', mute: true },
    ],
  });
  assert.equal(result.applied, 3);
  assert.match(result.results[0].error, /not found/);
  assert.deepEqual(
    result.results.slice(1).map((r) => [r.channel, r.position]),
    [
      ['Track 050', 50],
      ['Trompeta', 60],
      ['Doubler', 136],
    ],
  );
  assert.equal(mock.state.project[50].values.get('mValue.mMute'), 1);
  assert.equal(mock.state.project[136].values.get('mValue.mMute'), 1);
  assert.equal(mock.state.bankOffset, 48);
  assert.equal(result.bankWarning, undefined);
});

test('cubase_bank reports where the bank landed', async () => {
  const { call } = await setupServer({ tracks: bigProject() });
  await call('cubase_bank', { action: 'reset' });
  await call('cubase_bank', { action: 'next' });
  const last = await call('cubase_bank', { action: 'next' });
  assert.deepEqual([last.moved, last.count, last.atEnd, last.position, last.channels[0].name], [true, 41, true, 96, 'Track 096']);
  const none = await call('cubase_bank', { action: 'next' });
  assert.deepEqual([none.sent, none.moved], [false, false]);
  assert.match(none.note, /last bank page/);
  const list = await call('cubase_list_channels', { includeValues: false });
  assert.equal(list.bankPosition, 96);
});

test('snapshots return to a shifted bank and restores name repeated and missing channels the same way', async () => {
  const { call, mock, ctx } = await setupServer({ tracks: bigProject() });
  await call('cubase_bank', { action: 'shiftRight' });
  const saved = await call('cubase_snapshot_mix', { name: 'shifted' });
  assert.deepEqual([saved.channels, saved.pages, saved.bankRestored], [137, 3, true]);
  assert.match(saved.note, /followVisibility/);
  assert.equal(mock.state.bankOffset, 1);
  // A saved channel that is gone, with a repeated name.
  const file = join(ctx.config.snapshotDir, 'shifted.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  snapshot.channels.push({ uid: 'gone', name: 'G L', occurrence: 3, values: { volume: 0.5 } });
  snapshot.channels[37].values.volume = 0.3; // the second "G L"
  writeFileSync(file, JSON.stringify(snapshot));
  const restored = await call('cubase_restore_mix', { snapshot: 'shifted' });
  assert.equal(restored.bankRestored, true);
  assert.equal(mock.state.bankOffset, 1);
  assert.deepEqual(restored.unmatched, ['G L#3']);
  assert.match(restored.unmatchedNote, /hidden in the MixConsole/);
  const second = restored.results.find((r) => r.uid === 'uid-37-G L');
  assert.deepEqual([second.channel, second.index, second.page, second.changed], ['G L#2', 37, 1, ['volume']]);
});
