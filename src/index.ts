#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { CubaseBridge, MidiTransport } from './bridge/midiBridge.js';
import { CubaseClient } from './cubase/client.js';
import { loadCommandCatalog } from './cubase/commands.js';
import { AudioAnalyzer } from './analysis/audio.js';
import { MacUi } from './ui/macos.js';
import type { ToolContext } from './tools/common.js';
import { registerDiagnosticTools } from './tools/diagnostics.js';
import { registerMixerTools } from './tools/mixer.js';
import { registerChannelStripTools } from './tools/channelStrip.js';
import { registerPluginTools } from './tools/plugins.js';
import { registerTransportTools } from './tools/transport.js';
import { registerCommandTools } from './tools/commands.js';
import { registerMeterTools } from './tools/meters.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerUiTools } from './tools/ui.js';
import { registerWorkflowTools } from './tools/workflow.js';

const INSTRUCTIONS = `Controls Steinberg Cubase 13 through the "MCP CubaseBridge" MIDI Remote script.
Start with cubase_status, then cubase_list_channels. Channels are addressed by bank index (on the bank page shown now) or by name (searched on every bank page; a repeated name needs #N, e.g. "G L#2").
Fader/pan/gain/EQ/send tools take real units (dB, Hz, -100..100 pan); the server searches Cubase's display to hit them.
Detailed channel-strip work (Pre filter, EQ, strip modules, inserts, plugin parameters) acts on the selected track: pass "channel" to select it first.
Selecting changes the user's selection and, with Cubase's preference "Enable Record on Selected Audio Track" on, record-arms the track (Cubase then creates an empty take file in Audio/ each time; File > Cleanup removes them): ask the user to turn that preference off for mixing. Results report it in sideEffects; disarm and restoreSelection undo it.
Cubase 13 cannot load new plugins through the API: plugin chains come from the project template, the agent switches and tunes them.
The agent cannot hear: measure with cubase_measure_levels or export stems and use audio_analyze_folder / audio_compare_to_reference.
Read the user's workflow with cubase_get_workflow (or the cubase://workflow resource) before mixing, and snapshot the mix before big changes.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const pkg = JSON.parse(readFileSync(join(config.projectRoot, 'package.json'), 'utf8')) as { version: string };
  const server = new McpServer({ name: 'cubase-mcp', version: pkg.version }, { instructions: INSTRUCTIONS });

  const bridge = new CubaseBridge(new MidiTransport(config), config.requestTimeoutMs, { windowMs: config.stallRecoveryMs });
  bridge.on('protocolError', (error) => console.error('[cubase-mcp] protocol error', error));
  bridge.on('stall', ({ method, id }) => console.error(`[cubase-mcp] "${method}" (request ${id}) timed out: waiting for Cubase to answer again`));
  bridge.on('lateAnswer', ({ method, id, lateByMs }) =>
    console.error(`[cubase-mcp] late answer to "${method}" (request ${id}), ${lateByMs} ms after its timeout: ignored`),
  );
  const client = new CubaseClient(bridge, config.settleMs);

  const ctx: ToolContext = {
    server,
    client,
    analyzer: new AudioAnalyzer(config.ffmpegPath, config.ffprobePath),
    ui: new MacUi(config.cubaseAppName, config.enableUiAutomation),
    config,
    commands: loadCommandCatalog(join(config.projectRoot, 'build', 'commands.json')),
  };

  registerDiagnosticTools(ctx);
  registerMixerTools(ctx);
  registerChannelStripTools(ctx);
  registerPluginTools(ctx);
  registerTransportTools(ctx);
  registerCommandTools(ctx);
  registerMeterTools(ctx);
  registerAnalysisTools(ctx);
  registerUiTools(ctx);
  registerWorkflowTools(ctx);

  // Connect early so the first tool call is fast, but never crash the server if Cubase is not ready yet.
  bridge.connect().catch((error) => console.error(`[cubase-mcp] MIDI not connected yet: ${error.message}`));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cubase-mcp] ${pkg.version} ready (${config.portMode} ports "${config.toCubasePort}" / "${config.fromCubasePort}")`);

  const shutdown = () => {
    bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[cubase-mcp] fatal', error);
  process.exit(1);
});
