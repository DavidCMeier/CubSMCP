import { z } from 'zod';
import { defineTool, type ToolContext } from './common.js';
import { BANDS, DEFAULT_BAND_FLOOR_DB, DEFAULT_FOLDER_CONCURRENCY, DEFAULT_MAX_SUGGESTION_DB } from '../analysis/audio.js';

const PATH_HELP = 'Absolute path on this Mac; a leading ~/ is expanded to your home folder. Relative paths are rejected.';
const bandName = z.enum(BANDS.map((b) => b.name) as [string, ...string[]]);

export function registerAnalysisTools(ctx: ToolContext): void {
  const { analyzer } = ctx;

  defineTool(
    ctx,
    'audio_check_ffmpeg',
    'Checks that ffmpeg (required) and ffprobe (optional: without it the format is read from ffmpeg) are installed for the audio analysis tools.',
    {},
    async () => ({
      ffmpeg: await analyzer.checkAvailable(),
      ffprobe: (await analyzer.checkFfprobe()) ?? 'not found: install it with ffmpeg or set CUBASE_MCP_FFPROBE.',
    }),
    { readOnly: true },
  );

  defineTool(
    ctx,
    'audio_analyze_file',
    `Analyzes an audio file (mixdown, stem or reference): integrated loudness (LUFS), loudness range, true peak, RMS (mean power of the channels), crest factor, DC offset, stereo width/correlation and tonal balance in bands (${BANDS.map((b) => `${b.name} ${b.low}-${b.high} Hz`).join(', ')}). Active RMS, stereo and bands leave out the silence below -60 dBFS. Digital silence and audio below the -70 LUFS gate are flagged (silent, belowGate) and their values are null.`,
    {
      path: z.string().describe(`The audio file. ${PATH_HELP}`),
      bands: z.boolean().default(true),
      stereo: z.boolean().default(true),
    },
    async ({ path, bands, stereo }) => analyzer.analyzeFile(path, { bands, stereo }),
    { readOnly: true },
  );

  defineTool(
    ctx,
    'audio_analyze_folder',
    'Analyzes the audio files in a folder (e.g. stems exported with File > Export > Audio Mixdown using channel batch export) and reports which stems compete in the same frequency bands (masking). ' +
      'Files are reported with name and path (relative to the folder, so equal names in different subfolders stay apart); the masking report names stems by that path. ' +
      'A mixdown or reference in the folder would top every band: list it in exclude so it is analyzed but left out of the masking report. ' +
      'include and maxFiles narrow what is analyzed (counts, leftOut and notes say what was left out); files that could not be read are listed in skipped with the reason. ' +
      'Sends MCP progress notifications (one per file) when the client gives a progressToken.',
    {
      path: z.string().describe(`The folder. ${PATH_HELP}`),
      recursive: z.boolean().default(false).describe('Also analyze the audio files in subfolders'),
      include: z
        .array(z.string().min(1))
        .default([])
        .describe(
          'Glob patterns, ignoring case; a file is analyzed if it matches any. A pattern without "/" matches the file name in any folder ("*.wav", "kick*"); one with "/" matches the path relative to the folder ("Drums/*" for the files directly in Drums, "Drums/**" for everything below it; subfolders need recursive: true). * and ? stop at "/", ** crosses folders, [abc] and {wav,aif} work too. Empty: every audio file.',
        ),
      maxFiles: z.number().int().min(1).optional().describe('Analyze at most this many files, in path order after include; the rest are listed in leftOut'),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(DEFAULT_FOLDER_CONCURRENCY)
        .describe('Files analyzed at the same time (each runs up to 4 ffmpeg processes)'),
      windowDb: z.number().min(0).max(24).default(6).describe('Stems within this many dB of each other in a band count as a conflict'),
      floorDb: z.number().max(0).default(-45).describe('Band RMS (dBFS) below which a stem is ignored for masking'),
      exclude: z
        .array(z.string())
        .default([])
        .describe('Files to analyze but leave out of the masking report, e.g. the mixdown: a file name (every file with that name), a path relative to the folder, or an absolute path'),
    },
    async ({ path, recursive, include, maxFiles, concurrency, windowDb, floorDb, exclude }, extra) => {
      const result = await analyzer.analyzeFolder(path, {
        recursive,
        include,
        maxFiles,
        concurrency,
        windowDb,
        floorDb,
        exclude,
        onProgress: (done, total, message) => extra.progress(done, total, message),
      });
      return {
        folder: result.folder,
        counts: result.counts,
        ...(result.leftOut ? { leftOut: result.leftOut } : {}),
        ...(result.notes.length > 0 ? { notes: result.notes } : {}),
        masking: result.masking,
        files: result.files.map((f) => ({
          name: f.name,
          path: f.path,
          integratedLufs: f.integratedLufs,
          truePeakDbtp: f.truePeakDbtp,
          peakDbfs: f.peakDbfs,
          activeRmsDbfs: f.activeRmsDbfs,
          crestFactorDb: f.crestFactorDb,
          dcOffset: f.dcOffset,
          silent: f.silent,
          sideToMidDb: f.stereo?.sideToMidDb ?? null,
          bands: Object.fromEntries(BANDS.filter((b) => b.name in f.bands).map((b) => [b.name, f.bands[b.name].relativeDb])),
          warnings: f.warnings,
        })),
        skipped: result.skipped,
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'audio_compare_to_reference',
    'Compares a mix against a reference track: loudness (and how many LU to raise or lower the mix), true peak, loudness range, dynamics, stereo width and tonal balance per band, with EQ/dynamics suggestions. ' +
      "By default each band is measured relative to its file's active RMS; with loudnessMatch the bands are compared after matching integrated loudness, and the gain applied to the target is reported in loudnessMatch. " +
      'Band suggestions propose half the difference, capped at maxSuggestionDb; a band of the mix at or below bandFloorDb relative to its active RMS counts as empty (emptyBands) and gets no boost suggestion. ' +
      'If either file is silent or below the -70 LUFS gate, the deltas are null and the only suggestion says why.',
    {
      target: z.string().describe(`Your mixdown. ${PATH_HELP}`),
      reference: z.string().describe(`Reference track. ${PATH_HELP}`),
      loudnessMatch: z.boolean().default(false).describe('Compare tonal balance after matching integrated loudness (reports the gain used) instead of relative to each file\'s active RMS'),
      bands: z.array(bandName).min(1).optional().describe('Bands to compare (default: all)'),
      maxSuggestionDb: z.number().min(0.5).max(24).default(DEFAULT_MAX_SUGGESTION_DB).describe('Largest EQ change a band suggestion proposes, in dB'),
      bandFloorDb: z
        .number()
        .min(-120)
        .max(0)
        .default(DEFAULT_BAND_FLOOR_DB)
        .describe('A band this many dB or more below its file\'s active RMS counts as empty: no boost is suggested where the mix is empty'),
    },
    async ({ target, reference, loudnessMatch, bands, maxSuggestionDb, bandFloorDb }) => {
      const report = await analyzer.compare(target, reference, { loudnessMatch, bands, maxSuggestionDb, bandFloorDb });
      const side = (a: typeof report.target) => ({
        lufs: a.integratedLufs,
        truePeak: a.truePeakDbtp,
        lra: a.loudnessRangeLu,
        crest: a.crestFactorDb,
        warnings: a.warnings,
      });
      return {
        deltas: report.deltas,
        loudnessMatch: report.loudnessMatch,
        emptyBands: report.emptyBands,
        suggestions: report.suggestions,
        target: side(report.target),
        reference: side(report.reference),
      };
    },
    { readOnly: true },
  );
}
