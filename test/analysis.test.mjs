import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  AudioAnalyzer,
  BANDS,
  compareAnalyses,
  globMatcher,
  maskingReport,
  parseAstats,
  parseFfmpegFormat,
  resolveAudioPath,
} from '../dist/analysis/audio.js';
import { registerAnalysisTools } from '../dist/tools/analysis.js';

let root;
let folder;
let hasFfmpeg = true;

const lavfi = (file, source, extra = []) => execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', source, ...extra, file]);
const float = ['-c:a', 'pcm_f32le'];
const analyzer = () => new AudioAnalyzer('ffmpeg', 'ffprobe');

before(() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    hasFfmpeg = false;
    return;
  }
  root = mkdtempSync(join(tmpdir(), 'cubase-mcp-test-'));
  folder = join(root, 'stems');
  mkdirSync(folder);
  const tone = (name, freq, volume) => lavfi(join(folder, name), `sine=frequency=${freq}:duration=3`, ['-af', `volume=${volume}`, '-ac', '2']);
  tone('bass.wav', 80, 0.5);
  tone('kick.wav', 70, 0.45);
  tone('hat.wav', 9000, 0.1);
});

/** A fake analysis with the given band levels, for the pure functions. */
function fake(name, bands, extra = {}) {
  return {
    file: `/x/${name}`,
    name,
    integratedLufs: -14,
    loudnessRangeLu: 5,
    truePeakDbtp: -1,
    crestFactorDb: 10,
    silent: false,
    belowGate: false,
    stereo: null,
    bands: Object.fromEntries(BANDS.map((b) => [b.name, { rmsDb: bands[b.name] ?? null, relativeDb: bands[b.name] ?? null }])),
    warnings: [],
    ...extra,
  };
}

test('analyzes a file', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const result = await analyzer().analyzeFile(join(folder, 'bass.wav'));
  assert.ok(result.integratedLufs !== null && result.integratedLufs < 0);
  assert.ok(result.truePeakDbtp !== null);
  assert.ok(result.bands.bass.relativeDb > result.bands.air.relativeDb);
  assert.ok(result.stereo.correlationApprox > 0.9);
  assert.equal(result.silent, false);
  assert.deepEqual(result.warnings, []);
});

test('band keys follow the order of BANDS', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const result = await analyzer().analyzeFile(join(folder, 'hat.wav'));
  assert.deepEqual(Object.keys(result.bands), BANDS.map((b) => b.name));
});

test('crest factor of a sine is about 3 dB', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const result = await analyzer().analyzeFile(join(folder, 'bass.wav'), { bands: false });
  assert.ok(Math.abs(result.crestFactorDb - 3.0) <= 0.2, String(result.crestFactorDb));
});

test('crest factor comes from the channels, not from Overall', () => {
  // ffmpeg 9 prints "Crest factor" per channel only; a silent channel reports 1 and is ignored.
  const log = [
    'Channel: 1', 'DC offset: 0.000100', 'Peak level dB: -6.0', 'RMS level dB: -9.0', 'Crest factor: 1.414214',
    'Channel: 2', 'DC offset: -0.004000', 'Peak level dB: -inf', 'RMS level dB: -inf', 'Crest factor: 1.000000',
    'Overall', 'DC offset: -0.001950', 'Peak level dB: -6.0', 'RMS level dB: -12.0',
  ].join('\n');
  const stats = parseAstats(log);
  assert.equal(stats.crestDb, 3.0);
  assert.equal(stats.peak, -6);
  assert.equal(stats.rms, -12);
  // The channel with the largest offset, at six decimals.
  assert.equal(stats.dcOffset, -0.004);
  // Without per-channel crest values, peak - RMS of Overall.
  assert.equal(parseAstats('Overall\nPeak level dB: -1.0\nRMS level dB: -13.5').crestDb, 12.5);
  // Nothing reached astats (the gate removed everything).
  assert.deepEqual(parseAstats('No filtered frames for output stream'), { peak: null, rms: null, crestDb: null, dcOffset: null });
});

test('crest factor difference produces a dynamics suggestion', () => {
  const report = compareAnalyses(fake('mix.wav', {}, { crestFactorDb: 12 }), fake('ref.wav', {}, { crestFactorDb: 9 }));
  assert.equal(report.deltas.crestFactorDb, 3);
  assert.ok(report.suggestions.some((s) => s.includes('more dynamic')), JSON.stringify(report.suggestions));
});

