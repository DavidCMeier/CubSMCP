/**
 * Helpers to turn Cubase display strings ("-6.02" dB, "L32", "1.20" kHz, "-oo") into numbers.
 */

export interface ParsedDisplay {
  value: number;
  unit: string;
}

const NEGATIVE_INFINITY_TOKENS = ['-oo', '-∞', '-inf', '-infinity', 'off'];

export function parseDisplay(display: string | null | undefined, units?: string | null): ParsedDisplay | null {
  if (display === null || display === undefined) return null;
  const text = String(display).trim();
  const unit = (units ?? '').trim();
  if (text === '') return null;
  const lower = text.toLowerCase();

  // "-oo", "-oodB", "-∞ dB": minus infinity with or without a unit suffix.
  const bare = lower.replace(/\s*(db|dbfs)$/, '');
  if (NEGATIVE_INFINITY_TOKENS.includes(lower) || NEGATIVE_INFINITY_TOKENS.includes(bare)) {
    return { value: Number.NEGATIVE_INFINITY, unit: unit || 'dB' };
  }

  // Pan: "L32", "R100", "C", "<C>", "Center".
  const pan = /^(l|r)\s*(\d+(?:[.,]\d+)?)$/i.exec(text);
  if (pan) {
    const amount = Number(pan[2].replace(',', '.'));
    return { value: pan[1].toLowerCase() === 'l' ? -amount : amount, unit: 'pan' };
  }
  // Cubase shows the pan extremes as a bare "L" / "R" (hard left / right).
  if (/^(l|r)$/i.test(text)) {
    return { value: lower === 'l' ? -100 : 100, unit: 'pan' };
  }
  if (/^<?\s*c(enter)?\s*>?$/i.test(text)) {
    return { value: 0, unit: 'pan' };
  }

  const match = /([-+]?\d+(?:[.,]\d+)?)\s*(k)?/i.exec(text);
  if (!match) return null;
  let value = Number(match[1].replace(',', '.'));
  const inlineKilo = Boolean(match[2]);
  const unitLower = unit.toLowerCase();
  if (inlineKilo || unitLower === 'khz') {
    value *= 1000;
    return { value, unit: 'Hz' };
  }
  if (/khz/i.test(text)) {
    return { value: value * 1000, unit: 'Hz' };
  }
  return { value, unit: unit || inferUnit(text) };
}

function inferUnit(text: string): string {
  if (/db/i.test(text)) return 'dB';
  if (/hz/i.test(text)) return 'Hz';
  if (/ms/i.test(text)) return 'ms';
  if (/%/.test(text)) return '%';
  return '';
}

/** Default tolerance for a target value in a given unit. */
export function defaultTolerance(target: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === 'db') return 0.15;
  if (u === 'hz') return Math.max(1, Math.abs(target) * 0.01);
  if (u === 'pan') return 0.6;
  if (u === 'ms') return Math.max(0.1, Math.abs(target) * 0.02);
  if (u === '%') return 0.6;
  return Math.max(0.01, Math.abs(target) * 0.01);
}

/** Words Cubase (and plugins) show for a switch, in English and Spanish: "On"/"Off", "Activ."/"Desact."... */
const SWITCH_ON = /^(on|activ\.?|activado|activo|active|enabled|ein|an)$/i;
const SWITCH_OFF = /^(off|desact\.?|desactivado|inactivo|inactive|disabled|aus)$/i;

/** true/false when a display is a switch word ("On", "Off", "Activ.", "Desact."...), null otherwise. */
export function parseSwitch(display: string | null | undefined): boolean | null {
  const text = String(display ?? '').trim();
  if (SWITCH_ON.test(text)) return true;
  if (SWITCH_OFF.test(text)) return false;
  return null;
}

/**
 * Smallest step the display can show, in parsed units ("-3.14" dB -> 0.01, "1.20" kHz -> 10 Hz, "L32" -> 1).
 * null when the display has no number ("-oo", "C" has 1: pan moves in whole steps).
 */
export function displayResolution(display: string | null | undefined, units?: string | null): number | null {
  const parsed = parseDisplay(display, units);
  if (!parsed || !Number.isFinite(parsed.value)) return null;
  if (parsed.unit === 'pan') return 1;
  const number = /[-+]?\d+(?:[.,](\d+))?/.exec(String(display));
  if (!number) return null;
  const step = 10 ** -(number[1]?.length ?? 0);
  const kilo = /k/i.test(String(display).slice(number.index + number[0].length)) || (units ?? '').trim().toLowerCase() === 'khz' || /khz/i.test(String(display));
  return kilo ? step * 1000 : step;
}

/**
 * Approximate mapping of a Cubase control from real units to its normalized value: a first guess for the
 * search, so it starts next to the target instead of writing the extremes of a live parameter. The search
 * corrects the guess with what Cubase displays, so it only needs to be close.
 */
