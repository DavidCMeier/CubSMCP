import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bigProject, setupServer } from './helpers/session.mjs';

const real = (mock, i, field) => mock.state.project[i].values.get(`mValue.m${field}`) ?? 0;

test('hidden channels are counted, and cubase_bank showAll shows them and checks it', async () => {
  // Like Cubase 13 live: hidden channels stay out of the bank although the script asks it not to follow visibility.
  const { call, mock } = await setupServer({ tracks: bigProject(), hidden: [1, 2, 3], hiddenOutOfBank: true });
  const list = await call('cubase_list_channels', { includeValues: false });
  assert.equal(list.hidden, 3);
  assert.deepEqual(list.hiddenChannels, ['Track 001', 'Track 002', 'Track 003']);
  assert.match(list.hiddenNote, /cubase_bank action showAll/);
  assert.equal(list.channels[1].name, 'Track 004');
  // Hidden channels are not found by name.
  assert.match((await call('cubase_get_channel', { channel: 'Track 002' })).error, /not found/);
  const moved = await call('cubase_bank', { action: 'next' });
  assert.equal(moved.hidden, 3);

  const shown = await call('cubase_bank', { action: 'showAll' });
  assert.deepEqual([shown.hiddenBefore, shown.hiddenAfter, shown.verified], [3, 0, true], JSON.stringify(shown));
  assert.deepEqual(shown.shown, ['Track 001', 'Track 002', 'Track 003']);
  assert.match(shown.note, /bank indexes changed/);
  assert.deepEqual(mock.state.commandsRun.at(-1), ['Channel & Track Visibility', 'ShowAll']);
  await call('cubase_bank', { action: 'reset' });
  const after = await call('cubase_list_channels', { includeValues: false });
  assert.deepEqual([after.hidden, after.hiddenChannels, after.channels[1].name], [0, undefined, 'Track 001']);
  assert.equal((await call('cubase_get_channel', { channel: 'Track 002' })).index, 2);
  assert.deepEqual(mock.state.crashingCalls, []);
});

test('showAll says so when Cubase leaves channels hidden', async () => {
  const { call, mock } = await setupServer({ hidden: [1], hiddenOutOfBank: true });
  mock.state.showAllIgnored = true;
  const shown = await call('cubase_bank', { action: 'showAll' });
  assert.deepEqual([shown.hiddenBefore, shown.hiddenAfter, shown.verified, shown.hidden], [1, 1, false, 1]);
  assert.match(shown.note, /still reports 1 hidden channel/);
  assert.match((await call('cubase_bank', { action: 'showAll', page: 2 })).error, /page only applies to goToPage/);
});

test('cubase_bank goes to a page or to a channel and says where it is', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  const reset = await call('cubase_bank', { action: 'reset' });
  assert.deepEqual([reset.atStart, reset.page, reset.position], [true, 1, 0]);
  const third = await call('cubase_bank', { action: 'goToPage', page: 3 });
  assert.deepEqual([third.position, third.page, third.pages, third.count, third.atEnd, third.atStart], [96, 3, 3, 41, true, false]);
  assert.equal(mock.state.bankOffset, 96);
  const second = await call('cubase_bank', { action: 'goToPage', page: 2 });
  assert.deepEqual([second.position, second.page, second.first.name], [48, 2, 'Track 048']);
  // A page past the last one is an error and the bank stays.
  assert.match((await call('cubase_bank', { action: 'goToPage', page: 4 })).error, /has 3 pages of 48 channels: there is no page 4/);
  assert.equal(mock.state.bankOffset, 48);
  assert.match((await call('cubase_bank', { action: 'goToPage' })).error, /goToPage needs page/);
  const first = await call('cubase_bank', { action: 'goToPage', page: 1 });
  assert.deepEqual([first.position, first.atStart, mock.state.bankOffset], [0, true, 0]);

  const trompeta = await call('cubase_bank', { action: 'showChannel', channel: 'Trompeta' });
  assert.deepEqual([trompeta.moved, trompeta.position, trompeta.page, trompeta.channel.index, trompeta.channel.channel], [true, 48, 2, 12, 'Trompeta']);
  // Unlike other tools, the bank stays there: indexes now refer to page 2.
  assert.equal(mock.state.bankOffset, 48);
  assert.equal((await call('cubase_get_channel', { channel: 12 })).name, 'Trompeta');
  const here = await call('cubase_bank', { action: 'showChannel', channel: { name: 'Trompeta' } });
  assert.deepEqual([here.moved, here.channel.index], [false, 12]);
  assert.match(here.note, /already has this channel/);
  assert.match((await call('cubase_bank', { action: 'showChannel', channel: 'Nope' })).error, /not found/);
  assert.equal(mock.state.bankOffset, 48);
});

