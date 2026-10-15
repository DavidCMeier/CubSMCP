import { EventEmitter } from 'node:events';
import { decodeFrame, encodeMessage, MessageAssembler, MessageKind, MAX_ID } from './protocol.js';
import type { Config } from '../config.js';

/** Minimal byte transport so the bridge can run over real MIDI ports or an in-memory loopback in tests. */
export interface SysexTransport {
  open(onMessage: (bytes: number[]) => void): Promise<void>;
  send(bytes: number[]): void;
  close(): void;
  describe(): string;
}

interface MidiModule {
  Input: new () => MidiInputPort;
  Output: new () => MidiOutputPort;
}

interface MidiInputPort {
  getPortCount(): number;
  getPortName(index: number): string;
  openPort(index: number): void;
  openVirtualPort(name: string): void;
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  on(event: 'message', listener: (deltaTime: number, message: number[]) => void): void;
  closePort(): void;
}

interface MidiOutputPort {
  getPortCount(): number;
  getPortName(index: number): string;
  openPort(index: number): void;
  openVirtualPort(name: string): void;
  sendMessage(message: number[]): void;
  closePort(): void;
}

export async function listMidiPorts(): Promise<{ inputs: string[]; outputs: string[] }> {
  const midi = (await import('@julusian/midi')) as unknown as MidiModule;
  const input = new midi.Input();
  const output = new midi.Output();
  const inputs = Array.from({ length: input.getPortCount() }, (_, i) => input.getPortName(i));
  const outputs = Array.from({ length: output.getPortCount() }, (_, i) => output.getPortName(i));
  return { inputs, outputs };
}

/**
 * Real MIDI transport.
 * - "iac" mode opens existing IAC Driver buses (recommended, they persist across restarts).
 * - "virtual" mode creates CoreMIDI virtual ports owned by this process (Cubase must see them before it starts).
 */
export class MidiTransport implements SysexTransport {
  private input?: MidiInputPort;
  private output?: MidiOutputPort;
  private description = 'not connected';

  constructor(private readonly config: Config) {}

  async open(onMessage: (bytes: number[]) => void): Promise<void> {
    const midi = (await import('@julusian/midi')) as unknown as MidiModule;
    const input = new midi.Input();
    const output = new midi.Output();
    input.ignoreTypes(false, true, true);
    input.on('message', (_delta, message) => onMessage(message));

    if (this.config.portMode === 'virtual') {
      // Cubase reads from our output and writes to our input.
      output.openVirtualPort(this.config.toCubasePort);
      input.openVirtualPort(this.config.fromCubasePort);
      this.description = `virtual ports "${this.config.toCubasePort}" / "${this.config.fromCubasePort}"`;
    } else {
      const outIndex = findPort(output, this.config.toCubasePort);
      const inIndex = findPort(input, this.config.fromCubasePort);
      if (outIndex < 0 || inIndex < 0) {
        const outputs = Array.from({ length: output.getPortCount() }, (_, i) => output.getPortName(i));
        const inputs = Array.from({ length: input.getPortCount() }, (_, i) => input.getPortName(i));
        throw new Error(
          `IAC buses not found. Expected output containing "${this.config.toCubasePort}" and input containing ` +
            `"${this.config.fromCubasePort}". Available outputs: [${outputs.join(', ')}]; inputs: [${inputs.join(', ')}]. ` +
            'Create them in Audio MIDI Setup > IAC Driver (see README).',
        );
      }
      output.openPort(outIndex);
      input.openPort(inIndex);
      this.description = `IAC "${output.getPortName(outIndex)}" -> Cubase -> "${input.getPortName(inIndex)}"`;
    }
    this.input = input;
    this.output = output;
  }

  send(bytes: number[]): void {
    if (!this.output) throw new Error('MIDI output is not open');
    this.output.sendMessage(bytes);
  }

  close(): void {
    this.input?.closePort();
    this.output?.closePort();
    this.input = undefined;
    this.output = undefined;
  }

  describe(): string {
    return this.description;
  }
}

