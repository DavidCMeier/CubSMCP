import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, basename, isAbsolute, relative, sep } from 'node:path';

/**
 * Offline audio analysis with ffmpeg. This is the "ears" of the MCP: export stems or a mixdown
 * from Cubase, then measure loudness, dynamics, stereo image and tonal balance.
 */

export interface Band {
  name: string;
  low: number;
  high: number;
}

export const BANDS: Band[] = [
  { name: 'sub', low: 20, high: 60 },
  { name: 'bass', low: 60, high: 250 },
  { name: 'lowMid', low: 250, high: 500 },
  { name: 'mid', low: 500, high: 2000 },
  { name: 'highMid', low: 2000, high: 4000 },
  { name: 'presence', low: 4000, high: 6000 },
  { name: 'air', low: 6000, high: 20000 },
];

/**
 * RMS values are the mean power of all channels (not a mono downmix). Values that are not measurements
 * (digital silence, loudness below the -70 LUFS gate) are null, and `silent` / `belowGate` say why.
 */
export interface AudioAnalysis {
  file: string;
  name: string;
  /** Path relative to the analyzed folder, with "/" separators (folder analysis only). */
  path?: string;
  durationSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  peakDbfs: number | null;
  rmsDbfs: number | null;
  activeRmsDbfs: number | null;
  crestFactorDb: number | null;
  /** Largest per-channel DC offset (opposite offsets would cancel in the overall mean). */
  dcOffset: number | null;
  /** No sample above digital silence. */
  silent: boolean;
  /** Integrated loudness at or below the -70 LUFS absolute gate: ebur128 has nothing to measure. */
  belowGate: boolean;
  stereo: { midRmsDb: number | null; sideRmsDb: number | null; sideToMidDb: number | null; correlationApprox: number | null } | null;
  bands: Record<string, { rmsDb: number | null; relativeDb: number | null }>;
  warnings: string[];
}

export interface SkippedFile {
  file: string;
  /** Path relative to the analyzed folder (folder analysis only). */
  path?: string;
  reason: string;
}

export interface FolderOptions {
  recursive?: boolean;
  windowDb?: number;
  floorDb?: number;
  /** File names, paths relative to the folder or absolute paths to analyze but leave out of the masking report. */
  exclude?: string[];
  /** Glob patterns: with a "/" they match the path relative to the folder, without one the file name. */
  include?: string[];
  /** Analyze at most this many files (in listing order); the rest are reported in leftOut. */
  maxFiles?: number;
  /** Files analyzed at the same time (1-8, default 2); each file runs up to 4 ffmpeg processes. */
  concurrency?: number;
  /** Called with 0 before the first file and after every file (analyzed or skipped). */
  onProgress?: (done: number, total: number, message: string) => void | Promise<void>;
}

export interface FolderAnalysis {
  folder: string;
  files: AudioAnalysis[];
  masking: MaskingReport;
  skipped: SkippedFile[];
  /** Audio files listed in the folder, how many passed include, and how many were analyzed (before skips). */
  counts: { found: number; included: number; analyzed: number };
  /** Files that passed include but were beyond maxFiles: not analyzed. */
  leftOut: { count: number; maxFiles: number; files: string[] } | null;
  notes: string[];
}

export interface CompareOptions {
  /** Compare tonal balance after matching integrated loudness instead of relative to each file's active RMS. */
  loudnessMatch?: boolean;
  /** Band names to compare (default: all of BANDS). */
  bands?: string[];
  /** Largest EQ change a band suggestion proposes (default 6 dB). */
  maxSuggestionDb?: number;
  /** A band this many dB or more below the file's active RMS counts as empty: no boost is suggested for it (default -40). */
  bandFloorDb?: number;
}

export const DEFAULT_MAX_SUGGESTION_DB = 6;
export const DEFAULT_BAND_FLOOR_DB = -40;
export const DEFAULT_FOLDER_CONCURRENCY = 2;

const AUDIO_EXTENSIONS = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.ogg', '.caf']);
/**
 * Keeps only the audio above -60 dBFS: trims the leading silence and every gap longer than 0.3 s. The peak
 * detector also sees the digital silence at the end of float exports, which the RMS detector misses.
 */
const SILENCE_FILTER =
  'silenceremove=start_periods=1:start_threshold=-60dB:stop_periods=-1:stop_duration=0.3:stop_threshold=-60dB:detection=peak';
/** Q of the four biquads of an 8th-order Butterworth: each band edge rolls off at 48 dB/octave. */
const BUTTERWORTH8_Q = [0.5098, 0.6013, 0.9, 2.5629];
/** -60 dBFS: below this a DC offset is not worth a warning. */
const DC_WARN = 0.001;
/** -40 dBFS: above this the offset costs real headroom. */
const DC_FIX = 0.01;

export class AudioAnalyzer {
  constructor(
    private readonly ffmpeg: string,
    private readonly ffprobe: string,
    private readonly concurrency = 4,
  ) {}

