/**
 * Test sessions: the generated bridge script running in the Cubase mock, a CubaseClient talking to
 * it, and optionally the MCP server with every tool, reached through an in-memory MCP client.
 */
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMockCubase } from './mockCubase.mjs';
import { CubaseBridge } from '../../dist/bridge/midiBridge.js';
import { CubaseClient } from '../../dist/cubase/client.js';
import { loadCommandCatalog } from '../../dist/cubase/commands.js';
import { registerDiagnosticTools } from '../../dist/tools/diagnostics.js';
import { registerMixerTools } from '../../dist/tools/mixer.js';
import { registerChannelStripTools } from '../../dist/tools/channelStrip.js';
import { registerPluginTools } from '../../dist/tools/plugins.js';
import { registerTransportTools } from '../../dist/tools/transport.js';
import { registerCommandTools } from '../../dist/tools/commands.js';
import { registerMeterTools } from '../../dist/tools/meters.js';
import { registerAnalysisTools } from '../../dist/tools/analysis.js';
import { registerUiTools } from '../../dist/tools/ui.js';
import { registerWorkflowTools } from '../../dist/tools/workflow.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const scriptPath = join(root, 'build', 'cubase', 'Local', 'MCP', 'CubaseBridge', 'MCP_CubaseBridge.js');

/** A 137-channel project like the one of the live tests: three bank pages (48, 48, 41) and repeated names. */
export function bigProject() {
  const tracks = Array.from({ length: 137 }, (_, i) => `Track ${String(i).padStart(3, '0')}`);
  tracks[0] = 'Stereo Out';
  tracks[31] = 'Bass Clean Arm';
  tracks[32] = 'Bass Clean';
  tracks[35] = 'G L';
  tracks[37] = 'G L';
  tracks[41] = 'G L Clean';
  tracks[60] = 'Trompeta';
  tracks[100] = 'Doubler Vox';
  tracks[136] = 'Doubler';
  return tracks;
}

/**
 * options: mock options (tracks, hidden), timeoutMs and recovery (stall recovery) for the bridge, activateFirst,
 * bankTimeoutMs, confirmMs and selectionTimeoutMs for the client.
 */
export async function setupCubase(options = {}) {
  const mock = createMockCubase(options);
  mock.load(scriptPath);
  const bridge = new CubaseBridge(mock.transport, options.timeoutMs ?? 2000, options.recovery);
  // activateFirst: the script started before this server, so its hello went nowhere.
  if (options.activateFirst) mock.activate();
  await bridge.connect();
  if (!options.activateFirst) mock.activate();
  await new Promise((resolve) => setImmediate(resolve));
  const client = new CubaseClient(bridge, 1, {
    bankTimeoutMs: options.bankTimeoutMs ?? 300,
    confirmMs: options.confirmMs ?? 1500,
    selectionTimeoutMs: options.selectionTimeoutMs ?? 3000,
  });
  return { mock, bridge, client };
}

/** Same session behind the MCP server: call(name, args) returns the parsed result, or { error } for tool errors. */
export async function setupServer(options = {}) {
  // options.session reuses a running mock (a server restarted against the same Cubase); options.snapshotDir its folder.
  const session = options.session ?? (await setupCubase(options));
  const server = new McpServer({ name: 'cubase-mcp-test', version: '0.0.0' });
  const ctx = {
    server,
    client: session.client,
    analyzer: {},
    // options.ui: a fake MacUi (state, activate, listMenu, keyCode...) for tools that use the UI when it is enabled (options.enableUi).
    ui: options.ui ?? { activate: async () => undefined },
    config: {
      settleMs: 1,
      requestTimeoutMs: 2000,
      selectionTimeoutMs: options.selectionTimeoutMs ?? 3000,
      enableUiAutomation: options.enableUi ?? false,
      // A folder of its own per server: files kept next to the snapshot folder (last-bus.json) must not be shared by tests running at once.
      snapshotDir: options.snapshotDir ?? join(mkdtempSync(join(tmpdir(), 'cubase-mcp-')), 'snapshots'),
      workflowFile: join(root, 'workflow', 'mix-workflow.md'),
      projectRoot: root,
    },
    commands: loadCommandCatalog(join(root, 'build', 'commands.json')),
  };
  for (const register of [
    registerDiagnosticTools,
    registerMixerTools,
    registerChannelStripTools,
    registerPluginTools,
    registerTransportTools,
    registerCommandTools,
    registerMeterTools,
    registerAnalysisTools,
    registerUiTools,
    registerWorkflowTools,
  ]) {
    register(ctx);
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const call = async (name, args = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = result.content[0]?.text ?? '';
    if (result.isError) return { error: text };
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { ...session, server, mcp, call, ctx };
}
