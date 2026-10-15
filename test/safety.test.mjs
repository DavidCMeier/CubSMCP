import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer, bigProject } from './helpers/session.mjs';

// On 15 Oct 2026 Cubase 13 crashed (SIGSEGV, strlen on a null string) when the script asked for the
// unique id of an empty bank slot while paging the bank for a snapshot. The mock records such calls.
test('the script never asks Cubase for ids of empty bank slots or of an unbound selection', async () => {
  const { call, mock } = await setupServer({ tracks: bigProject() });
  // The selection starts without a mixer channel: these read it.
  await call('cubase_status', {});
  await call('cubase_get_channel_strip', {});
  // Paging the whole bank reaches the last page (41 channels, 7 empty slots).
  const snapshot = await call('cubase_snapshot_mix', { name: `safety-${process.pid}` });
  assert.ok(!snapshot.error, snapshot.error);
  await call('cubase_get_channel', { channel: 'Doubler' });
  await call('cubase_get_channel', { channel: 'No Such Channel' });
  await call('cubase_bank', { action: 'next' });
  await call('cubase_bank', { action: 'next' });
  await call('cubase_list_channels', {});
  // The last page (7 empty slots): kinds, hidden channels, routing, meters and a rename read the mixer tree there.
  await call('cubase_get_routing', {});
  await call('cubase_get_meters', {});
  await call('cubase_rename_channel', { channel: 'Doubler', name: 'Doubler 2' });
  await call('cubase_bank', { action: 'goToPage', page: 3 });
  await call('cubase_bank', { action: 'showChannel', channel: 'Trompeta' });
  await call('cubase_bank', { action: 'showAll' });
  await call('cubase_bank', { action: 'reset' });
  await call('cubase_focus_channel', { channel: 'G L Clean' });
  assert.deepEqual(mock.state.crashingCalls, []);
});
