import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWorkflowTools } from '../dist/tools/workflow.js';

async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerWorkflowTools({ server, client: {}, analyzer: {}, ui: {}, config: { workflowFile: '/nonexistent/workflow.md' }, commands: [] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('mix_session drops blank arguments and trims the rest', async () => {
  const client = await connect();
  const { messages } = await client.getPrompt({ name: 'mix_session', arguments: { genre: '   ', reference: '  /refs/song.wav ', stemsFolder: '\t' } });
  const text = messages[0].content.text;
  assert.doesNotMatch(text, /Genre:/);
  assert.doesNotMatch(text, /Stems folder:/);
  assert.match(text, /^Reference track: \/refs\/song\.wav\.$/m);
  await client.close();
});
