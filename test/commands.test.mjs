import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommands } from '../scripts/build-cubase-script.mjs';
import { resolveCommand } from '../dist/cubase/commands.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const internalNames = JSON.parse(readFileSync(join(root, 'commands', 'cubase13-internal-names.json'), 'utf8'));
const internal = new Set(internalNames.map(([, , category, name]) => `${category} / ${name}`));
const catalog = JSON.parse(readFileSync(join(root, 'build', 'commands.json'), 'utf8'));
const bound = new Set(catalog.map((c) => `${c.category} / ${c.name}`));

test('every built-in catalog command is a Cubase internal name', () => {
  assert.ok(catalog.length > 500);
  const unknown = catalog.filter((c) => !internal.has(`${c.category} / ${c.name}`));
  assert.deepEqual(unknown, []);
});

test('every command the tools send by name is bound by the script', () => {
  const sent = [];
  for (const file of readdirSync(join(root, 'src', 'tools'))) {
    const code = readFileSync(join(root, 'src', 'tools', file), 'utf8');
    for (const m of code.matchAll(/runCommand\(\s*'([^']+)',\s*'([^']+)'\s*\)/g)) sent.push(`${m[1]} / ${m[2]}`);
    for (const m of code.matchAll(/runCommand\(\s*'([^']+)',\s*\w+\s*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\)/g)) {
      sent.push(`${m[1]} / ${m[2]}`, `${m[1]} / ${m[3]}`);
    }
    for (const m of code.matchAll(/category: '([^']+)', name: '([^']+)'/g)) sent.push(`${m[1]} / ${m[2]}`);
    for (const m of code.matchAll(/'(Add Track To Selected: [^']+)'/g)) sent.push(`Mixer / ${m[1]}`);
  }
  for (let n = 1; n <= 9; n++) sent.push(`Transport / To Marker ${n}`, `Transport / To Cycle Marker ${n}`, `Transport / Recall Cycle Marker ${n}`);
  assert.ok(sent.length > 25);
  assert.deepEqual(sent.filter((c) => !bound.has(c)), []);
});

test('on-screen labels resolve to internal names', () => {
  assert.deepEqual(resolveCommand(catalog, 'Transport', 'Activate Metronome'), {
    category: 'Transport',
    name: 'Metronome On',
    from: 'Transport / Activate Metronome',
  });
  assert.deepEqual(resolveCommand(catalog, 'File', 'Audio Mixdown...'), { category: 'File', name: 'Export Audio Mixdown', from: 'File / Audio Mixdown...' });
  assert.deepEqual(resolveCommand(catalog, 'Transport', 'Goto End'), { category: 'Transport', name: 'Goto End' });
  assert.deepEqual(resolveCommand(catalog, 'transport', 'goto end'), { category: 'Transport', name: 'Goto End', from: 'transport / goto end' });
  // Unknown names (macros added later, typos) go to the script, which reports whether they are bound.
  assert.deepEqual(resolveCommand(catalog, 'Macro', 'My Macro'), { category: 'Macro', name: 'My Macro' });
  // A label shared by two commands must not pick one at random.
  assert.throws(() => resolveCommand(catalog, 'Edit', 'Invert'), /matches several commands/);
});

test('the build rejects labels in the built-in catalog and translates them in user commands', () => {
  const names = [
    ['Transport', 'Go to Project End', 'Transport', 'Goto End'],
    ['Edit', 'Invert', 'Edit', 'Invert Selection'],
    ['Edit', 'Invert', 'Edit', 'Flip/Invert'],
  ];
  assert.throws(() => resolveCommands([['Transport', 'Go to Project End']], [], names), /use \[Transport\] Goto End/);
  assert.deepEqual(resolveCommands([['Transport', 'Goto End']], [['Transport', 'Go to Project End'], ['Macro', 'Mine']], names), [
    { category: 'Transport', name: 'Goto End', label: 'Transport / Go to Project End' },
    { category: 'Macro', name: 'Mine' },
  ]);
  assert.throws(() => resolveCommands([], [['Edit', 'Invert']], names), /ambiguous/);
});
