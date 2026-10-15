/**
 * SysEx framing shared with the Cubase MIDI Remote script.
 *
 * Frame layout:
 *   F0 7D 4D <version> <kind> <idHi> <idLo> <chunkHi> <chunkLo> <countHi> <countLo> <ascii payload...> F7
 *
 * The payload is ASCII-only JSON (non-ASCII characters are escaped as \uXXXX) so every byte is 7-bit safe.
 */

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
export const MANUFACTURER_ID = 0x7d;
export const PROTOCOL_TAG = 0x4d;
export const PROTOCOL_VERSION = 0x01;
export const HEADER_BYTES = 10;
export const DEFAULT_CHUNK_SIZE = 192;
export const MAX_ID = 16384;

export enum MessageKind {
  Request = 1,
  Response = 2,
  Event = 3,
}

export interface Frame {
  kind: MessageKind;
  messageId: number;
  chunkIndex: number;
  chunkCount: number;
  payload: string;
}

export function toAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function split14(value: number): [number, number] {
  return [(value >> 7) & 0x7f, value & 0x7f];
}

function join14(hi: number, lo: number): number {
  return ((hi & 0x7f) << 7) | (lo & 0x7f);
}

export function encodeMessage(kind: MessageKind, messageId: number, value: unknown, chunkSize = DEFAULT_CHUNK_SIZE): number[][] {
  const text = toAsciiJson(value);
  const chunkCount = Math.max(1, Math.ceil(text.length / chunkSize));
  if (chunkCount >= MAX_ID) {
    throw new Error(`Message too large: ${text.length} bytes`);
  }
  const frames: number[][] = [];
  for (let c = 0; c < chunkCount; c++) {
    const bytes = [
      SYSEX_START,
      MANUFACTURER_ID,
      PROTOCOL_TAG,
      PROTOCOL_VERSION,
      kind,
      ...split14(messageId % MAX_ID),
      ...split14(c),
      ...split14(chunkCount),
    ];
    const slice = text.slice(c * chunkSize, (c + 1) * chunkSize);
    for (let i = 0; i < slice.length; i++) {
      bytes.push(slice.charCodeAt(i) & 0x7f);
    }
    bytes.push(SYSEX_END);
    frames.push(bytes);
  }
  return frames;
}

export function decodeFrame(bytes: ArrayLike<number>): Frame | null {
  const offset = bytes[0] === SYSEX_START ? 1 : 0;
  if (bytes.length < offset + HEADER_BYTES) return null;
  if (bytes[offset] !== MANUFACTURER_ID || bytes[offset + 1] !== PROTOCOL_TAG) return null;
  const end = bytes[bytes.length - 1] === SYSEX_END ? bytes.length - 1 : bytes.length;
  let payload = '';
  for (let i = offset + HEADER_BYTES; i < end; i++) {
    payload += String.fromCharCode(bytes[i]);
  }
  return {
    kind: bytes[offset + 3] as MessageKind,
    messageId: join14(bytes[offset + 4], bytes[offset + 5]),
    chunkIndex: join14(bytes[offset + 6], bytes[offset + 7]),
    chunkCount: join14(bytes[offset + 8], bytes[offset + 9]),
    payload,
  };
}

interface PendingMessage {
  parts: string[];
  received: number;
  count: number;
  startedAt: number;
}

/** Reassembles chunked frames into complete JSON messages. */
export class MessageAssembler {
  private readonly pending = new Map<string, PendingMessage>();

  constructor(private readonly staleAfterMs = 10_000) {}

  push(frame: Frame): { kind: MessageKind; value: unknown } | null {
    const key = `${frame.kind}:${frame.messageId}`;
    let entry = this.pending.get(key);
    if (!entry || frame.chunkIndex === 0) {
      entry = { parts: [], received: 0, count: frame.chunkCount, startedAt: Date.now() };
      this.pending.set(key, entry);
    }
    if (entry.parts[frame.chunkIndex] === undefined) entry.received++;
    entry.parts[frame.chunkIndex] = frame.payload;
    this.evictStale();
    if (entry.received < entry.count) return null;
    this.pending.delete(key);
    return { kind: frame.kind, value: JSON.parse(entry.parts.join('')) };
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.startedAt > this.staleAfterMs) this.pending.delete(key);
    }
  }
}
