import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigProject, setupCubase } from './helpers/session.mjs';
import { applyBankAction, matchChannelName, parseChannelRef, planBankMoves } from '../dist/cubase/bank.js';

const bankActions = (mock) => mock.state.actionsRun.filter((a) => a.startsWith('host.mMixConsole.')).length;

/** Entries as a scan of the big project sees them. */
function entries(tracks = bigProject()) {
  return tracks.map((title, position) => ({ page: Math.floor(position / 48) + 1, index: position % 48, position, title, uid: `u${position}` }));
}

test('channel references: indexes, digit texts and names; blank and number-like texts are rejected', () => {
  assert.deepEqual(parseChannelRef(3), { kind: 'index', index: 3 });
  assert.deepEqual(parseChannelRef('12'), { kind: 'index', index: 12 });
  assert.deepEqual(parseChannelRef(' 7 '), { kind: 'index', index: 7 });
  assert.deepEqual(parseChannelRef('  G L '), { kind: 'name', name: 'G L' });
  for (const blank of ['', ' ', '\t', '\n ']) assert.throws(() => parseChannelRef(blank), /blank/);
  // What MCP clients send as text when a number is not a valid index.
  for (const text of ['37.5', '-1', '2.5', '+4', '1e3']) assert.throws(() => parseChannelRef(text), /not a valid bank index/);
  for (const number of [37.5, -1]) assert.throws(() => parseChannelRef(number), /whole number/);
});

test('names: exact first, #N for repeated names, and ambiguity fails with the candidates', () => {
  const all = entries();
  assert.equal(matchChannelName(all, 'trompeta').position, 60);
  assert.equal(matchChannelName(all, 'Doubler').position, 136); // exact beats the prefix "Doubler Vox"
  assert.deepEqual([matchChannelName(all, 'G L#2').position, matchChannelName(all, 'g l #1').position], [37, 35]);
  assert.equal(matchChannelName(all, 'G L#2').matchedBy, 'occurrence');
  assert.throws(() => matchChannelName(all, 'G L#3'), /There are 2 channels named "G L"/);
  assert.throws(
    () => matchChannelName(all, 'G L'),
    (error) =>
      /ambiguous: 2 channels have this name: "G L" \(page 1, index 35, uid u35\), "G L" \(page 1, index 37, uid u37\)/.test(error.message) && error.candidates.length === 2,
  );
  // No exact name: several prefixes or substrings are ambiguous too.
  assert.throws(() => matchChannelName(all, 'Bass Cl'), /ambiguous: 2 channels start with it/);
  assert.throws(() => matchChannelName(all, 'Clean'), /ambiguous: 3 channels contain it/);
  assert.equal(matchChannelName(all, 'Clean Arm').matchedBy, 'substring');
  // "Bass" and "BASS": the one written the same way wins.
  const cased = [...all.slice(0, 2), { ...all[2], title: 'Bass' }, { ...all[3], title: 'BASS' }];
  assert.equal(matchChannelName(cased, 'BASS').position, 3);
  assert.throws(() => matchChannelName(cased, 'bass'), /ambiguous/);
  assert.throws(() => matchChannelName(all, 'Nope', 'any mixer bank page (3 pages looked at)'), /not found in any mixer bank page \(3 pages looked at\)/);
});

test('exact references: {name, occurrence, exact} take only the whole name, literally', () => {
  const all = entries();
  assert.deepEqual(parseChannelRef({ name: ' G L ', occurrence: 2 }), { kind: 'name', name: 'G L', exact: true, literal: true, occurrence: 2 });
  assert.deepEqual(parseChannelRef({ name: 'clean', exact: false }), { kind: 'name', name: 'clean', exact: false, literal: true });
  assert.throws(() => parseChannelRef({ name: ' ' }), /blank/);
  assert.throws(() => parseChannelRef({ name: 'G L', occurrence: 0 }), /occurrence/);
  assert.throws(() => parseChannelRef({ name: 'G L', occurrence: 2, exact: false }), /cannot be used with exact: false/);
  const match = (ref) => {
    const parsed = parseChannelRef(ref);
    return matchChannelName(all, parsed.name, 'any mixer bank page', parsed);
  };
  // "G L" resolves to nothing by prefix: the exact name is ambiguous, occurrence picks one.
  assert.throws(() => match({ name: 'G L' }), /ambiguous: 2 channels have this name.*uid u35.*uid u37.*"occurrence": 2/);
  assert.deepEqual([match({ name: 'g l', occurrence: 2 }).position, match({ name: 'G L', occurrence: 1 }).position], [37, 35]);
  assert.equal(match({ name: 'G L', occurrence: 2 }).matchedBy, 'occurrence');
  assert.throws(() => match({ name: 'G L', occurrence: 3 }), /There are 2 channels named "G L" \(occurrence 1..2\)/);
  // Exact only: "clean" no longer falls back to the substring of "Bass Clean Arm" and friends, nor "bass" to a prefix.
  assert.throws(() => match({ name: 'clean' }), /No channel is named exactly "clean".*prefixes and substrings are not tried/);
  assert.throws(() => match({ name: 'Bass' }), /No channel is named exactly "Bass"/);
  assert.equal(match({ name: 'bass clean' }).position, 32);
  assert.equal(match({ name: 'Clean Arm', exact: false }).matchedBy, 'substring');
  // Literal: "#2" is part of the name in the object form.
  const hashed = [...all.slice(0, 3), { ...all[3], title: 'Mix #2' }];
  assert.equal(matchChannelName(hashed, 'Mix #2', 'x', parseChannelRef({ name: 'Mix #2' })).position, 3);
  assert.throws(() => matchChannelName(all, 'G L#2', 'x', parseChannelRef({ name: 'G L#2' })), /No channel is named exactly "G L#2"/);
});