test('channel kinds in cubase_list_channels and cubase_get_meters, cached per channel', async () => {
  const { call, mock } = await setupServer({ kinds: { 'Bass DI': 'MidiChannel 3' } });
  const list = await call('cubase_list_channels', { includeValues: false });
  assert.deepEqual(
    list.channels.map((c) => [c.name, c.kind]),
    [['Kick', 'audio'], ['Snare', 'audio'], ['Bass DI', 'midi'], ['Guitarra ñ', 'audio'], ['Lead Vox', 'audio'], ['Stereo Out', 'output']],
  );
  const meters = await call('cubase_get_meters');
  assert.deepEqual([meters.channels[2].kind, meters.channels[5].kind], ['midi', 'output']);
  // Known channels are not asked for again.
  const asked = mock.requests('mixer.channels').length;
  await call('cubase_get_meters');
  assert.equal(mock.requests('mixer.channels').length, asked);
});

test('cubase_get_routing reads outputs and send destinations; writes are not offered', async () => {
  const { call, mock, mcp } = await setupServer();
  mock.setSendTitle(4, 0, '1- FX Reverb');
  mock.state.outputs.set(mock.state.project[1], 'Drums');
  const page = await call('cubase_get_routing');
  assert.equal(page.count, 6);
  assert.equal(page.outputsAvailable, true);
  assert.deepEqual(page.channels[1], { index: 1, name: 'Snare', uid: 'uid-1-Snare', kind: 'audio', output: 'Drums', sends: [] });
  assert.deepEqual(page.channels[5].output, 'Sin bus');
  const vox = await call('cubase_get_routing', { channel: 'Lead Vox' });
  assert.deepEqual([vox.channel, vox.index, vox.kind, vox.output, vox.sends], ['Lead Vox', 4, 'audio', 'Stereo Out', [{ slot: 1, destination: 'FX Reverb' }]]);
  const { tools } = await mcp.listTools();
  assert.match(tools.find((t) => t.name === 'cubase_get_routing').description, /Read-only: Cubase ignores writes to the output/);
});

test('cubase_rename_channel renames through DirectAccess without selecting, and checks the bank', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  const renamed = await call('cubase_rename_channel', { channel: 'Trompeta', name: 'Trumpet' });
  assert.deepEqual([renamed.mode, renamed.before, renamed.after, renamed.renamed, renamed.verified, renamed.uid], ['direct', 'Trompeta', 'Trumpet', true, true, 'uid-60-Trompeta']);
  assert.equal(mock.state.project[60].title, 'Trumpet');
  assert.equal(mock.state.selectedIndex, -1);
  assert.equal(mock.state.bankOffset, 0);
  assert.ok(!mock.state.commandsRun.some(([, name]) => name === 'Rename First Selected Track'));
  assert.equal((await call('cubase_get_channel', { channel: { name: 'Trumpet' } })).position, 60);

  mock.state.renameIgnored = true;
  const ignored = await call('cubase_rename_channel', { channel: 'Trumpet', name: 'Horn' });
  assert.deepEqual([ignored.renamed, ignored.verified, ignored.after], [false, false, 'Trumpet']);
  assert.match(ignored.note, /did not show "Horn"/);

  // The old way: open the field for the user.
  const field = await call('cubase_rename_channel', { channel: 'Track 005', name: 'Kick In', mode: 'field' });
  assert.deepEqual([field.mode, field.renamed], ['field', false], JSON.stringify(field));
  assert.match(field.userAction, /type "Kick In"/);
  assert.deepEqual(mock.state.commandsRun.at(-1), ['Edit', 'Rename First Selected Track']);
});

test('cubase_create_bus_for_selection names the new channel', async () => {
  const { call, mock } = await setupServer();
  await call('cubase_focus_channel', { channel: 'Lead Vox' });
  const created = await call('cubase_create_bus_for_selection', { type: 'group', name: 'Vox Bus' });
  assert.equal(created.status, 'created', JSON.stringify(created));
  assert.deepEqual(created.created.map((c) => [c.name, c.index]), [['Vox Bus', 5]]);
  assert.deepEqual([created.rename.renamed, created.rename.before], [true, 'Group 1']);
  assert.equal(mock.slotTitle(5), 'Vox Bus');
  assert.equal(mock.outputOf('Lead Vox'), 'Group 1'); // the mock routes by the name the group had
  const { tools } = await setupServer().then(({ mcp }) => mcp.listTools());
  assert.match(tools.find((t) => t.name === 'cubase_create_bus_for_selection').description, /Mono or stereo, the output and an effect plugin .* cannot be chosen/);
});

