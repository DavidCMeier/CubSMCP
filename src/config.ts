import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** "iac" uses existing IAC buses; "virtual" creates CoreMIDI virtual ports. */
  portMode: 'iac' | 'virtual';
  /** Port (substring) the server writes to; Cubase reads it as its MIDI input. */
  toCubasePort: string;
  /** Port (substring) the server reads from; Cubase writes to it as its MIDI output. */
  fromCubasePort: string;
  requestTimeoutMs: number;
  /** Total time a read or absolute write may spend waiting out a MIDI Remote stall before it fails. */
  stallRecoveryMs: number;
  /** Delay before reading back a value after writing it. */
  settleMs: number;
  /** How long selection changes are waited for (Cubase reports them 2-8 s late); default 10000 ms. */
  selectionTimeoutMs?: number;
  /** Cubase application / process name for macOS UI automation. */
  cubaseAppName: string;
  /** Enables the macOS UI automation tools (keystrokes, menus). */
  enableUiAutomation: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  /** Markdown file describing the user's mixing workflow, exposed as a resource and prompt. */
  workflowFile: string;
  /** Folder where mix snapshots are stored. */
  snapshotDir: string;
  projectRoot: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export function loadConfig(): Config {
  const portMode = env('CUBASE_MCP_PORT_MODE', 'iac') === 'virtual' ? 'virtual' : 'iac';
  return {
    portMode,
    toCubasePort: env('CUBASE_MCP_TO_CUBASE_PORT', 'MCP to Cubase'),
    fromCubasePort: env('CUBASE_MCP_FROM_CUBASE_PORT', 'MCP from Cubase'),
    requestTimeoutMs: Number(env('CUBASE_MCP_TIMEOUT_MS', '4000')),
    stallRecoveryMs: Number(env('CUBASE_MCP_STALL_RECOVERY_MS', '25000')),
    settleMs: Number(env('CUBASE_MCP_SETTLE_MS', '150')),
    cubaseAppName: env('CUBASE_MCP_APP_NAME', 'Cubase 13'),
    enableUiAutomation: env('CUBASE_MCP_ENABLE_UI', '0') === '1',
    ffmpegPath: env('CUBASE_MCP_FFMPEG', 'ffmpeg'),
    ffprobePath: env('CUBASE_MCP_FFPROBE', 'ffprobe'),
    workflowFile: env('CUBASE_MCP_WORKFLOW_FILE', join(projectRoot, 'workflow', 'mix-workflow.md')),
    snapshotDir: env('CUBASE_MCP_SNAPSHOT_DIR', join(homedir(), '.cubase-mcp', 'snapshots')),
    projectRoot,
  };
}
