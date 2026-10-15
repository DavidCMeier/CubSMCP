#!/usr/bin/env node
/**
 * Extracts Cubase's internal key command names from Steinberg's MIDI Remote README.
 *
 * The README's "List of Commands" shows each command with an on-screen label, but
 * page.makeCommandBinding only accepts the internal pair stored in the entry's
 * `snippet` attribute (for example "Go to Project End" is 'Transport', 'Goto End').
 * Binding a label gives no error: the command just never runs.
 *
 * Usage:
 *   node scripts/extract-command-names.mjs [path/to/README_v1.html]
 * Writes commands/cubase13-internal-names.json: [labelCategory, labelName, category, name][]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITIES[entity]);

/**
 * @returns {Array<[string, string, string, string]>} [labelCategory, labelName, category, name]
 */
export function extractCommandNames(html) {
  const entries = [];
  const pattern = /<li class="tblcmd_node tblcmd_node_name" id="([^"]*)" snippet="([^"]*)">([^<]*)<\/li>/g;
  for (const match of html.matchAll(pattern)) {
    const id = decode(match[1]);
    const snippet = /^'(.*)', '(.*)'$/.exec(decode(match[2]));
    const separator = id.indexOf(' / ');
    if (!snippet || separator < 0) continue;
    entries.push([id.slice(0, separator), decode(match[3]), snippet[1], snippet[2]]);
  }
  return entries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] ?? join(homedir(), 'Documents', 'Steinberg', 'Cubase', 'MIDI Remote', 'Driver Scripts', 'README_v1.html');
  const entries = extractCommandNames(readFileSync(source, 'utf8'));
  if (entries.length === 0) throw new Error(`No commands found in ${source}`);
  const out = join(root, 'commands', 'cubase13-internal-names.json');
  writeFileSync(out, '[\n' + entries.map((entry) => '  ' + JSON.stringify(entry)).join(',\n') + '\n]\n');
  console.log(`Wrote ${entries.length} commands to ${out}`);
}