test('small DC offsets are measured and reported with their value', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const small = join(root, 'dc003.wav');
  const large = join(root, 'dc02.wav');
  // Not 1 kHz at 48 kHz: ffmpeg probes that perfectly periodic float WAV as MPEG-TS and refuses to open it.
  lavfi(small, 'aevalsrc=0.3*sin(2*PI*997*t)+0.003:s=44100:d=2', float);
  lavfi(large, 'aevalsrc=0.3*sin(2*PI*997*t)+0.02:s=44100:d=2', float);
  const a = await analyzer().analyzeFile(small, { bands: false, stereo: false });
  assert.ok(Math.abs(a.dcOffset - 0.003) < 0.0005, String(a.dcOffset));
  const warning = a.warnings.find((w) => w.startsWith('Noticeable DC offset'));
  assert.ok(warning?.includes('0.0030') && warning.includes('dBFS'), JSON.stringify(a.warnings));
  assert.ok(!warning.includes('high-pass'));
  const b = await analyzer().analyzeFile(large, { bands: false, stereo: false });
  assert.ok(b.warnings.some((w) => w.includes('-34') && w.includes('high-pass')), JSON.stringify(b.warnings));
});

test('a failing ffprobe falls back to ffmpeg and keeps the stereo analysis', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const file = join(root, 'antiphase.wav');
  lavfi(file, 'aevalsrc=0.5*sin(2*PI*440*t)|-0.5*sin(2*PI*440*t):s=48000:d=2', float);
  const result = await new AudioAnalyzer('ffmpeg', '/nonexistent/ffprobe').analyzeFile(file, { bands: false });
  assert.equal(result.channels, 2);
  assert.equal(result.sampleRate, 48000);
  assert.equal(result.durationSec, 2);
  assert.ok(result.stereo.correlationApprox < -0.9, JSON.stringify(result.stereo));
  assert.ok(result.warnings.some((w) => w.startsWith('ffprobe failed')), JSON.stringify(result.warnings));
  assert.ok(result.warnings.some((w) => w.startsWith('Negative stereo correlation')));
});

test('reads the format from the ffmpeg banner', () => {
  const banner = [
    "Input #0, wav, from 'x.wav':",
    '  Duration: 00:01:02.50, bitrate: 1411 kb/s',
    '  Stream #0:0: Audio: pcm_s24le ([1][0][0][0] / 0x0001), 48000 Hz, 5.1(side), s32 (24 bit), 6912 kb/s',
    "Output #0, null, to 'pipe:':",
    '  Stream #0:0: Audio: pcm_s16le, 44100 Hz, mono, s16',
  ].join('\n');
  assert.deepEqual(parseFfmpegFormat(banner), { duration: 62.5, sampleRate: 48000, channels: 6 });
  assert.equal(parseFfmpegFormat('Stream #0:0: Audio: pcm_f32le, 44100 Hz, stereo, flt').channels, 2);
  assert.equal(parseFfmpegFormat('Stream #0:0: Audio: pcm_f32le, 44100 Hz, 3 channels, flt').channels, 3);
  assert.deepEqual(parseFfmpegFormat('garbage'), { duration: null, sampleRate: null, channels: null });
});

test('ffprobe health check does not throw', async () => {
  assert.equal(await new AudioAnalyzer('ffmpeg', '/nonexistent/ffprobe').checkFfprobe(), null);
});

test('detects masking between stems', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const { masking, skipped } = await analyzer().analyzeFolder(folder);
  const bassConflict = masking.conflicts.find((c) => c.band === 'bass');
  assert.ok(bassConflict, JSON.stringify(masking.conflicts));
  assert.deepEqual(bassConflict.stems.sort(), ['bass.wav', 'kick.wav']);
  // 70 and 80 Hz tones leaked into sub with the old 4th-order filters and made a false conflict there.
  assert.equal(masking.conflicts.find((c) => c.band === 'sub'), undefined, JSON.stringify(masking.conflicts));
  assert.deepEqual(skipped, []);
});