function findPort(port: { getPortCount(): number; getPortName(i: number): string }, needle: string): number {
  const lower = needle.toLowerCase();
  for (let i = 0; i < port.getPortCount(); i++) {
    if (port.getPortName(i).toLowerCase().includes(lower)) return i;
  }
  return -1;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface HelloEvent {
  event: 'hello';
  version: string;
  capabilities: Record<string, unknown>;
}

/**
 * Requests that are safe to send twice: reads, and writes of an absolute value (the same value lands
 * twice). Pulses, actions and key commands are not: a second one toggles, moves or runs again.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'ping',
  'capabilities',
  'state.channels',
  'state.selection',
  'state.selected',
  'state.transport',
  'state.controlRoom',
  'state.focusedQuickControls',
  'state.mouse',
  'value.get',
  'value.list',
  'value.set',
  'value.setMany',
  'snapshot.read',
  'channel.uid',
  'meters.get',
  'meters.reset',
  'command.list',
  'plugins.selected',
  'log.get',
  'debug.requests',
  'da.scopes',
  'da.tree',
  'da.find',
  'da.params',
  'da.getParam',
  'da.setParam',
  'da.setParams',
]);

export interface RequestOptions {
  /** Wait out a Cubase stall and send again (default: only for IDEMPOTENT_METHODS). */
  retry?: boolean;
}

export interface StallRecovery {
  /** Total time a request may take, stall included, before it fails (default 25000 ms). */
  windowMs: number;
  /** Timeout of each ping sent to find out whether Cubase answers again (default 1500 ms). */
  pingTimeoutMs: number;
  /** Times a request is sent again once Cubase answers (default 2). */
  maxResends: number;
}

/** A request Cubase did not answer in time. */
export class CubaseTimeoutError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly id: number,
    /** True when the request is not safe to repeat and was sent only once: Cubase may have applied it. */
    readonly replyLost = false,
  ) {
    super(message);
    this.name = 'CubaseTimeoutError';
  }
}

export function isTimeout(error: unknown): error is CubaseTimeoutError {
  return error instanceof CubaseTimeoutError;
}

const CHECK_SETUP =
  'Check that Cubase is open with a project, the "MCP CubaseBridge" MIDI Remote surface is active, and the IAC buses are enabled.';

/** Random integer in [min, max). */
function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

/**
 * Request/response client over SysEx. Each request carries a JSON id and this server's session; the
 * script answers with both. Ids start at a random number so the script's request history (and two
 * servers on the same IAC buses) can tell processes apart.
 */
export class CubaseBridge extends EventEmitter {
  private readonly assembler = new MessageAssembler();
  private readonly pending = new Map<number, PendingRequest>();
  /** Random per process: the script records it with each request and sends it back. */
  readonly session = randomInt(0, 36 ** 6).toString(36).padStart(6, '0');
  /** First request id of this process. */
  readonly firstId = randomInt(1, 2 ** 30);
  private nextId = this.firstId;
  private nextFrameId = randomInt(0, MAX_ID);
  private connected = false;
  private connecting?: Promise<void>;
  private readonly recovery: StallRecovery;
  /** Ids that timed out, to report their answers when they come late. */
  private readonly timedOut = new Map<number, { method: string; at: number }>();
  lastHello?: HelloEvent;
  /** When this process received the script's hello (it only comes when the script activates). */
  helloAt?: number;
  /** When the last answer from the script arrived. */
  lastAnswerAt?: number;
  readonly stats = { stalls: 0, resent: 0, lateAnswers: 0, foreignAnswers: 0 };