test('bank moves follow Cubase offsets and the planner takes the short way', () => {
  assert.equal(applyBankAction(96, 'next', 137, 48), 136); // the page with only the last channel
  assert.equal(applyBankAction(10, 'prev', 137, 48), 0);
  assert.deepEqual(planBankMoves(48, 0, 137, 48), ['prev']);
  assert.deepEqual(planBankMoves(null, 49, 137, 48), ['reset', 'next', 'shiftRight']);
  assert.deepEqual(planBankMoves(0, 136, 137, 48), ['next', 'next', 'next']);
  assert.deepEqual(planBankMoves(96, 1, 137, 48), ['reset', 'shiftRight']);
  assert.deepEqual(planBankMoves(96, 48, 137, 48), ['prev']);
  assert.deepEqual(planBankMoves(96, 95, 137, 48), ['shiftLeft']);
  assert.deepEqual(planBankMoves(0, 0, 137, 48), []);
});

test('a lookup by name on another page acts there and puts the bank back', async () => {
  const { client, mock } = await setupCubase({ tracks: bigProject() });
  const seen = await client.withChannel('trompeta', async (channel) => ({ channel, slotTitle: mock.slotTitle(channel.index) }));
  assert.equal(seen.slotTitle, 'Trompeta');
  assert.deepEqual([seen.channel.index, seen.channel.position, seen.channel.page, seen.channel.matchedBy], [12, 60, 2, 'exact']);
  assert.equal(seen.channel.uid, 'uid-60-Trompeta');
  assert.equal(seen.bankWarning, undefined);
  assert.equal(mock.state.bankOffset, 0);
  // From another page too, also when the lookup fails.
  await client.moveBank('next');
  assert.equal(mock.state.bankOffset, 48);
  await assert.rejects(client.withChannel('Nope', async () => ({})), /not found in any mixer bank page \(3 pages looked at\)/);
  assert.equal(mock.state.bankOffset, 48);
  await assert.rejects(client.withChannel('G L', async () => ({})), /ambiguous/);
  assert.equal(mock.state.bankOffset, 48);
  await assert.rejects(client.withChannel('Doubler', async () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(mock.state.bankOffset, 48);
});

test('blank and number-like references fail before the bank moves; indexes address the page shown now', async () => {
  const { client, mock } = await setupCubase({ tracks: bigProject() });
  for (const ref of [' ', '\t', '37.5', '-1', 2.5]) {
    await assert.rejects(client.withChannel(ref, async () => ({})));
  }
  assert.equal(bankActions(mock), 0);
  const byText = await client.withChannel('3', async (channel) => channel);
  assert.deepEqual([byText.index, byText.title, byText.matchedBy], [3, 'Track 003', 'index']);
  // An empty slot is not a channel.
  const small = await setupCubase();
  await assert.rejects(small.client.withChannel(10, async () => ({})), /Bank slot 10 is empty: the current bank page has 6 channels \(indexes 0-5\)/);
  await assert.rejects(small.client.withChannel(60, async () => ({})), /out of range/);
});

test('a lookup survives late and lost bank moves', async () => {
  const late = await setupCubase({ tracks: bigProject(), bankTimeoutMs: 1000 });
  late.mock.state.bankDelayMs = 60;
  late.mock.state.titleDelayMs = 20;
  const found = await late.client.withChannel('Doubler', async (channel) => ({ title: late.mock.slotTitle(channel.index), channel }));
  assert.deepEqual([found.title, found.channel.position], ['Doubler', 136]);
  assert.equal(late.mock.state.bankOffset, 0);

  const lost = await setupCubase({ tracks: bigProject() });
  await lost.client.withChannel('Stereo Out', async () => ({})); // learns the first page
  lost.mock.state.dropBankActions = 1; // the first next never reaches Cubase
  const from = lost.mock.state.actionsRun.length;
  const again = await lost.client.withChannel('Doubler Vox', async (channel) => channel);
  assert.equal(again.position, 100);
  // Sent again, then checked that the bank did not skip a page (one left, one back).
  const sent = lost.mock.state.actionsRun.slice(from).map((a) => a.split('.').pop());
  assert.deepEqual(sent.slice(0, 4), ['mNextBank', 'mNextBank', 'mShiftLeft', 'mShiftRight']);
  assert.equal(lost.mock.state.bankOffset, 0);
});

test('paging goes back to a shifted bank and never ends on the page that repeats the last channel', async () => {
  const { client, mock } = await setupCubase({ tracks: bigProject() });
  await client.moveBank('shiftRight');
  assert.equal(mock.state.bankOffset, 1);
  const titles = [];
  const paging = await client.forEachBankPage(async () => {
    const page = await client.readSnapshotPage();
    titles.push(...page.channels.map((c) => c.title));
    return page.channels.length < page.size;
  });
  assert.deepEqual([paging.pages, paging.bankRestored, titles.length], [3, true, 137]);
  assert.equal(mock.state.bankOffset, 1);
  // Two passes go back once, to where the bank was before the first one.
  const passes = [];
  await client.forEachBankPage([async (p) => void passes.push(`a${p}`), async (p) => void passes.push(`b${p}`)]);
  assert.deepEqual(passes, ['a0', 'a1', 'a2', 'b0', 'b1', 'b2']);
  assert.equal(mock.state.bankOffset, 1);

  // 96 channels: a next from the second (full) page shows only the last channel; it is not a page.
  const even = await setupCubase({ tracks: Array.from({ length: 96 }, (_, i) => `Ch ${i}`) });
  const pages = [];
  const result = await even.client.forEachBankPage(async (p) => void pages.push(p));
  assert.deepEqual([pages, result.bankRestored, even.mock.state.bankOffset], [[0, 1], true, 0]);
  const last = await even.client.withChannel('Ch 95', async (channel) => channel);
  assert.deepEqual([last.position, last.index], [95, 47]);
  assert.equal(even.mock.state.bankOffset, 0);
});

test('several references: one scan, indexes pinned to the starting page, results in order', async () => {
  const { client, mock } = await setupCubase({ tracks: bigProject() });
  await client.moveBank('next'); // indexes now address channels 48..95
  const { results, bankRestored } = await client.withChannels([2, 'Trompeta', 'Doubler', 'G L', 'G L#2', ' zz '], async (channel) => ({
    position: channel.position,
    shown: mock.slotTitle(channel.index),
  }));
  assert.equal(bankRestored, true);
  assert.deepEqual(results.slice(0, 3), [
    { position: 50, shown: 'Track 050' },
    { position: 60, shown: 'Trompeta' },
    { position: 136, shown: 'Doubler' },
  ]);
  assert.match(results[3].error, /ambiguous/);
  assert.deepEqual(results[4], { position: 37, shown: 'G L' });
  assert.match(results[5].error, /not found/);
  assert.equal(mock.state.bankOffset, 48);
});

test('cubase_bank waits for the move and does not page past the last page', async () => {
  const { client, mock } = await setupCubase({ tracks: bigProject() });
  mock.state.titleDelayMs = 30; // titles pass through empty while the bank moves
  // Before any reset the server does not know where the bank is.
  assert.equal((await client.moveBank('shiftRight')).position, null);
  assert.equal((await client.moveBank('reset')).position, 0);
  const next = await client.moveBank('next');
  assert.deepEqual([next.sent, next.moved, next.count, next.atEnd, next.position], [true, true, 48, false, 48]);
  assert.deepEqual(next.channels[0], { index: 0, title: 'Track 048', uid: 'uid-48-Track 048' });
  const last = await client.moveBank('next');
  assert.deepEqual([last.count, last.atEnd, last.position], [41, true, 96]);
  const none = await client.moveBank('next');
  assert.deepEqual([none.sent, none.moved, mock.state.bankOffset], [false, false, 96]);
  const back = await client.moveBank('shiftLeft');
  assert.deepEqual([back.moved, back.position, back.count], [true, 95, 42]);
  const reset = await client.moveBank('reset');
  assert.deepEqual([reset.position, mock.state.bankOffset], [0, 0]);
  const prev = await client.moveBank('prev');
  assert.equal(prev.sent, false);
});

test('focusing a channel by name on another page selects it and puts the bank back', async () => {
  const { client, mock } = await setupCubase({ tracks: bigProject() });
  const focus = await client.focusChannel('Trompeta');
  assert.equal(focus.verified, true);
  assert.equal(mock.state.project[mock.state.selectedIndex].title, 'Trompeta');
  assert.equal(mock.state.bankOffset, 0);
  assert.equal((await client.selected()).title, 'Trompeta');
});

test('the script keeps hidden channels in the bank and reports it', async () => {
  const { client, mock } = await setupCubase({ tracks: bigProject(), hidden: [1, 2, 3] });
  assert.equal(mock.state.followVisibility, false);
  const caps = await client.capabilities();
  assert.equal(caps.capabilities.followVisibility, false);
  const { channels } = await client.channels(false);
  assert.equal(channels[1].title, 'Track 001');
});

test('the script rejects missing or non-numeric values instead of writing NaN', async () => {
  const { client } = await setupCubase();
  await assert.rejects(client.setValue('ch.0.volume', undefined), /Missing value/);
  await assert.rejects(client.setValue('ch.0.volume', 'abc'), /Invalid value/);
  const items = await client.call('da.setParams', { scope: 'sel.ins.0', items: [{ title: 'Threshold' }] });
  assert.match(items.results[0].error, /Missing value/);
});