test('band filters keep a 100 Hz tone out of sub', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const file = join(root, 'bass100.wav');
  lavfi(file, 'sine=frequency=100:duration=3');
  const result = await analyzer().analyzeFile(file, { stereo: false });
  assert.ok(result.bands.sub.relativeDb < -30, JSON.stringify(result.bands));
  assert.ok(Math.abs(result.bands.bass.relativeDb) < 0.5, JSON.stringify(result.bands));
});

test('two pink noise stems still conflict', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const dir = join(root, 'pink');
  mkdirSync(dir);
  lavfi(join(dir, 'a.wav'), 'anoisesrc=color=pink:duration=3:seed=1');
  lavfi(join(dir, 'b.wav'), 'anoisesrc=color=pink:duration=3:seed=2');
  const { masking } = await analyzer().analyzeFolder(dir);
  for (const band of ['bass', 'mid', 'air']) {
    const conflict = masking.conflicts.find((c) => c.band === band);
    assert.deepEqual(conflict?.stems.sort(), ['a.wav', 'b.wav'], band);
  }
});

test('the silence gate trims leading and trailing digital silence', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const file = join(root, 'gap.wav');
  // 3 s of silence, 1 s of a 1 kHz sine (-9 dBFS RMS), 6 s of silence, as a float export.
  lavfi(file, 'aevalsrc=if(between(t\\,3\\,4)\\,0.5*sin(2*PI*1000*t)\\,0)|if(between(t\\,3\\,4)\\,0.5*sin(2*PI*1000*t)\\,0):s=48000:d=10', float);
  const result = await analyzer().analyzeFile(file);
  assert.ok(result.activeRmsDbfs > -11 && result.activeRmsDbfs < -8.5, String(result.activeRmsDbfs));
  // Bands measure the same stretch of audio as active RMS, so none can come out louder than the whole.
  for (const band of BANDS) assert.ok((result.bands[band.name].relativeDb ?? -99) <= 0.3, JSON.stringify(result.bands));
  assert.ok(Math.abs(result.bands.mid.relativeDb) < 0.5, JSON.stringify(result.bands));
});

test('digital silence is flagged and not compared', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const file = join(root, 'silent.wav');
  lavfi(file, 'anullsrc=r=48000:cl=stereo', ['-t', '2', ...float]);
  const silent = await analyzer().analyzeFile(file);
  assert.equal(silent.silent, true);
  assert.equal(silent.belowGate, true);
  assert.equal(silent.integratedLufs, null);
  assert.equal(silent.loudnessRangeLu, null);
  assert.equal(silent.peakDbfs, null);
  assert.ok(silent.warnings.some((w) => w.startsWith('Digital silence')), JSON.stringify(silent.warnings));
  assert.doesNotMatch(JSON.stringify(silent), /Infinity|NaN/);
  const report = await analyzer().compare(file, join(folder, 'bass.wav'));
  assert.equal(report.deltas.integratedLufs, null);
  assert.ok(Object.values(report.deltas.tonalBalanceDb).every((v) => v === null));
  assert.equal(report.suggestions.length, 1);
  assert.match(report.suggestions[0], /^Cannot compare: the target \(silent\.wav\) is digital silence/);
});

test('masking compares stems with each other, not only with the loudest', () => {
  const analyses = [fake('a.wav', { mid: -20 }), fake('b.wav', { mid: -20.5 }), fake('mix.wav', { mid: -12 })];
  const masking = maskingReport(analyses);
  assert.deepEqual(masking.conflicts, [{ band: 'mid', stems: ['a.wav', 'b.wav'], spreadDb: 0.5 }]);
  // Overlapping groups are all reported, each one maximal.
  const chain = maskingReport([fake('a', { mid: -10 }), fake('b', { mid: -14 }), fake('c', { mid: -18 })]);
  assert.deepEqual(chain.conflicts.map((c) => c.stems), [['a', 'b'], ['b', 'c']]);
  assert.deepEqual(maskingReport(analyses, { windowDb: 10 }).conflicts[0].stems, ['mix.wav', 'a.wav', 'b.wav']);
  assert.deepEqual(maskingReport(analyses, { floorDb: -15 }).conflicts, []);
});

