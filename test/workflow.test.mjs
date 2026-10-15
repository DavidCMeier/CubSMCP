/**
 * Undo, bus creation, save and export: what Cubase did is checked (mix values, the bank, the Edit menu,
 * the project and export files) instead of echoing the command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupServer } from './helpers/session.mjs';

/** A fake MacUi over the mock: Cubase's windows and Edit menu, Return confirms the "Añadir pista" dialog. */
function fakeUi(mock, menu = {}) {
  const windows = () => (mock.state.pendingDialog ? [{ title: 'Añadir pista', width: 600, height: 400 }] : [{ title: '', width: 1600, height: 1000 }]);
  const state = async () => ({ frontApp: 'Cubase 13', cubaseRunning: true, cubaseFrontmost: true, windows: windows() });
  const keys = [];
  return {
    keys,
    activate: state,
    state,
    async keyCode(key) {
      keys.push(key);
      if (key === 'return') mock.confirmDialog();
      return {};
    },
    async listMenu(path) {
      if (path.length === 0) return { path, items: ['Cubase', 'Archivo', 'Edición'].map((name, i) => ({ name, index: i + 1, enabled: true, submenu: true })) };
      return {
        path,
        items: [
          { name: menu.undo ?? 'Deshacer', index: 1, enabled: menu.undoEnabled ?? false, submenu: false },
          { name: menu.redo ?? 'Rehacer', index: 2, enabled: menu.redoEnabled ?? false, submenu: false },
        ],
      };
    },
  };
}

test('cubase_undo reports what changed, and says when nothing did', async () => {
  const { call, client } = await setupServer();
  await client.setValue('ch.1.volume', 0.5);
  const undone = await call('cubase_undo', {});
  assert.deepEqual([undone.undone, undone.changed], [true, [{ channel: 'Snare', index: 1, fields: ['volume'] }]], JSON.stringify(undone));
  const nothing = await call('cubase_undo', {});
  assert.equal(nothing.undone, null);
  assert.match(nothing.note, /Nothing changed.*history may have been empty/);
  const redo = await call('cubase_undo', { redo: true });
  assert.deepEqual(redo.changed, [{ channel: 'Snare', index: 1, fields: ['volume'] }]);
  const { tools } = await (await setupServer()).mcp.listTools();
  assert.match(tools.find((t) => t.name === 'cubase_undo').description, /does not record mute or solo/);
});