  async checkAvailable(): Promise<string> {
    try {
      const { stdout } = await run(this.ffmpeg, ['-version']);
      return stdout.split('\n')[0];
    } catch {
      throw new Error('ffmpeg not found. Install it with "brew install ffmpeg" or set CUBASE_MCP_FFMPEG.');
    }
  }

  /** ffprobe is optional (ffmpeg's banner is the fallback), so this returns null instead of throwing. */
  async checkFfprobe(): Promise<string | null> {
    try {
      const { stdout } = await run(this.ffprobe, ['-version']);
      return stdout.split('\n')[0];
    } catch {
      return null;
    }
  }

  async analyzeFile(file: string, options: { bands?: boolean; stereo?: boolean } = {}): Promise<AudioAnalysis> {
    const path = resolveAudioPath(file);
    await this.checkAvailable();
    return this.analyze(path, options);
  }

  private async analyze(file: string, options: { bands?: boolean; stereo?: boolean }): Promise<AudioAnalysis> {
    const warnings: string[] = [];
    const probe = await this.probe(file);
    const tasks: Array<() => Promise<void>> = [];
    const result: AudioAnalysis = {
      file,
      name: basename(file),
      durationSec: probe.duration,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      integratedLufs: null,
      loudnessRangeLu: null,
      truePeakDbtp: null,
      peakDbfs: null,
      rmsDbfs: null,
      activeRmsDbfs: null,
      crestFactorDb: null,
      dcOffset: null,
      silent: false,
      belowGate: false,
      stereo: null,
      bands: {},
      warnings,
    };
    if (probe.error) {
      warnings.push(
        probe.channels !== null
          ? `ffprobe failed (${probe.error}): duration, sample rate and channels were read from ffmpeg instead.`
          : `ffprobe failed (${probe.error}) and ffmpeg did not report the format either.`,
      );
    }

    tasks.push(async () => {
      const r128 = await this.loudness(file);
      result.integratedLufs = r128.integrated;
      result.loudnessRangeLu = r128.range;
      result.truePeakDbtp = r128.truePeak;
    });
    tasks.push(async () => {
      const stats = await this.astats(file);
      result.peakDbfs = stats.peak;
      result.rmsDbfs = stats.rms;
      result.crestFactorDb = stats.crestDb;
      result.dcOffset = stats.dcOffset;
    });
    // The gate runs before any filter, so active RMS, mid/side and bands all measure the same stretch of audio.
    tasks.push(async () => {
      const stats = await this.astats(file, SILENCE_FILTER);
      result.activeRmsDbfs = stats.rms;
    });
    if (options.stereo !== false && probe.channels === null) {
      // Assuming mono would hide stereo problems such as a polarity-flipped side.
      warnings.push('Channel count unknown: stereo analysis skipped.');
    } else if (options.stereo !== false && probe.channels !== null && probe.channels >= 2) {
      tasks.push(async () => {
        const mid = await this.astats(file, `${SILENCE_FILTER},pan=mono|c0=0.5*c0+0.5*c1`);
        const side = await this.astats(file, `${SILENCE_FILTER},pan=mono|c0=0.5*c0-0.5*c1`);
        const midDb = mid.rms;
        const sideDb = side.rms;
        let correlation: number | null = null;
        if (midDb !== null && sideDb !== null) {
          // Either side may be -inf (pure mono or pure antiphase); both -inf means there was nothing to measure.
          const m2 = Math.pow(10, midDb / 10);
          const s2 = Math.pow(10, sideDb / 10);
          if (m2 + s2 > 0) correlation = round((m2 - s2) / (m2 + s2), 3);
        }
        result.stereo = {
          midRmsDb: midDb,
          sideRmsDb: sideDb,
          sideToMidDb: midDb !== null && sideDb !== null ? round(sideDb - midDb, 1) : null,
          correlationApprox: correlation,
        };
      });
    }
    if (options.bands !== false) {
      const nyquist = probe.sampleRate !== null ? probe.sampleRate / 2 : null;
      for (const band of BANDS) {
        // Created up front so the keys keep the low-to-high order of BANDS whatever task finishes first.
        const entry = (result.bands[band.name] = { rmsDb: null as number | null, relativeDb: null as number | null });
        if (nyquist !== null && band.low >= nyquist) continue;
        tasks.push(async () => {
          const edges = [...BUTTERWORTH8_Q.map((q) => `highpass=f=${band.low}:width_type=q:width=${q}:precision=f64`)];
          // A low-pass at or above Nyquist is unstable; the file has no content up there anyway.
          if (nyquist === null || band.high < nyquist * 0.9) {
            edges.push(...BUTTERWORTH8_Q.map((q) => `lowpass=f=${band.high}:width_type=q:width=${q}:precision=f64`));
          }
          const stats = await this.astats(file, [SILENCE_FILTER, ...edges].join(','));
          entry.rmsDb = stats.rms;
        });
      }
    }

    await runLimited(tasks, this.concurrency);

    result.silent = result.peakDbfs === Number.NEGATIVE_INFINITY;
    result.belowGate = result.integratedLufs !== null && result.integratedLufs <= -70;
    if (result.belowGate) {
      // ebur128 prints "I: -70.0 LUFS" and "LRA: 0.0 LU" when no block passes the gate: they are not measurements.
      result.integratedLufs = null;
      result.loudnessRangeLu = null;
    }
    if (finite(result.activeRmsDbfs) !== null) {
      for (const band of BANDS) {
        const entry = result.bands[band.name];
        if (entry && finite(entry.rmsDb) !== null) entry.relativeDb = round(entry.rmsDb! - result.activeRmsDbfs!, 1);
      }
    }
    finiteFields(result);
    if (result.stereo) finiteFields(result.stereo);
    for (const entry of Object.values(result.bands)) finiteFields(entry);

    if (result.silent) {
      warnings.push('Digital silence: the file has no signal, so loudness, levels, stereo and bands are null.');
    } else if (result.belowGate) {
      warnings.push('Integrated loudness is below the -70 LUFS gate: integratedLufs and loudnessRangeLu are null.');
    } else if (result.activeRmsDbfs === null && result.peakDbfs !== null && result.peakDbfs < -60) {
      warnings.push('The signal never rises above -60 dBFS: active RMS and bands are null.');
    }
    if (result.truePeakDbtp !== null && result.truePeakDbtp > -1) warnings.push('True peak above -1 dBTP: risk of clipping after encoding.');
    if (result.peakDbfs !== null && result.peakDbfs >= -0.1) warnings.push('Sample peak at or above 0 dBFS: likely clipping.');
    if (result.dcOffset !== null && Math.abs(result.dcOffset) > DC_WARN) {
      const db = round(20 * Math.log10(Math.abs(result.dcOffset)), 1);
      const fix = Math.abs(result.dcOffset) > DC_FIX ? ' Remove it with a DC filter or a 20 Hz high-pass.' : '';
      warnings.push(`Noticeable DC offset: ${result.dcOffset.toFixed(4)} (${db} dBFS).${fix}`);
    }
    if (result.stereo?.correlationApprox !== null && result.stereo?.correlationApprox !== undefined && result.stereo.correlationApprox < 0) {
      warnings.push('Negative stereo correlation: mono compatibility problems.');
    }
    return result;
  }