export interface ValueCurve {
  unit: string;
  min: number;
  max: number;
  toNormalized(value: number): number;
}

/** Fader and send level: -oo at 0, 0 dB at the 0.789 detent, +6.02 dB at 1 (-120 dB reads at ~0.0008). */
export const FADER_CURVE: ValueCurve = {
  unit: 'dB',
  min: Number.NEGATIVE_INFINITY,
  max: 6.02,
  toNormalized: (db) => (db === Number.NEGATIVE_INFINITY ? 0 : db <= 0 ? 0.7891 * 10 ** (db / 40) : 0.7891 + (0.2109 * Math.min(db, 6.02)) / 6.02),
};

const linear = (unit: string, min: number, max: number): ValueCurve => ({ unit, min, max, toNormalized: (v) => (v - min) / (max - min) });

/** Input gain of the Pre section: -48..+48 dB. */
export const INPUT_GAIN_CURVE = linear('dB', -48, 48);
/** Channel EQ band gain: -24..+24 dB. */
export const EQ_GAIN_CURVE = linear('dB', -24, 24);
/** Pan: L100..R100. */
export const PAN_CURVE = linear('pan', -100, 100);
/** Filter and EQ frequencies: log scale, 20 Hz..20 kHz. */
export const FREQUENCY_CURVE: ValueCurve = {
  unit: 'Hz',
  min: 20,
  max: 20000,
  toNormalized: (hz) => Math.log(Math.max(hz, 1) / 20) / Math.log(1000),
};

/** The curve of a bridge value key, when the server knows it (bank channels and the selected track). */
export function curveForKey(key: string): ValueCurve | undefined {
  if (!/^(ch\.\d+|sel)\./.test(key)) return undefined;
  if (/\.(volume|send\.\d+\.level)$/.test(key)) return FADER_CURVE;
  if (/\.pre\.gain$/.test(key)) return INPUT_GAIN_CURVE;
  if (/\.eq\.\d+\.gain$/.test(key)) return EQ_GAIN_CURVE;
  if (/\.(pre\.(low|high)CutFreq|eq\.\d+\.freq)$/.test(key)) return FREQUENCY_CURVE;
  if (/\.pan$/.test(key)) return PAN_CURVE;
  return undefined;
}

/** Converts a user pan value (-100 = hard left, +100 = hard right) into the "L/C/R" scale Cubase displays. */
export function describePan(value: number): string {
  if (Math.abs(value) < 0.5) return 'C';
  return value < 0 ? `L${Math.round(-value)}` : `R${Math.round(value)}`;
}

/**
 * Converts a channel meter value (mVUMeter, 0..1) to dBFS.
 * Measured against Cubase 13's own meter display: the value is linear amplitude and
 * 1.0 reads +3 dB (0.2647 -> "-8.5", 0.0160 -> "-32.9").
 */
export function meterToDb(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value <= 0) return null;
  return Math.round((20 * Math.log10(value) + 3.01) * 10) / 10;
}

/**
 * Whether Cubase shows what a display write asked for: the same text ("Vintage", "On"), or the same number at
 * the resolution of its display ("-12" for "-12.0 dB", "1 kHz" for "1.00 kHz").
 */
export function displayMatches(requested: string, display: string | null | undefined, units?: string | null): boolean {
  const want = requested.trim().toLowerCase();
  const shown = String(display ?? '').trim().toLowerCase();
  if (shown !== '' && (shown === want || `${shown} ${String(units ?? '').trim().toLowerCase()}`.trim() === want)) return true;
  const target = parseDisplay(requested);
  const actual = parseDisplay(display, units);
  if (!target || !actual) return false;
  if (target.value === actual.value) return true;
  if (!Number.isFinite(target.value) || !Number.isFinite(actual.value)) return false;
  const resolution = displayResolution(display, units) ?? 0;
  return Math.abs(target.value - actual.value) <= Math.max(resolution / 2 + 1e-9, Math.abs(target.value) * 0.005);
}

/** Whether a display text is a number (then a write of it must show that number), not a word of a list. */
export function isNumericDisplay(text: string): boolean {
  const parsed = parseDisplay(text);
  return parsed !== null && /\d|-oo|-∞|-inf/i.test(text);
}

/**
 * Seconds from a transport time as Cubase shows it in seconds format ("0:01:23.000", "1:23.456"); null for
 * other formats (bars and beats, timecode, samples), which depend on the project's primary time format.
 */
export function parseTimeDisplay(display: string | null | undefined): number | null {
  if (display === null || display === undefined) return null;
  const match = /^\s*(-)?(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)\s*$/.exec(String(display));
  if (!match) return null;
  const seconds = Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4].replace(',', '.'));
  return match[1] ? -seconds : seconds;
}

/** A time in seconds as Cubase takes it for the transport time ("0:01:23.000"). */
export function formatTimeDisplay(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(3).padStart(6, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}