test('cubase_undo with expect puts a different step back at once; without it, an undo of an older write is flagged', async () => {
  const { call, client, mock } = await setupServer();
  const gain = () => mock.state.project[0].values.get('mPreFilter.mGain');
  // As in the live test: a restore writes Kick's input gain (a MixConsole History step), then the search of
  // cubase_set_volume on Snare's fader leaves no step.
  await client.readSnapshotPage();
  await client.setValues([{ key: 'ch.0.pre.gain', value: 0.6 }]);
  mock.state.unrecordedHistory = /channel1\.mValue\.mVolume$/;
  await call('cubase_set_volume', { channel: 'Snare', volumeDb: -6 });

  let sent = mock.state.commandsRun.length;
  const checked = await call('cubase_undo', { expect: { channel: 'Snare', field: 'volume' } });
  assert.match(checked.error, /history's last step was a different change: the undo changed pre\.gain of "Kick" instead of volume of "Snare"/);
  assert.match(checked.error, /Redo MixConsole Step was sent at once and the bank page shows its values from before the undo again/);
  assert.match(checked.error, /may leave no MixConsole History step.*cubase_restore_mix/);
  assert.deepEqual(mock.state.commandsRun.slice(sent).map(([, name]) => name), ['Undo MixConsole Step', 'Redo MixConsole Step']);
  assert.equal(gain(), 0.6);

  // Without expect the undo stays, with a warning naming the last write and the older one it matches.
  const plain = await call('cubase_undo', {});
  assert.deepEqual(plain.changed, [{ channel: 'Kick', index: 0, fields: ['pre.gain'] }]);
  assert.deepEqual([plain.lastWrite.channel, plain.lastWrite.field], ['Snare', 'volume']);
  assert.match(plain.warning, /last mix value this server wrote was volume of "Snare" \(\d+ s ago\); what changed matches an older write of this server \(pre\.gain of "Kick"/);
  assert.match(plain.warning, /redo: true/);
  assert.equal(gain(), 0.5);
  await call('cubase_undo', { redo: true });
  assert.equal(gain(), 0.6);

  // A step that is the expected one: no error, no warning.
  mock.state.unrecordedHistory = null;
  await call('cubase_set_pan', { channel: 'Lead Vox', normalized: 0.3 });
  const matched = await call('cubase_undo', { expect: { channel: 'Lead Vox', field: 'pan' } });
  assert.deepEqual([matched.expectMet, matched.warning, matched.changed], [true, undefined, [{ channel: 'Lead Vox', index: 4, fields: ['pan'] }]], JSON.stringify(matched));

  // Expectations that cannot be checked fail before anything is sent.
  sent = mock.state.commandsRun.length;
  assert.match((await call('cubase_undo', { expect: { channel: 'Nope' } })).error, /expect\.channel: .*cubase_bank first\. Nothing was sent/);
  assert.match((await call('cubase_undo', { expect: { field: 'gain' } })).error, /"gain" is not a mix field: use one of volume, pan/);
  assert.match((await call('cubase_undo', { expect: { field: 'volume' }, verify: false })).error, /expect needs verify/);
  assert.match((await call('cubase_undo', { expect: {} })).error, /expect needs channel, field or both/);
  assert.equal(mock.state.commandsRun.length, sent);

  // When the redo does nothing (as in Cubase on 15 Oct 2026), the values from before are written directly.
  await client.setValues([{ key: 'ch.0.pre.gain', value: 0.7 }]);
  mock.state.unrecordedHistory = /channel1\.mValue\.mVolume$/;
  await call('cubase_set_volume', { channel: 'Snare', volumeDb: -3 });
  mock.state.redoIgnored = true;
  const rewritten = await call('cubase_undo', { expect: { channel: 'Snare', field: 'volume' } });
  assert.match(rewritten.error, /did not bring it back, so the values from before the undo were written again and the bank page shows them/);
  assert.equal(gain(), 0.7);
  mock.state.redoIgnored = false;
  sent = mock.state.commandsRun.length;

  // Nothing changed on the page (an empty history): an error, and nothing else is sent.
  mock.state.mixHistory = [];
  const empty = await call('cubase_undo', { expect: { field: 'volume' } });
  assert.match(empty.error, /nothing changed on the bank page shown now.*Nothing else was sent/);
  assert.deepEqual(mock.state.commandsRun.slice(sent).map(([, name]) => name), ['Undo MixConsole Step']);
  const { tools } = await (await setupServer()).mcp.listTools();
  assert.match(tools.find((t) => t.name === 'cubase_undo').description, /writes made by searches .* may leave no step/);
});

test('with UI automation, an undo with a disabled Edit menu item sends nothing, and an enabled one names the step', async () => {
  const session = await setupServer({ enableUi: true });
  const ui = fakeUi(session.mock);
  session.ctx.ui = ui;
  const empty = await session.call('cubase_undo', { scope: 'edit' });
  assert.deepEqual([empty.sent, empty.undone], [false, false], JSON.stringify(empty));
  assert.match(empty.reason, /nothing to undo/);
  assert.equal(session.mock.state.commandsRun.filter(([c]) => c === 'Edit').length, 0);
  session.ctx.ui = fakeUi(session.mock, { undo: 'Deshacer Ajustar nombre de pista', undoEnabled: true });
  const named = await session.call('cubase_undo', { scope: 'edit' });
  assert.deepEqual([named.sent, named.step, named.undone], [true, 'Ajustar nombre de pista', true], JSON.stringify(named));
});

test('cubase_create_bus_for_selection returns the new channel and the index shift; an undo lists the outputs it saved', async () => {
  const { call, mock } = await setupServer();
  await call('cubase_focus_channel', { channel: 'Lead Vox' });
  const created = await call('cubase_create_bus_for_selection', { type: 'group' });
  assert.equal(created.status, 'created', JSON.stringify(created));
  assert.deepEqual(created.created.map((c) => [c.type, c.name, c.index]), [['group', 'Group 1', 5]]);
  assert.deepEqual(created.indexShift, { fromIndex: 5, by: 1, channelsMoved: 1 });
  assert.deepEqual(created.sources, [{ channel: 'Lead Vox', index: 4, uid: 'uid-4-Lead Vox', output: 'Stereo Out', outputNow: 'Group 1' }]);
  assert.equal(mock.slotTitle(6), 'Stereo Out');

  const undo = await call('cubase_undo', { scope: 'edit' });
  assert.deepEqual(undo.removed, ['Group 1']);
  assert.match(undo.routingWarning, /left "Lead Vox" on "Sin bus" instead of the output it had before/);
  assert.deepEqual(undo.savedRouting, [{ channel: 'Lead Vox', index: 4, uid: 'uid-4-Lead Vox', output: 'Stereo Out', indexNow: 4, outputNow: 'Sin bus' }]);
  assert.equal(mock.outputOf('Lead Vox'), 'Sin bus');
});

test('the outputs saved for a bus survive a server restart before the undo', async () => {
  // Live (15 Oct 2026) the bus was created by one server process and undone by another, which knew nothing of it.
  const first = await setupServer();
  await first.call('cubase_focus_channel', { channel: 'Lead Vox' });
  assert.equal((await first.call('cubase_create_bus_for_selection', { type: 'group' })).status, 'created');
  const second = await setupServer({ session: first, snapshotDir: first.ctx.config.snapshotDir });
  const undo = await second.call('cubase_undo', { scope: 'edit' });
  assert.match(undo.routingWarning, /left "Lead Vox" on "Sin bus"/);
  assert.equal(undo.savedRouting[0].output, 'Stereo Out');
  // Used once: a later undo does not repeat it.
  assert.equal((await second.call('cubase_undo', { scope: 'edit' })).routingWarning, undefined);
});

test('the "Añadir pista" dialog is detected and confirmed with UI automation, or reported as open', async () => {
  const session = await setupServer({ enableUi: true });
  const ui = fakeUi(session.mock);
  session.ctx.ui = ui;
  session.mock.state.busDialog = true;
  await session.call('cubase_focus_channel', { channel: 'Kick' });
  const open = await session.call('cubase_create_bus_for_selection', { type: 'fx', confirmDialog: false });
  assert.deepEqual([open.status, open.dialog], ['dialog-open', { title: 'Añadir pista', confirmed: false }], JSON.stringify(open));
  assert.match(open.note, /ui_key return/);
  session.mock.confirmDialog();

  const confirmed = await session.call('cubase_create_bus_for_selection', { type: 'fx' });
  assert.deepEqual([confirmed.status, confirmed.dialog.confirmed, ui.keys], ['created', true, ['return']], JSON.stringify(confirmed));
  assert.equal(confirmed.created[0].name, 'FX 2');
});

test('save and export check the files when given their paths, and say unverified otherwise', async () => {
  const { call, mock } = await setupServer();
  const dir = mkdtempSync(join(tmpdir(), 'cubase-mcp-project-'));
  const project = join(dir, 'Song.cpr');
  writeFileSync(project, 'v1');
  utimesSync(project, new Date(2026, 0, 1), new Date(2026, 0, 1));
  const unverified = await call('cubase_save_project', {});
  assert.deepEqual([unverified.sent, unverified.verified], [true, false]);
  assert.match(unverified.note, /projectFile/);

  mock.state.onCommand = (category, name) => {
    if (category === 'File' && name === 'Save') writeFileSync(project, 'v2');
    if (category === 'File' && name === 'Save New Version') writeFileSync(join(dir, 'Song-02.cpr'), 'v3');
    if (category === 'Audio Export' && name === 'Perform Audio Export') writeFileSync(join(dir, 'Mix.wav'), Buffer.alloc(1000));
  };
  const saved = await call('cubase_save_project', { projectFile: project });
  assert.equal(saved.verified, true, JSON.stringify(saved));
  const version = await call('cubase_save_project', { projectFile: project, newVersion: true });
  assert.deepEqual(version.newFiles, ['Song-02.cpr']);
  mock.state.onCommand = null;
  const notWritten = await call('cubase_save_project', { projectFile: project, waitSeconds: 1 });
  assert.equal(notWritten.verified, false);
  assert.match(notWritten.note, /skips a save without changes/);
  assert.match((await call('cubase_save_project', { projectFile: 'Song.cpr' })).error, /absolute/);

  mock.state.onCommand = (category, name) => {
    if (category === 'Audio Export' && name === 'Perform Audio Export') writeFileSync(join(dir, 'Mix.wav'), Buffer.alloc(1000));
  };
  const exported = await call('cubase_export_audio_mixdown', { folder: dir, waitSeconds: 5 });
  assert.deepEqual([exported.verified, exported.files], [true, [{ name: 'Mix.wav', size: 1000 }]], JSON.stringify(exported));
  mock.state.onCommand = null;
  const nothing = await call('cubase_export_audio_mixdown', { folder: dir, waitSeconds: 1 });
  assert.deepEqual([nothing.verified, nothing.files], [false, []]);
  assert.equal((await call('cubase_export_audio_mixdown', {})).verified, false);
});