  async analyzeFolder(folderPath: string, options: FolderOptions = {}): Promise<FolderAnalysis> {
    const folder = resolveAudioPath(folderPath);
    const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? DEFAULT_FOLDER_CONCURRENCY)));
    const include = options.include ?? [];
    // Checked once: without ffmpeg every file would fail and the real cause would hide behind "no readable files".
    await this.checkAvailable();
    const skipped: SkippedFile[] = [];
    const rel = (file: string) => relative(folder, file).split(sep).join('/');
    const listed = await listAudioFiles(folder, options.recursive ?? false, skipped);
    for (const s of skipped) s.path = rel(s.file);
    if (listed.length === 0) throw new Error(`No audio files found in ${folder}${describeSkipped(skipped)}`);
    const notes: string[] = [];
    let included = listed;
    if (include.length > 0) {
      const matchers = include.map((pattern) => ({ pattern, test: globMatcher(pattern), used: false }));
      included = listed.filter((file) => {
        const hits = matchers.filter((m) => m.test(rel(file)));
        for (const m of hits) m.used = true;
        return hits.length > 0;
      });
      const unused = matchers.filter((m) => !m.used).map((m) => m.pattern);
      const subfolderHint =
        !options.recursive && include.some((p) => p.includes('/')) ? ' Patterns with "/" match files in subfolders, which are only listed with recursive: true.' : '';
      if (included.length === 0) {
        throw new Error(`No audio file in ${folder} matches include ${include.map((p) => `"${p}"`).join(', ')} (${listed.length} audio files listed).${subfolderHint}`);
      }
      if (unused.length > 0) notes.push(`include patterns that matched no file: ${unused.join(', ')}.${subfolderHint}`);
    }
    const maxFiles = options.maxFiles;
    const selected = maxFiles !== undefined ? included.slice(0, maxFiles) : included;
    const rest = included.slice(selected.length);
    const leftOut = rest.length > 0 && maxFiles !== undefined ? { count: rest.length, maxFiles, files: rest.map(rel) } : null;
    if (leftOut) notes.push(`maxFiles ${maxFiles}: ${leftOut.count} more matching file${leftOut.count === 1 ? ' was' : 's were'} not analyzed (see leftOut).`);

    const total = selected.length;
    const results: Array<AudioAnalysis | null> = new Array(total).fill(null);
    let done = 0;
    await options.onProgress?.(0, total, `Analyzing ${total} file${total === 1 ? '' : 's'} in ${folder}`);
    const tasks = selected.map((file, index) => async () => {
      let message: string;
      // One broken file (e.g. an empty WAV left by an aborted export) must not abort the whole folder.
      try {
        const analysis = await this.analyze(file, { stereo: true, bands: true });
        analysis.path = rel(file);
        results[index] = analysis;
        message = `Analyzed ${rel(file)}`;
      } catch (error) {
        skipped.push({ file, path: rel(file), reason: errorMessage(error) });
        message = `Skipped ${rel(file)}: ${errorMessage(error)}`;
      }
      done++;
      await options.onProgress?.(done, total, `${message} (${done}/${total})`);
    });
    await runLimited(tasks, concurrency);
    const analyses = results.filter((a): a is AudioAnalysis => a !== null);
    if (analyses.length === 0) throw new Error(`No readable audio files in ${folder}${describeSkipped(skipped)}`);
    // Files that failed in parallel land in skipped in completion order: path order is easier to read.
    skipped.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const exclude = (options.exclude ?? []).map(expandHome);
    return {
      folder,
      files: analyses,
      masking: maskingReport(analyses, { windowDb: options.windowDb, floorDb: options.floorDb, exclude }),
      skipped,
      counts: { found: listed.length, included: included.length, analyzed: total },
      leftOut,
      notes,
    };
  }

  async compare(target: string, reference: string, options: CompareOptions = {}): Promise<ComparisonReport> {
    const targetPath = resolveAudioPath(target, 'target');
    const referencePath = resolveAudioPath(reference, 'reference');
    // Checked before analyzing, so a bad band name does not cost two analyses.
    selectedBands(options.bands);
    const [t, r] = await Promise.all([this.analyzeFile(targetPath), this.analyzeFile(referencePath)]);
    return compareAnalyses(t, r, options);
  }

  private async probe(file: string): Promise<{ duration: number | null; sampleRate: number | null; channels: number | null; error?: string }> {
    try {
      const { stdout } = await run(this.ffprobe, ['-v', 'error', '-show_entries', 'stream=sample_rate,channels:format=duration', '-of', 'json', file]);
      const json = JSON.parse(stdout) as { streams?: Array<{ sample_rate?: string; channels?: number }>; format?: { duration?: string } };
      const stream = json.streams?.[0];
      return {
        duration: json.format?.duration ? round(Number(json.format.duration), 2) : null,
        sampleRate: stream?.sample_rate ? Number(stream.sample_rate) : null,
        channels: stream?.channels ?? null,
      };
    } catch (error) {
      const reason = errorMessage(error);
      try {
        // Without the null output ffmpeg exits with code 1 ("at least one output file") and run() keeps only the stderr tail.
        const { stderr } = await run(this.ffmpeg, ['-hide_banner', '-i', file, '-t', '0', '-f', 'null', '-']);
        return { ...parseFfmpegFormat(stderr), error: reason };
      } catch {
        return { duration: null, sampleRate: null, channels: null, error: reason };
      }
    }
  }

  private async loudness(file: string): Promise<{ integrated: number | null; range: number | null; truePeak: number | null }> {
    const { stderr } = await run(this.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    return {
      integrated: matchNumber(summary, /I:\s+(-?[\d.]+|-inf)\s+LUFS/),
      range: matchNumber(summary, /LRA:\s+(-?[\d.]+)\s+LU/),
      truePeak: matchNumber(summary, /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
    };
  }

  private async astats(file: string, preFilter?: string) {
    const filter = (preFilter ? `${preFilter},` : '') + 'astats=metadata=0:reset=0';
    const { stderr } = await run(this.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', filter, '-f', 'null', '-']);
    return parseAstats(stderr);
  }
}

/**
 * Reads astats' log: one block per channel, then "Overall". Without an "Overall" block no audio reached astats
 * (e.g. the silence gate removed everything) and every value is null.
 */
export function parseAstats(stderr: string): { peak: number | null; rms: number | null; crestDb: number | null; dcOffset: number | null } {
  const overallIndex = stderr.lastIndexOf('Overall');
  if (overallIndex < 0) return { peak: null, rms: null, crestDb: null, dcOffset: null };
  const overall = stderr.slice(overallIndex);
  const channels = stderr.slice(0, overallIndex).split(/Channel: \d+/).slice(1);
  const peak = matchNumber(overall, /Peak level dB:\s+(-?[\d.]+|-inf)/);
  const rms = matchNumber(overall, /RMS level dB:\s+(-?[\d.]+|-inf)/);
  // ffmpeg prints "Crest factor" only per channel. The largest one keeps a panned stem from being judged by its
  // silent side (which reports 1); peak - RMS of Overall is the fallback, about 3 dB high with one silent channel.
  const crests = channels.map((c) => matchNumber(c, /Crest factor:\s+([\d.]+)/, 6)).filter((v): v is number => v !== null && v > 1);
  const crestDb = crests.length > 0 ? toDb(Math.max(...crests)) : finite(peak !== null && rms !== null ? round(peak - rms, 1) : null);
  // Six decimals, as astats prints them: rounding to 0.01 first would hide every offset below 0.005.
  const offsets = channels.map((c) => matchNumber(c, /DC offset:\s+(-?[\d.]+)/, 6)).filter((v): v is number => v !== null);
  const dcOffset = offsets.length > 0 ? offsets.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : matchNumber(overall, /DC offset:\s+(-?[\d.]+)/, 6);
  return { peak, rms, crestDb, dcOffset };
}

/** Reads duration, sample rate and channel count from the input section of ffmpeg's banner (the ffprobe fallback). */
export function parseFfmpegFormat(stderr: string): { duration: number | null; sampleRate: number | null; channels: number | null } {
  const outputIndex = stderr.indexOf('Output #');
  const input = outputIndex >= 0 ? stderr.slice(0, outputIndex) : stderr;
  const duration = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(input);
  const audio = /Stream #\d+:\d+[^\n]*?: Audio: [^\n]*?, (\d+) Hz, ([^,\n]+)/.exec(input);
  return {
    duration: duration ? round(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]), 2) : null,
    sampleRate: audio ? Number(audio[1]) : null,
    channels: audio ? layoutChannels(audio[2].trim()) : null,
  };
}