test('cubase_set_channel_state reports implied changes and can keep the selection for openEditor', async () => {
  const { call, mock } = await setupServer({ recordFollowsSelection: true });
  const write = await call('cubase_set_channel_state', { channel: 'Snare', automationWrite: true });
  assert.equal(write.sideEffects.automationReadTurnedOn, true);
  assert.equal(real(mock, 1, 'AutomationRead'), 1);
  const solo = await call('cubase_set_channel_state', { channel: 'Kick', solo: true });
  assert.match(solo.sideEffects.soloImplied, /other channels with mute on/);
  await call('cubase_set_channel_state', { channel: 'Kick', solo: false });

  assert.match((await call('cubase_set_channel_state', { channel: 'Kick', mute: true, disarm: true })).error, /only applies with openEditor: true/);
  assert.match((await call('cubase_set_channel_state', { channel: 'Kick', mute: true, restoreSelection: true })).error, /only applies with openEditor/);
  await call('cubase_focus_channel', { channel: 'Kick', disarm: true });
  assert.equal(real(mock, 0, 'RecordEnable'), 0);
  const editor = await call('cubase_set_channel_state', { channel: 'Lead Vox', openEditor: true, disarm: true, restoreSelection: true });
  assert.equal(editor.results[0].state, true, JSON.stringify(editor));
  assert.deepEqual(
    [editor.sideEffects.previousSelection, editor.sideEffects.armedBySelection, editor.sideEffects.disarmed],
    ['Kick', true, 'confirmed'],
    JSON.stringify(editor.sideEffects),
  );
  // The Channel Settings window follows the selection (live, 15 Oct 2026): it stays on Lead Vox while open.
  assert.equal(editor.sideEffects.restoredSelection, undefined);
  assert.match(editor.sideEffects.restoreSelection, /Kept "Lead Vox" selected.*select "Kick" again/);
  assert.equal(mock.state.project[mock.state.selectedIndex].title, 'Lead Vox');
  // Closing it with restoreSelection goes back to Kick, disarmed as it was.
  const closed = await call('cubase_set_channel_state', { channel: 'Lead Vox', openEditor: false, restoreSelection: true });
  assert.deepEqual(closed.sideEffects.restoredSelection, { channel: 'Kick', applied: 'confirmed', disarmed: 'confirmed' }, JSON.stringify(closed));
  assert.equal(mock.state.project[mock.state.selectedIndex].title, 'Kick');
  assert.deepEqual([real(mock, 0, 'RecordEnable'), real(mock, 4, 'RecordEnable')], [0, 0]);
  const again = await call('cubase_set_channel_state', { channel: 'Lead Vox', openEditor: false, restoreSelection: true });
  assert.match(again.sideEffects.restoredSelection.skipped, /no selection was remembered/);
});

test('cubase_apply_mix sends take preFader and normalized levels', async () => {
  const { call, client, mock } = await setupServer();
  mock.setSendTitle(0, 0, '1- FX Reverb');
  const result = await call('cubase_apply_mix', { changes: [{ channel: 'Kick', sends: [{ slot: 1, normalized: 0.5, preFader: true }] }] });
  assert.equal(result.applied, 1, JSON.stringify(result));
  assert.deepEqual([result.results[0].send1PrePost, result.results[0].send1], ['pre', (await client.getValue('ch.0.send.0.level')).d]);
  assert.equal((await client.getValue('ch.0.send.0.level')).v, 0.5);
  assert.equal((await client.getValue('ch.0.send.0.prePost')).v, 1);
  assert.match((await call('cubase_apply_mix', { changes: [{ channel: 0, sends: [{ slot: 1, levelDb: -6, normalized: 0.5 }] }] })).error, /only one of levelDb, normalized/);
  assert.match((await call('cubase_apply_mix', { changes: [{ channel: 0, sends: [{ slot: 1 }] }] })).error, /needs levelDb, normalized, on or preFader/);
});

test('snapshots are not overwritten by accident, list their metadata and can be deleted inside the folder only', async () => {
  const { call, ctx } = await setupServer();
  const first = await call('cubase_snapshot_mix', { name: 'mix-a' });
  assert.equal(first.replaced, undefined);
  const before = readFileSync(first.file, 'utf8');
  const again = await call('cubase_snapshot_mix', { name: 'mix-a' });
  assert.match(again.error, /Snapshot "mix-a" already exists .*saved 20\d\d-.*overwrite: true/);
  assert.equal(readFileSync(first.file, 'utf8'), before);
  const replaced = await call('cubase_snapshot_mix', { name: 'mix-a', overwrite: true, allPages: false });
  assert.equal(replaced.replaced, true);

  writeFileSync(join(ctx.config.snapshotDir, 'broken.json'), '{nope');
  const list = await call('cubase_list_snapshots');
  assert.equal(list.count, 2);
  const a = list.snapshots.find((s) => s.name === 'mix-a');
  assert.deepEqual([a.file, a.channels, a.allPages, a.version], ['mix-a.json', 6, false, 2]);
  assert.ok(a.size > 100 && /^20\d\d-/.test(a.createdAt));
  assert.match(list.snapshots.find((s) => s.name === 'broken').error, /not valid JSON|Unexpected|JSON/);

  // Outside the folder: a name with ../ is sanitized into the folder, so nothing outside can be deleted.
  const outside = join(dirname(ctx.config.snapshotDir), `outside-${process.pid}.json`);
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, '{}');
  assert.match((await call('cubase_delete_snapshot', { name: `../outside-${process.pid}` })).error, /No snapshot/);
  assert.match((await call('cubase_delete_snapshot', { name: outside })).error, /No snapshot/);
  assert.ok(existsSync(outside));
  const deleted = await call('cubase_delete_snapshot', { name: 'mix-a' });
  assert.deepEqual([deleted.deleted, existsSync(first.file)], ['mix-a', false]);
  assert.match((await call('cubase_delete_snapshot', { name: 'mix-a' })).error, /No snapshot "mix-a"/);
  assert.equal((await call('cubase_delete_snapshot', { name: 'broken.json' })).deleted, 'broken');
});