  constructor(
    private readonly transport: SysexTransport,
    private readonly defaultTimeoutMs: number,
    recovery: Partial<StallRecovery> = {},
  ) {
    super();
    this.recovery = { windowMs: 25000, pingTimeoutMs: 1500, maxResends: 2, ...recovery };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        await this.transport.open((bytes: number[]) => this.onBytes(bytes));
        this.connected = true;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  isConnected(): boolean {
    return this.connected;
  }

  describe(): string {
    return this.transport.describe();
  }

  /** Whether an id belongs to this process (for scripts that do not record the session). */
  ownsId(id: number): boolean {
    return id >= this.firstId && id < this.nextId;
  }

  /**
   * Sends a request. Cubase's MIDI Remote sometimes stops answering for 8-20 s (after big answers, on
   * some bank pages) while it still runs what it receives. A request safe to repeat (IDEMPOTENT_METHODS)
   * that times out waits until Cubase answers a ping again and is sent again, at most maxResends times
   * and within windowMs in all. Anything else is sent once: its timeout says the reply was lost and that
   * Cubase may have applied it.
   */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
    options: RequestOptions = {},
  ): Promise<T> {
    const started = Date.now();
    try {
      return await this.send<T>(method, params, timeoutMs);
    } catch (error) {
      if (!isTimeout(error)) throw error;
      if (!(options.retry ?? IDEMPOTENT_METHODS.has(method))) {
        throw new CubaseTimeoutError(
          `${error.message} It was sent once and not resent, because sending it again is not safe (it toggles, moves or runs something): ` +
            'Cubase may have applied it anyway (sent, reply lost). Check the result with a read tool before trying again.',
          method,
          error.id,
          true,
        );
      }
      this.stats.stalls++;
      this.emit('stall', { method, id: error.id });
      const deadline = started + this.recovery.windowMs;
      let last: CubaseTimeoutError = error;
      let resends = 0;
      while (resends < this.recovery.maxResends && (await this.waitResponsive(deadline - Date.now()))) {
        resends++;
        this.stats.resent++;
        try {
          return await this.send<T>(method, params, Math.max(250, Math.min(timeoutMs ?? this.defaultTimeoutMs, deadline - Date.now())));
        } catch (retryError) {
          if (!isTimeout(retryError)) throw retryError;
          last = retryError;
        }
      }
      throw new CubaseTimeoutError(
        `Cubase did not answer "${method}" (request ${error.id}${resends > 0 ? `, sent ${resends + 1} times` : ''}) within ${Math.round((Date.now() - started) / 100) / 10} s, ` +
          `waiting out a MIDI Remote stall included. ${CHECK_SETUP}`,
        method,
        last.id,
      );
    }
  }

  /** Pings until Cubase answers (true) or the time is up (false). */
  async waitResponsive(withinMs: number): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      try {
        await this.send('ping', {}, Math.max(100, Math.min(this.recovery.pingTimeoutMs, deadline - Date.now())));
        return true;
      } catch (error) {
        if (!isTimeout(error)) throw error;
      }
    }
    return false;
  }

  private async send<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    await this.connect();
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const frames = encodeMessage(MessageKind.Request, this.nextFrameId++ % MAX_ID, { id, method, params, session: this.session });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timedOut.set(id, { method, at: Date.now() });
        if (this.timedOut.size > 200) this.timedOut.delete(this.timedOut.keys().next().value as number);
        reject(new CubaseTimeoutError(`Cubase did not answer "${method}" (request ${id}) within ${timeout} ms. ${CHECK_SETUP}`, method, id));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      for (const frame of frames) this.transport.send(frame);
    });
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge closed'));
    }
    this.pending.clear();
    this.transport.close();
    this.connected = false;
  }

  private onBytes(bytes: number[]): void {
    const frame = decodeFrame(bytes);
    if (!frame) return;
    let message: { kind: MessageKind; value: unknown } | null;
    try {
      message = this.assembler.push(frame);
    } catch (error) {
      this.emit('protocolError', error);
      return;
    }
    if (!message) return;
    if (message.kind === MessageKind.Response) {
      const response = message.value as { id: number; session?: string; result?: unknown; error?: string };
      // Another server process on the same buses (scripts older than the session answer without it).
      if (response.session !== undefined && response.session !== this.session) {
        this.stats.foreignAnswers++;
        return;
      }
      this.lastAnswerAt = Date.now();
      const pending = this.pending.get(response.id);
      if (!pending) {
        const late = this.timedOut.get(response.id);
        if (late) {
          this.timedOut.delete(response.id);
          this.stats.lateAnswers++;
          this.emit('lateAnswer', { id: response.id, method: late.method, lateByMs: Date.now() - late.at });
        }
        return;
      }
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) {
        pending.reject(new Error(`Cubase: ${response.error}`));
      } else {
        pending.resolve(response.result);
      }
    } else if (message.kind === MessageKind.Event) {
      const event = message.value as { event?: string };
      if (event.event === 'hello') {
        this.lastHello = event as HelloEvent;
        this.helloAt = Date.now();
      }
      this.emit('event', event);
    }
  }
}