function layoutChannels(layout: string): number | null {
  const base = layout.replace(/\(.*\)$/, '');
  const named: Record<string, number> = { mono: 1, stereo: 2, quad: 4, hexagonal: 6, octagonal: 8, downmix: 2 };
  if (base in named) return named[base];
  const count = /^(\d+) channels$/.exec(base);
  if (count) return Number(count[1]);
  // "5.1", "7.1.4": the parts add up to the channel count.
  if (/^\d+(\.\d+)+$/.test(base)) return base.split('.').reduce((sum, part) => sum + Number(part), 0);
  return null;
}

/** Stems are named by their path relative to the analyzed folder (the file name for a flat folder). */
export interface MaskingReport {
  bands: Record<string, Array<{ name: string; rmsDb: number }>>;
  conflicts: Array<{ band: string; stems: string[]; spreadDb: number }>;
  excluded: string[];
  notes: string[];
}

/** Flags bands where several stems carry similar energy: candidates for EQ carving or arrangement changes. */
export function maskingReport(analyses: AudioAnalysis[], options: { windowDb?: number; floorDb?: number; exclude?: string[] } = {}): MaskingReport {
  const windowDb = options.windowDb ?? 6;
  const floorDb = options.floorDb ?? -45;
  const exclude = options.exclude ?? [];
  // A name matches every file with that name (in any subfolder); a relative or absolute path matches one file.
  const isExcluded = (a: AudioAnalysis, x: string) =>
    x === a.file ||
    x.toLowerCase() === a.name.toLowerCase() ||
    (a.path !== undefined && x.replace(/^\.\//, '').toLowerCase() === a.path.toLowerCase());
  const excluded = analyses.filter((a) => exclude.some((x) => isExcluded(a, x)));
  const stems = analyses.filter((a) => !excluded.includes(a));
  const bands: MaskingReport['bands'] = {};
  const conflicts: MaskingReport['conflicts'] = [];
  for (const band of BANDS) {
    const entries = stems
      .map((a) => ({ name: stemLabel(a), rmsDb: a.bands[band.name]?.rmsDb ?? null }))
      .filter((e): e is { name: string; rmsDb: number } => e.rmsDb !== null && e.rmsDb > floorDb)
      .sort((x, y) => y.rmsDb - x.rmsDb);
    bands[band.name] = entries.map((e) => ({ name: e.name, rmsDb: round(e.rmsDb, 1) }));
    // Every maximal run of stems within windowDb of each other, so two similar stems under a louder one still meet.
    let lastEnd = -1;
    for (let i = 0; i < entries.length; i++) {
      let end = i;
      while (end + 1 < entries.length && entries[i].rmsDb - entries[end + 1].rmsDb <= windowDb) end++;
      if (end > i && end > lastEnd) {
        conflicts.push({ band: band.name, stems: entries.slice(i, end + 1).map((e) => e.name), spreadDb: round(entries[i].rmsDb - entries[end].rmsDb, 1) });
      }
      lastEnd = Math.max(lastEnd, end);
    }
  }
  const notes = [
    `A conflict is a group of two or more stems within ${windowDb} dB of each other in that band (above ${floorDb} dBFS RMS on active audio).`,
    'Typical fixes: cut the less important stem in that band, sidechain dynamic EQ, or pan them apart.',
  ];
  const unmatched = exclude.filter((x) => !analyses.some((a) => isExcluded(a, x)));
  if (unmatched.length > 0) notes.push(`exclude entries that matched no file: ${unmatched.join(', ')}.`);
  return { bands, conflicts, excluded: excluded.map(stemLabel), notes };
}

/** Stems are named by their path relative to the folder, so equal names in different subfolders stay apart. */
function stemLabel(a: AudioAnalysis): string {
  return a.path ?? a.name;
}

export interface ComparisonReport {
  target: AudioAnalysis;
  reference: AudioAnalysis;
  deltas: {
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    crestFactorDb: number | null;
    loudnessRangeLu: number | null;
    sideToMidDb: number | null;
    /** "activeRms": each band relative to its file's active RMS; "loudness": band RMS after matching integrated loudness. */
    tonalBasis: 'activeRms' | 'loudness';
    /** Target minus reference, for the compared bands only. */
    tonalBalanceDb: Record<string, number | null>;
  };
  /** With loudnessMatch: the gain applied to the target to reach the reference's integrated loudness. Null otherwise. */
  loudnessMatch: { gainDb: number; targetLufs: number; referenceLufs: number; targetTruePeakAfterGainDbtp: number | null } | null;
  /** Compared bands at or below floorDb relative to their file's active RMS: no boost is suggested where the target is empty. */
  emptyBands: { floorDb: number; target: string[]; reference: string[] };
  suggestions: string[];
}

/** Below this a tonal difference is not worth a suggestion. */
const BAND_SUGGEST_DB = 1.5;
/** Integrated loudness difference worth a raise/lower suggestion. */
const LUFS_SUGGEST_LU = 1;
/** Above this true peak can clip after lossy encoding. */
const TRUE_PEAK_CEILING = -1;
const TRUE_PEAK_SUGGEST_DB = 1.5;
const LRA_SUGGEST_LU = 2;

/** The bands to compare, in BANDS order. Throws on an unknown name or an empty list. */
export function selectedBands(names: string[] | undefined): Band[] {
  if (names === undefined) return BANDS;
  const unknown = names.filter((n) => !BANDS.some((b) => b.name === n));
  if (unknown.length > 0) throw new Error(`Unknown band ${unknown.join(', ')}: use ${BANDS.map((b) => b.name).join(', ')}.`);
  if (names.length === 0) throw new Error('bands is empty: leave it out to compare every band.');
  return BANDS.filter((b) => names.includes(b.name));
}

export function compareAnalyses(target: AudioAnalysis, reference: AudioAnalysis, options: CompareOptions = {}): ComparisonReport {
  const bands = selectedBands(options.bands);
  const maxSuggestion = options.maxSuggestionDb ?? DEFAULT_MAX_SUGGESTION_DB;
  const floorDb = options.bandFloorDb ?? DEFAULT_BAND_FLOOR_DB;
  const diff = (a: number | null, b: number | null) => (finite(a) !== null && finite(b) !== null ? round(a! - b!, 1) : null);
  const tonal: Record<string, number | null> = {};
  const suggestions: string[] = [];
  const unusable = (
    [
      ['target', target],
      ['reference', reference],
    ] as const
  )
    .filter(([, a]) => a.silent || a.belowGate)
    .map(([role, a]) => `the ${role} (${a.name}) is ${a.silent ? 'digital silence' : 'below the -70 LUFS gate'}`);
  if (unusable.length > 0) {
    // Any delta against silence would be a meaningless number (e.g. -53 LU against the -70 LUFS sentinel).
    for (const band of bands) tonal[band.name] = null;
    return {
      target,
      reference,
      deltas: {
        integratedLufs: null,
        truePeakDbtp: null,
        crestFactorDb: null,
        loudnessRangeLu: null,
        sideToMidDb: null,
        tonalBasis: options.loudnessMatch ? 'loudness' : 'activeRms',
        tonalBalanceDb: tonal,
      },
      loudnessMatch: null,
      emptyBands: { floorDb, target: [], reference: [] },
      suggestions: [`Cannot compare: ${unusable.join(' and ')}.`],
    };
  }

  // Emptiness is judged against the file's own active RMS whatever the basis: a band that is empty stays empty after gain.
  const isEmpty = (a: AudioAnalysis, band: string) => {
    const rel = a.bands[band]?.relativeDb ?? null;
    return rel !== null && rel <= floorDb;
  };
  const emptyBands = {
    floorDb,
    target: bands.filter((b) => isEmpty(target, b.name)).map((b) => b.name),
    reference: bands.filter((b) => isEmpty(reference, b.name)).map((b) => b.name),
  };

  const tLufs = finite(target.integratedLufs);
  const rLufs = finite(reference.integratedLufs);
  const tTp = finite(target.truePeakDbtp);
  const rTp = finite(reference.truePeakDbtp);
  let loudnessMatch: ComparisonReport['loudnessMatch'] = null;
  if (options.loudnessMatch) {
    if (tLufs !== null && rLufs !== null) {
      const gainDb = round(rLufs - tLufs, 1);
      loudnessMatch = { gainDb, targetLufs: tLufs, referenceLufs: rLufs, targetTruePeakAfterGainDbtp: tTp !== null ? round(tTp + gainDb, 1) : null };
    } else {
      suggestions.push("Loudness match not possible (integrated loudness missing): bands were compared relative to each file's active RMS instead.");
    }
  }
  const matched = loudnessMatch;
  // Relative to the file's active RMS, or band RMS minus integrated loudness: the same as applying gainDb to the target.
  const bandLevel = (a: AudioAnalysis, band: string): number | null => {
    const entry = a.bands[band];
    if (!entry) return null;
    if (matched === null) return entry.relativeDb;
    const lufsOf = a === target ? matched.targetLufs : matched.referenceLufs;
    return finite(entry.rmsDb) !== null ? entry.rmsDb! - lufsOf : null;
  };
  const basis = matched ? 'at matched loudness' : 'relative to overall level';
  for (const band of bands) {
    const delta = diff(bandLevel(target, band.name), bandLevel(reference, band.name));
    tonal[band.name] = delta;
    if (delta === null || Math.abs(delta) < BAND_SUGGEST_DB) continue;
    const targetEmpty = isEmpty(target, band.name);
    const referenceEmpty = isEmpty(reference, band.name);
    // Both nearly empty: the difference is between two noise floors.
    if (targetEmpty && referenceEmpty) continue;
    const range = `${band.name} (${band.low}-${band.high} Hz)`;
    if (delta < 0 && targetEmpty) {
      suggestions.push(
        `${range} is ${Math.abs(delta)} dB quieter than the reference ${basis}, but the mix has almost nothing there (${target.bands[band.name].relativeDb} dB below its active RMS): EQ cannot boost what is not there, so no boost is suggested. Add an instrument or harmonics (e.g. saturation) in that range if it is wanted.`,
      );
      continue;
    }
    const full = round(Math.abs(delta) / 2, 1);
    const amount = Math.min(full, maxSuggestion);
    const capped = amount < full ? ` (capped at ${maxSuggestion} dB: a gap this large is better fixed in the arrangement or the sources than with EQ)` : '';
    const referenceNote = referenceEmpty ? ' The reference has almost nothing in this band.' : '';
    suggestions.push(
      `${range} is ${Math.abs(delta)} dB ${delta > 0 ? 'louder' : 'quieter'} than the reference ${basis}: consider ${delta > 0 ? 'a cut' : 'a boost'} of about ${amount} dB${capped}.${referenceNote}`,
    );
  }

  const lufs = diff(tLufs, rLufs);
  if (lufs !== null && Math.abs(lufs) >= LUFS_SUGGEST_LU) {
    const amount = Math.abs(lufs);
    const levels = `${tLufs} vs ${rLufs} LUFS`;
    if (lufs < 0) {
      const peakAfter = tTp !== null ? round(tTp + amount, 1) : null;
      const limiter =
        peakAfter !== null && peakAfter > TRUE_PEAK_CEILING
          ? ` With plain gain its true peak would reach ${peakAfter} dBTP: get there with the limiter (more gain into it, ceiling at ${TRUE_PEAK_CEILING} dBTP) rather than with the fader.`
          : '';
      suggestions.push(`The mix is ${amount} LU quieter than the reference (${levels}): raise the mix by ${amount} LU to match it.${limiter}`);
    } else {
      suggestions.push(`The mix is ${amount} LU louder than the reference (${levels}): lower the mix by ${amount} LU to match it.`);
    }
  }

  const tpDelta = diff(tTp, rTp);
  if (tTp !== null && tTp > TRUE_PEAK_CEILING) {
    suggestions.push(
      `True peak of the mix is ${tTp} dBTP${rTp !== null ? ` (reference ${rTp} dBTP)` : ''}: above ${TRUE_PEAK_CEILING} dBTP it can clip after lossy encoding. Set the limiter ceiling to ${TRUE_PEAK_CEILING} dBTP or lower, with true-peak detection on.`,
    );
  } else if (tpDelta !== null && Math.abs(tpDelta) >= TRUE_PEAK_SUGGEST_DB) {
    suggestions.push(
      tpDelta < 0
        ? `True peak of the mix is ${Math.abs(tpDelta)} dB lower than the reference (${tTp} vs ${rTp} dBTP): there is peak headroom left.`
        : `True peak of the mix is ${tpDelta} dB higher than the reference (${tTp} vs ${rTp} dBTP): the reference keeps its peaks lower (a lower limiter ceiling or more peak control).`,
    );
  }

  const lra = diff(target.loudnessRangeLu, reference.loudnessRangeLu);
  if (lra !== null && Math.abs(lra) >= LRA_SUGGEST_LU) {
    const values = `${target.loudnessRangeLu} vs ${reference.loudnessRangeLu} LU`;
    suggestions.push(
      lra > 0
        ? `The loudness range of the mix is ${lra} LU wider than the reference (${values}): its sections vary more in loudness. Ride the quiet and loud sections with level automation, or use gentle bus compression, to approach it.`
        : `The loudness range of the mix is ${Math.abs(lra)} LU narrower than the reference (${values}): it is more even across sections. Ease off bus compression or limiting, or let sections breathe with level automation, to approach it.`,
    );
  }

  const crest = diff(target.crestFactorDb, reference.crestFactorDb);
  if (crest !== null && crest >= 2) suggestions.push('Target is more dynamic (higher crest factor) than the reference: more bus compression or limiting may be needed.');
  if (crest !== null && crest <= -2) suggestions.push('Target is more compressed than the reference: consider backing off compression/limiting.');
  return {
    target,
    reference,
    deltas: {
      integratedLufs: lufs,
      truePeakDbtp: tpDelta,
      crestFactorDb: crest,
      loudnessRangeLu: lra,
      sideToMidDb: diff(target.stereo?.sideToMidDb ?? null, reference.stereo?.sideToMidDb ?? null),
      tonalBasis: matched ? 'loudness' : 'activeRms',
      tonalBalanceDb: tonal,
    },
    loudnessMatch,
    emptyBands,
    suggestions,
  };
}

/**
 * Expands a leading "~" or "~/" to the home folder and rejects relative paths: the server's working directory
 * is wherever the MCP client started it, not the user's project, so resolving against it would pick the wrong file.
 */
export function resolveAudioPath(path: string, what = 'path'): string {
  if (path.length === 0) throw new Error(`${what} is empty: give an absolute path (or one starting with ~/).`);
  if (path.startsWith('~') && path !== '~' && !path.startsWith('~/')) {
    throw new Error(`${what} "${path}": only ~ and ~/ (your home folder) are expanded, not ~user. Give an absolute path.`);
  }
  const expanded = expandHome(path);
  if (!isAbsolute(expanded)) {
    throw new Error(
      `${what} "${path}" is relative: give an absolute path (e.g. /Users/you/Music/mix.wav) or one starting with ~/. Relative paths are not resolved because the server's working directory is not your project.`,
    );
  }
  return expanded;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/**
 * Matches a path relative to the folder ("/" separators) against a glob, ignoring case. A pattern with a "/" matches
 * the whole relative path, one without matches the file name in any folder. "*" and "?" stop at "/", "**" crosses
 * folders ("**" followed by "/" also matches no folder), "[abc]" and "[!abc]" are character classes, "{wav,aif}" alternatives.
 */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
  const clean = pattern.replace(/^\.\//, '');
  const regex = new RegExp(`^${globBody(clean)}$`, 'i');
  if (clean.includes('/')) return (path) => regex.test(path);
  return (path) => regex.test(path.slice(path.lastIndexOf('/') + 1));
}

function globBody(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] !== '*') {
        out += '[^/]*';
      } else if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[' && pattern.indexOf(']', i + 2) > 0) {
      const end = pattern.indexOf(']', i + 2);
      const body = pattern.slice(i + 1, end);
      const negated = body.startsWith('!');
      out += `[${negated ? '^' : ''}${escapeClass(negated ? body.slice(1) : body)}]`;
      i = end;
    } else if (c === '{' && pattern.indexOf('}', i + 1) > 0) {
      const end = pattern.indexOf('}', i + 1);
      out += `(?:${pattern.slice(i + 1, end).split(',').map(globBody).join('|')})`;
      i = end;
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Inside [...] only "\", "]" and "^" are special ("-" keeps its meaning as a range). */
function escapeClass(text: string): string {
  return text.replace(/[\\\]^]/g, '\\$&');
}

