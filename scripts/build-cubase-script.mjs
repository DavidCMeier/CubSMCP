#!/usr/bin/env node
/**
 * Builds the Cubase MIDI Remote script from the template and the command catalogs.
 *
 * Usage:
 *   node scripts/build-cubase-script.mjs            # build into ./build/cubase
 *   node scripts/build-cubase-script.mjs --install  # build and copy into Cubase's Local scripts folder
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

export const VENDOR = 'MCP';
export const DEVICE = 'CubaseBridge';
export const SCRIPT_FILE = `${VENDOR}_${DEVICE}.js`;

/**
 * Parses a catalog where categories are written as "[Category]" and "#" starts a comment.
 * @returns {Array<[string, string]>}
 */
export function parseCommandCatalog(text, sourceName = 'catalog') {
  const commands = [];
  let category = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      category = header[1].trim();
      continue;
    }
    if (!category) {
      throw new Error(`${sourceName}: command "${line}" appears before any [Category] header`);
    }
    commands.push([category, line]);
  }
  return commands;
}

function loadCatalog(file) {
  const path = join(root, 'commands', file);
  if (!existsSync(path)) return [];
  return parseCommandCatalog(readFileSync(path, 'utf8'), file);
}

/** [labelCategory, labelName, category, name] rows extracted from the MIDI Remote README. */
function loadInternalNames() {
  return JSON.parse(readFileSync(join(root, 'commands', 'cubase13-internal-names.json'), 'utf8'));
}

/**
 * Resolves catalog entries to the internal names page.makeCommandBinding accepts.
 * Cubase ignores a binding made with an on-screen label without any error, so built-in
 * entries must be internal names. User entries may also use a label (it is translated) or
 * a name the README does not know, such as a macro or a Logical Editor preset.
 * @returns {Array<{category: string, name: string, label?: string}>}
 */
export function resolveCommands(builtIn, user, internalNames) {
  const labels = new Map();
  const byInternal = new Map();
  for (const [labelCategory, labelName, category, name] of internalNames) {
    byInternal.set(`${category}\u0000${name}`, `${labelCategory} / ${labelName}`);
    const key = `${labelCategory}\u0000${labelName}`;
    labels.set(key, [...(labels.get(key) ?? []), [category, name]]);
  }
  const seen = new Set();
  const commands = [];
  const add = (category, name) => {
    const key = `${category}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const label = byInternal.get(key);
    commands.push(label && label !== `${category} / ${name}` ? { category, name, label } : { category, name });
  };
  for (const [category, name] of builtIn) {
    if (!byInternal.has(`${category}\u0000${name}`)) {
      const candidates = labels.get(`${category}\u0000${name}`);
      const hint = candidates ? ` It is an on-screen label: use ${candidates.map(([c, n]) => `[${c}] ${n}`).join(' or ')}.` : '';
      throw new Error(`cubase13-commands.txt: "${category} / ${name}" is not a Cubase internal command name.${hint}`);
    }
    add(category, name);
  }
  for (const [category, name] of user) {
    const candidates = byInternal.has(`${category}\u0000${name}`) ? null : labels.get(`${category}\u0000${name}`);
    if (candidates && candidates.length > 1) {
      throw new Error(`user-commands.txt: "${category} / ${name}" is ambiguous: use ${candidates.map(([c, n]) => `[${c}] ${n}`).join(' or ')}`);
    }
    if (candidates) add(...candidates[0]);
    else add(category, name);
  }
  return commands;
}

export function buildScript() {
  const template = readFileSync(join(root, 'cubase-script', 'template', 'MCP_CubaseBridge.template.js'), 'utf8');
  const commands = resolveCommands(loadCatalog('cubase13-commands.txt'), loadCatalog('user-commands.txt'), loadInternalNames());

  const commandsLiteral = '[\n    ' + commands.map((c) => JSON.stringify([c.category, c.name])).join(',\n    ') + '\n]';
  const output = template
    .replace("'/*@@VERSION@@*/'", `'${pkg.version}'`)
    .replace('/*@@COMMANDS@@*/[]', commandsLiteral);

  if (output.includes('@@')) {
    throw new Error('Template placeholders were not fully replaced');
  }

  const outDir = join(root, 'build', 'cubase', 'Local', VENDOR, DEVICE);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, SCRIPT_FILE);
  writeFileSync(outFile, output);
  writeFileSync(join(root, 'build', 'commands.json'), JSON.stringify(commands, null, 2));
  return { outFile, commandCount: commands.length };
}

export function cubaseScriptsFolder() {
  return join(homedir(), 'Documents', 'Steinberg', 'Cubase', 'MIDI Remote', 'Driver Scripts', 'Local', VENDOR, DEVICE);
}

function install(outFile) {
  const target = cubaseScriptsFolder();
  mkdirSync(target, { recursive: true });
  const destination = join(target, SCRIPT_FILE);
  copyFileSync(outFile, destination);
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outFile, commandCount } = buildScript();
  console.log(`Built ${outFile} with ${commandCount} commands`);
  if (process.argv.includes('--install')) {
    console.log(`Installed to ${install(outFile)}`);
    console.log('Reload it by hand in Cubase: MIDI Remote Manager > Scripting Tools > Reload Scripts');
  }
}