test('excluded files are analyzed but left out of masking', () => {
  const analyses = [fake('a.wav', { mid: -20 }), fake('mix.wav', { mid: -19 })];
  const masking = maskingReport(analyses, { exclude: ['MIX.wav', 'nope.wav'] });
  assert.deepEqual(masking.conflicts, []);
  assert.deepEqual(masking.excluded, ['mix.wav']);
  assert.deepEqual(masking.bands.mid, [{ name: 'a.wav', rmsDb: -20 }]);
  assert.ok(masking.notes.some((n) => n.includes('nope.wav')));
});

test('unreadable files are reported in skipped', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const dir = join(root, 'broken');
  mkdirSync(dir);
  writeFileSync(join(dir, 'empty.wav'), '');
  writeFileSync(join(dir, 'fake.wav'), 'not audio');
  await assert.rejects(analyzer().analyzeFolder(dir), (error) => {
    assert.match(error.message, /No readable audio files/);
    assert.match(error.message, /empty\.wav \(/);
    assert.match(error.message, /fake\.wav \(/);
    return true;
  });
  lavfi(join(dir, 'ok.wav'), 'sine=frequency=440:duration=1');
  const { files, skipped } = await analyzer().analyzeFolder(dir);
  assert.deepEqual(files.map((f) => f.name), ['ok.wav']);
  assert.deepEqual(skipped.map((s) => s.file).sort(), [join(dir, 'empty.wav'), join(dir, 'fake.wav')]);
  assert.ok(skipped.every((s) => s.reason.length > 0));
});

test('a missing ffmpeg is reported as such by analyzeFolder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cubase-mcp-test-'));
  writeFileSync(join(dir, 'a.wav'), '');
  await assert.rejects(new AudioAnalyzer('/nonexistent/ffmpeg', 'ffprobe').analyzeFolder(dir), /ffmpeg not found/);
});

test('dangling symlinks and folder loops do not abort the folder', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const dir = join(root, 'links');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  lavfi(join(dir, 'ok_sine.wav'), 'sine=frequency=440:duration=1');
  lavfi(join(dir, 'sub', 'nested.wav'), 'sine=frequency=880:duration=1');
  symlinkSync(join(dir, 'missing.wav'), join(dir, 'zz_dangling.wav'));
  symlinkSync(dir, join(dir, 'sub', 'loop'));
  const flat = await analyzer().analyzeFolder(dir);
  assert.deepEqual(flat.files.map((f) => f.name), ['ok_sine.wav']);
  assert.deepEqual(flat.skipped.map((s) => s.file), [join(dir, 'zz_dangling.wav')]);
  const deep = await analyzer().analyzeFolder(dir, { recursive: true });
  assert.deepEqual(deep.files.map((f) => f.name), ['ok_sine.wav', 'nested.wav']);
  await assert.rejects(analyzer().analyzeFolder(join(root, 'does-not-exist')), /ENOENT/);
});

/** A fake mix for compareAnalyses: band levels relative to active RMS; band RMS = relative + activeRms. */
function mix(name, rel, { lufs = -14, activeRms = -16, truePeak = -1.5, lra = 5, crest = 10 } = {}) {
  return fake(name, {}, {
    integratedLufs: lufs,
    truePeakDbtp: truePeak,
    loudnessRangeLu: lra,
    crestFactorDb: crest,
    activeRmsDbfs: activeRms,
    bands: Object.fromEntries(BANDS.map((b) => [b.name, { rmsDb: (rel[b.name] ?? -10) + activeRms, relativeDb: rel[b.name] ?? -10 }])),
  });
}

/** A "~/..." spelling of an absolute path (through "..", since the temp folder is outside the home folder). */
const tilde = (path) => `~/${relative(homedir(), path)}`;