/**
 * Lists the audio files of a folder. Entries that cannot be read (dangling symlinks, files deleted while listing,
 * unreadable subfolders) go to `skipped` instead of aborting; only a missing or unreadable root folder throws.
 */
export async function listAudioFiles(folder: string, recursive: boolean, skipped: SkippedFile[] = []): Promise<string[]> {
  const root = await stat(folder);
  // dev:ino of every folder already listed, so a symlink back to a parent cannot loop forever.
  const seen = new Set([`${root.dev}:${root.ino}`]);
  return walk(folder, recursive, seen, skipped);
}

async function walk(folder: string, recursive: boolean, seen: Set<string>, skipped: SkippedFile[]): Promise<string[]> {
  const entries = await readdir(folder);
  const out: string[] = [];
  for (const entry of entries.sort()) {
    const full = join(folder, entry);
    const isAudio = AUDIO_EXTENSIONS.has(extname(entry).toLowerCase());
    let info;
    try {
      info = await stat(full);
    } catch (error) {
      if (isAudio) skipped.push({ file: full, reason: errorMessage(error) });
      continue;
    }
    if (info.isDirectory()) {
      const key = `${info.dev}:${info.ino}`;
      if (!recursive || seen.has(key)) continue;
      seen.add(key);
      try {
        out.push(...(await walk(full, true, seen, skipped)));
      } catch (error) {
        skipped.push({ file: full, reason: errorMessage(error) });
      }
    } else if (info.isFile() && isAudio) {
      out.push(full);
    }
  }
  return out;
}

function describeSkipped(skipped: SkippedFile[]): string {
  return skipped.length > 0 ? `. Skipped: ${skipped.map((s) => `${basename(s.file)} (${s.reason})`).join('; ')}` : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr.split('\n').slice(-5).join(' ').trim() || error.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      await tasks[index]();
    }
  });
  await Promise.all(workers);
}

function matchNumber(text: string, regex: RegExp, digits = 2): number | null {
  const match = regex.exec(text);
  if (!match) return null;
  if (match[1] === '-inf') return Number.NEGATIVE_INFINITY;
  const value = Number(match[1]);
  return Number.isFinite(value) ? round(value, digits) : null;
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

/** -inf levels are kept while measuring (they mark silence) but reported as null: JSON has no -Infinity. */
function finiteFields(object: object): void {
  const record = object as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && !Number.isFinite(value)) record[key] = null;
  }
}

function toDb(ratio: number | null): number | null {
  if (ratio === null || ratio <= 0) return null;
  return round(20 * Math.log10(ratio), 1);
}

function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}