test('cubase_restore_mix: dryRun writes nothing, and channels and fields limit what is restored', async () => {
  const { call, client, mock } = await setupServer();
  await call('cubase_snapshot_mix', { name: 'base' });
  await call('cubase_set_volume', { channel: 'Kick', normalized: 0.3 });
  await call('cubase_set_pan', { channel: 'Kick', normalized: 0.7 });
  await call('cubase_set_volume', { channel: 'Snare', normalized: 0.4 });
  const writes = mock.requests('value.setMany').length + mock.requests('value.set').length;

  const dry = await call('cubase_restore_mix', { snapshot: 'base', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changedChannels, 2);
  const kick = dry.results.find((r) => r.channel === 'Kick');
  assert.deepEqual(kick.changed, ['volume', 'pan']);
  assert.deepEqual(kick.values.volume, { now: 0.3, snapshot: 0.8 });
  assert.equal(dry.notVerified, undefined);
  assert.equal(mock.requests('value.setMany').length + mock.requests('value.set').length, writes);
  assert.equal((await client.getValue('ch.0.volume')).v, 0.3);

  // Only the pan of Kick.
  const pan = await call('cubase_restore_mix', { snapshot: 'base', channels: ['Kick'], fields: ['pan'] });
  assert.deepEqual([pan.changedChannels, pan.channelsRestored, pan.fields, pan.unmatched], [1, 1, ['pan'], []]);
  assert.deepEqual([(await client.getValue('ch.0.pan')).v, (await client.getValue('ch.0.volume')).v, (await client.getValue('ch.1.volume')).v], [0.5, 0.3, 0.4]);
  // A channel reference that is not found fails before anything is written.
  assert.match((await call('cubase_restore_mix', { snapshot: 'base', channels: ['Kick', 'Nope'] })).error, /not found, nothing was written: Nope/);
  assert.equal((await client.getValue('ch.0.volume')).v, 0.3);
  // By index and with the exact form.
  const two = await call('cubase_restore_mix', { snapshot: 'base', channels: [1, { name: 'kick' }], fields: ['volume'] });
  assert.equal(two.changedChannels, 2);
  assert.deepEqual([(await client.getValue('ch.0.volume')).v, (await client.getValue('ch.1.volume')).v], [0.8, 0.8]);
});

test('cubase_restore_mix with a channel filter leaves other solos alone and then does not restore mutes', async () => {
  const { call, mock } = await setupServer();
  await call('cubase_snapshot_mix', { name: 'clean' });
  await call('cubase_set_channel_state', { channel: 'Kick', mute: true });
  await call('cubase_set_channel_state', { channel: 'Snare', solo: true });
  const dry = await call('cubase_restore_mix', { snapshot: 'clean', dryRun: true });
  assert.deepEqual(dry.soloActiveNow, ['Snare', 'Stereo Out']);
  assert.match(dry.soloActiveNote, /solo-implied/);
  const kept = await call('cubase_restore_mix', { snapshot: 'clean', channels: ['Kick'] });
  assert.deepEqual(kept.soloKept, ['Snare', 'Stereo Out']);
  assert.deepEqual([real(mock, 0, 'Mute'), real(mock, 1, 'Solo')], [1, 1]);
  // Restoring the soloed channel too clears its solo first (Stereo Out, which only read solo because Snare fed it, then reads off), and the mute is restored.
  const both = await call('cubase_restore_mix', { snapshot: 'clean', channels: ['Kick', 'Snare'] });
  assert.deepEqual(both.solosCleared, ['Snare']);
  assert.deepEqual([real(mock, 0, 'Mute'), real(mock, 1, 'Solo')], [0, 0]);
  assert.equal(both.soloKept, undefined);
});