test('an empty band gets no boost and band suggestions are capped', () => {
  // G-R04: the mix had nothing in a band the reference filled, and the tool proposed a 29 dB boost.
  const report = compareAnalyses(mix('mix.wav', { air: -70, bass: -20 }), mix('ref.wav', { air: -12, bass: -6 }));
  assert.equal(report.deltas.tonalBalanceDb.air, -58);
  assert.deepEqual(report.emptyBands, { floorDb: -40, target: ['air'], reference: [] });
  const air = report.suggestions.find((s) => s.startsWith('air'));
  assert.match(air, /no boost is suggested/);
  assert.doesNotMatch(air, /boost of about/);
  // bass: 14 dB quieter, half of it is 7, capped at the default 6.
  assert.match(report.suggestions.find((s) => s.startsWith('bass')), /a boost of about 6 dB \(capped at 6 dB/);
  const custom = compareAnalyses(mix('mix.wav', { bass: -20 }), mix('ref.wav', { bass: -6 }), { maxSuggestionDb: 3, bandFloorDb: -15 });
  assert.match(custom.suggestions.find((s) => s.startsWith('bass')), /no boost is suggested/);
  const small = compareAnalyses(mix('mix.wav', { bass: -10 }), mix('ref.wav', { bass: -6 }), { maxSuggestionDb: 3 });
  assert.match(small.suggestions.find((s) => s.startsWith('bass')), /a boost of about 2 dB\.$/);
  const capped = compareAnalyses(mix('mix.wav', { bass: -20 }), mix('ref.wav', { bass: -6 }), { maxSuggestionDb: 3 });
  assert.match(capped.suggestions.find((s) => s.startsWith('bass')), /a boost of about 3 dB \(capped at 3 dB/);
  // Both empty: a difference between noise floors is not a suggestion. A cut where the reference is empty still is.
  const floors = compareAnalyses(mix('mix.wav', { sub: -50, air: -20 }), mix('ref.wav', { sub: -80, air: -60 }));
  assert.ok(!floors.suggestions.some((s) => s.startsWith('sub')), JSON.stringify(floors.suggestions));
  assert.match(floors.suggestions.find((s) => s.startsWith('air')), /a cut of about 6 dB .*The reference has almost nothing in this band\./);
});

test('bands chooses which bands are compared', () => {
  const report = compareAnalyses(mix('mix.wav', { bass: -2, air: -30 }), mix('ref.wav', { bass: -8, air: -10 }), { bands: ['mid', 'bass'] });
  assert.deepEqual(Object.keys(report.deltas.tonalBalanceDb), ['bass', 'mid']);
  assert.ok(!report.suggestions.some((s) => s.startsWith('air')));
  assert.throws(() => compareAnalyses(mix('a', {}), mix('b', {}), { bands: ['bass', 'treble'] }), /Unknown band treble/);
});

test('loudnessMatch compares bands after matching integrated loudness and reports the gain', () => {
  // Same bass relative to active RMS, but against loudness the mix's bass is 2 dB lower.
  const target = mix('mix.wav', { bass: -6 }, { lufs: -18, activeRms: -21, truePeak: -3 });
  const reference = mix('ref.wav', { bass: -6 }, { lufs: -12, activeRms: -13 });
  assert.equal(compareAnalyses(target, reference).deltas.tonalBalanceDb.bass, 0);
  assert.equal(compareAnalyses(target, reference).loudnessMatch, null);
  const matched = compareAnalyses(target, reference, { loudnessMatch: true });
  assert.equal(matched.deltas.tonalBasis, 'loudness');
  assert.equal(matched.deltas.tonalBalanceDb.bass, -2);
  assert.deepEqual(matched.loudnessMatch, { gainDb: 6, targetLufs: -18, referenceLufs: -12, targetTruePeakAfterGainDbtp: 3 });
  assert.match(matched.suggestions.find((s) => s.startsWith('bass')), /quieter than the reference at matched loudness/);
});

test('loudness, true peak and loudness range advice say which way to go', () => {
  const quiet = compareAnalyses(mix('mix.wav', {}, { lufs: -18, truePeak: -3 }), mix('ref.wav', {}, { lufs: -12, truePeak: -1 }));
  const raise = quiet.suggestions.find((s) => s.startsWith('The mix is'));
  assert.match(raise, /6 LU quieter than the reference \(-18 vs -12 LUFS\): raise the mix by 6 LU/);
  assert.match(raise, /true peak would reach 3 dBTP: get there with the limiter/);
  const loud = compareAnalyses(mix('mix.wav', {}, { lufs: -9 }), mix('ref.wav', {}, { lufs: -11.5 }));
  assert.match(loud.suggestions.find((s) => s.startsWith('The mix is')), /lower the mix by 2.5 LU/);
  const hot = compareAnalyses(mix('mix.wav', {}, { truePeak: 0.4 }), mix('ref.wav', {}, { truePeak: -1 }));
  assert.match(hot.suggestions.find((s) => s.startsWith('True peak')), /0.4 dBTP \(reference -1 dBTP\).*limiter ceiling to -1 dBTP/);
  const headroom = compareAnalyses(mix('mix.wav', {}, { truePeak: -6 }), mix('ref.wav', {}, { truePeak: -1.2 }));
  assert.match(headroom.suggestions.find((s) => s.startsWith('True peak')), /4.8 dB lower than the reference/);
  const wide = compareAnalyses(mix('mix.wav', {}, { lra: 9 }), mix('ref.wav', {}, { lra: 5 }));
  assert.match(wide.suggestions.find((s) => s.startsWith('The loudness range')), /4 LU wider/);
  const narrow = compareAnalyses(mix('mix.wav', {}, { lra: 3 }), mix('ref.wav', {}, { lra: 7 }));
  assert.match(narrow.suggestions.find((s) => s.startsWith('The loudness range')), /4 LU narrower/);
  // Small differences stay quiet.
  assert.deepEqual(compareAnalyses(mix('mix.wav', {}, { lufs: -14.5, lra: 6 }), mix('ref.wav', {}, {})).suggestions, []);
});

test('loudnessMatch on real files: a quieter copy has the same tonal balance', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const quiet = join(root, 'bass_quiet.wav');
  lavfi(quiet, 'sine=frequency=80:duration=3', ['-af', 'volume=0.25', '-ac', '2']);
  const report = await analyzer().compare(quiet, join(folder, 'bass.wav'), { loudnessMatch: true, bands: ['sub', 'bass'] });
  assert.deepEqual(Object.keys(report.deltas.tonalBalanceDb), ['sub', 'bass']);
  assert.ok(Math.abs(report.loudnessMatch.gainDb - 6) < 0.3, JSON.stringify(report.loudnessMatch));
  assert.ok(Math.abs(report.deltas.tonalBalanceDb.bass) < 0.3, JSON.stringify(report.deltas));
  assert.match(report.suggestions.find((s) => s.startsWith('The mix is')), /raise the mix by/);
  await assert.rejects(analyzer().compare(quiet, join(folder, 'bass.wav'), { bands: ['nope'] }), /Unknown band nope/);
});

test('paths: ~ is expanded and relative paths are rejected', async (t) => {
  assert.equal(resolveAudioPath('~/Music/mix.wav'), join(homedir(), 'Music', 'mix.wav'));
  assert.equal(resolveAudioPath('~'), homedir());
  assert.equal(resolveAudioPath('/abs/mix.wav'), '/abs/mix.wav');
  assert.throws(() => resolveAudioPath('Mixdown/mix.wav'), /"Mixdown\/mix\.wav" is relative: give an absolute path .* or one starting with ~\//);
  assert.throws(() => resolveAudioPath('./mix.wav'), /is relative/);
  assert.throws(() => resolveAudioPath('~bob/mix.wav'), /not ~user/);
  assert.throws(() => resolveAudioPath(''), /empty/);
  // Rejected before ffmpeg runs, with the argument named.
  const noFfmpeg = new AudioAnalyzer('/nonexistent/ffmpeg', 'ffprobe');
  await assert.rejects(noFfmpeg.analyzeFile('mix.wav'), /path "mix\.wav" is relative/);
  await assert.rejects(noFfmpeg.analyzeFolder('stems'), /path "stems" is relative/);
  await assert.rejects(noFfmpeg.compare('/abs/mix.wav', 'ref.wav'), /reference "ref\.wav" is relative/);
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const viaTilde = await analyzer().analyzeFile(tilde(join(folder, 'bass.wav')), { bands: false, stereo: false });
  assert.equal(viaTilde.file, join(folder, 'bass.wav'));
  const report = await analyzer().compare(tilde(join(folder, 'bass.wav')), tilde(join(folder, 'kick.wav')), { bands: ['bass'] });
  assert.equal(report.reference.name, 'kick.wav');
  const dir = await analyzer().analyzeFolder(tilde(folder), { include: ['bass.wav'] });
  assert.equal(dir.folder, folder);
});

test('glob patterns match names or relative paths', () => {
  const m = (pattern, path) => globMatcher(pattern)(path);
  assert.ok(m('*.wav', 'Drums/Kick.WAV'));
  assert.ok(!m('*.wav', 'Drums/kick.aif'));
  assert.ok(m('Drums/*', 'Drums/kick.wav'));
  assert.ok(!m('Drums/*', 'Drums/Room/kick.wav'));
  assert.ok(m('Drums/**', 'Drums/Room/kick.wav'));
  assert.ok(m('**/kick.wav', 'kick.wav'));
  assert.ok(m('**/kick.wav', 'a/b/kick.wav'));
  assert.ok(m('./drums/*.wav', 'Drums/snare.wav'));
  assert.ok(m('kick?.wav', 'kick2.wav') && !m('kick?.wav', 'kick12.wav'));
  assert.ok(m('*.{wav,aif}', 'x.aif') && !m('*.{wav,aif}', 'x.flac'));
  assert.ok(m('[ab]*.wav', 'bass.wav') && m('[!ab]*.wav', 'kick.wav') && !m('[!ab]*.wav', 'bass.wav'));
  assert.ok(m('Vox (Lead).wav', 'vox (lead).wav') && !m('a.wav', 'abwav'));
});

/** dir/A/kick.wav, dir/B/kick.wav, dir/Drums/snare.wav, dir/Drums/Room/room.wav, dir/top.wav and dir/x.flac. */
function nestedFolder() {
  const dir = mkdtempSync(join(root, 'nested-'));
  for (const sub of ['A', 'B', join('Drums', 'Room')]) mkdirSync(join(dir, sub), { recursive: true });
  const tone = (path, freq, volume = 0.3) => lavfi(join(dir, path), `sine=frequency=${freq}:duration=1`, ['-af', `volume=${volume}`]);
  tone(join('A', 'kick.wav'), 60);
  tone(join('B', 'kick.wav'), 62, 0.28);
  tone(join('Drums', 'snare.wav'), 200);
  tone(join('Drums', 'Room', 'room.wav'), 300);
  tone('top.wav', 1000);
  tone('x.flac', 1500);
  return dir;
}

test('folder results carry the path relative to the folder', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const dir = nestedFolder();
  const result = await analyzer().analyzeFolder(dir, { recursive: true });
  assert.deepEqual(result.files.map((f) => f.path), ['A/kick.wav', 'B/kick.wav', 'Drums/Room/room.wav', 'Drums/snare.wav', 'top.wav', 'x.flac']);
  assert.deepEqual(result.files.slice(0, 2).map((f) => f.name), ['kick.wav', 'kick.wav']);
  // The two kicks stay apart in the masking report.
  const low = result.masking.conflicts.find((c) => c.stems.includes('A/kick.wav'));
  assert.ok(low?.stems.includes('B/kick.wav'), JSON.stringify(result.masking.conflicts));
  // A relative path excludes one file, a name every file with that name.
  const one = await analyzer().analyzeFolder(dir, { recursive: true, exclude: ['A/kick.wav'], include: ['kick.wav'] });
  assert.deepEqual(one.masking.excluded, ['A/kick.wav']);
  const both = await analyzer().analyzeFolder(dir, { recursive: true, exclude: ['KICK.wav'], include: ['kick.wav'] });
  assert.deepEqual(both.masking.excluded, ['A/kick.wav', 'B/kick.wav']);
  // A flat folder: path is the file name.
  const flat = await analyzer().analyzeFolder(folder);
  assert.ok(flat.files.every((f) => f.path === f.name));
});

test('include, maxFiles and concurrency narrow and order the folder analysis', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const dir = nestedFolder();
  const all = ['A/kick.wav', 'B/kick.wav', 'Drums/Room/room.wav', 'Drums/snare.wav', 'top.wav', 'x.flac'];
  const wavs = await analyzer().analyzeFolder(dir, { recursive: true, include: ['*.wav', 'nothing/*'] });
  assert.deepEqual(wavs.files.map((f) => f.path), all.slice(0, 5));
  assert.deepEqual(wavs.counts, { found: 6, included: 5, analyzed: 5 });
  assert.equal(wavs.leftOut, null);
  assert.deepEqual(wavs.notes, ['include patterns that matched no file: nothing/*.']);
  const drums = await analyzer().analyzeFolder(dir, { recursive: true, include: ['Drums/*'] });
  assert.deepEqual(drums.files.map((f) => f.path), ['Drums/snare.wav']);
  const allDrums = await analyzer().analyzeFolder(dir, { recursive: true, include: ['drums/**'] });
  assert.deepEqual(allDrums.files.map((f) => f.path), ['Drums/Room/room.wav', 'Drums/snare.wav']);
  await assert.rejects(analyzer().analyzeFolder(dir, { include: ['Drums/*'] }), (error) => {
    assert.match(error.message, /No audio file in .* matches include "Drums\/\*" \(2 audio files listed\)/);
    assert.match(error.message, /recursive: true/);
    return true;
  });
  const limited = await analyzer().analyzeFolder(dir, { recursive: true, maxFiles: 2 });
  assert.deepEqual(limited.files.map((f) => f.path), ['A/kick.wav', 'B/kick.wav']);
  assert.deepEqual(limited.counts, { found: 6, included: 6, analyzed: 2 });
  assert.deepEqual(limited.leftOut, { count: 4, maxFiles: 2, files: all.slice(2) });
  assert.match(limited.notes[0], /maxFiles 2: 4 more matching files were not analyzed/);
  // Many files at once still come back in path order, with every progress step reported.
  const events = [];
  const parallel = await analyzer().analyzeFolder(dir, { recursive: true, concurrency: 8, onProgress: (done, total, message) => events.push({ done, total, message }) });
  assert.deepEqual(parallel.files.map((f) => f.path), all);
  assert.deepEqual(events.map((e) => e.done), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(events.every((e) => e.total === 6));
  assert.match(events[0].message, /^Analyzing 6 files in /);
  assert.ok(events.slice(1).every((e) => /^Analyzed \S.* \(\d\/6\)$/.test(e.message)), JSON.stringify(events));
});

test('audio_analyze_folder sends progress notifications when the client asks for them', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not installed');
  const dir = nestedFolder();
  writeFileSync(join(dir, 'broken.wav'), 'not audio');
  const server = new McpServer({ name: 'analysis-test', version: '0.0.0' });
  registerAnalysisTools({ server, analyzer: analyzer() });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const progress = [];
  const raw = await mcp.callTool({ name: 'audio_analyze_folder', arguments: { path: dir, recursive: true, include: ['kick.wav', 'top.wav', 'broken.wav'], concurrency: 3 } }, undefined, {
    onprogress: (p) => progress.push(p),
  });
  assert.ok(!raw.isError, raw.content[0].text);
  const result = JSON.parse(raw.content[0].text);
  assert.deepEqual(result.files.map((f) => [f.name, f.path]), [['kick.wav', 'A/kick.wav'], ['kick.wav', 'B/kick.wav'], ['top.wav', 'top.wav']]);
  assert.deepEqual(result.skipped.map((s) => s.path), ['broken.wav']);
  assert.deepEqual(result.counts, { found: 7, included: 4, analyzed: 4 });
  assert.deepEqual(progress.map((p) => p.progress), [0, 1, 2, 3, 4]);
  assert.ok(progress.every((p) => p.total === 4));
  assert.ok(progress.some((p) => /^Skipped broken\.wav: /.test(p.message)), JSON.stringify(progress));
  // Without a progressToken the tool works the same and sends nothing.
  const quiet = await mcp.callTool({ name: 'audio_analyze_folder', arguments: { path: dir, include: ['top.wav'] } });
  assert.deepEqual(JSON.parse(quiet.content[0].text).files.map((f) => f.path), ['top.wav']);
  const relativePath = await mcp.callTool({ name: 'audio_analyze_folder', arguments: { path: 'stems' } });
  assert.equal(relativePath.isError, true);
  assert.match(relativePath.content[0].text, /is relative: give an absolute path/);
  const compare = await mcp.callTool({
    name: 'audio_compare_to_reference',
    arguments: { target: join(dir, 'top.wav'), reference: join(dir, 'A', 'kick.wav'), loudnessMatch: true, bands: ['mid'], maxSuggestionDb: 4 },
  });
  const report = JSON.parse(compare.content[0].text);
  assert.deepEqual(Object.keys(report.deltas.tonalBalanceDb), ['mid']);
  assert.equal(report.deltas.tonalBasis, 'loudness');
  assert.equal(typeof report.loudnessMatch.gainDb, 'number');
  assert.equal(typeof report.reference.lra, 'number');
  await mcp.close();
});
