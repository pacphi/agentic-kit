// Dispatch surface — every command `ak` can route MUST ship a usable help
// surface. This test is the guard against a command landing without help or
// without an Examples section (the thing users hit first on `ak <cmd> --help`).
//
// The dispatch table is parsed straight from bin/agentic-kit.mjs source text —
// the PORCELAIN + PLUMBING maps are the single source of truth, so a new command
// is picked up automatically. We deliberately do NOT `import` the bin module:
// its top-level `main()` runs on import and would execute the CLI (and call
// process.exit) during the test. The individual command modules, by contrast,
// have no top-level side effects, so importing each one is safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');
const BIN_DIR = path.dirname(BIN);

/** Parse the PORCELAIN + PLUMBING dispatch maps from bin source. Each entry is a
 *  `name: () => import('<relative path>')` lazy loader; we extract the command
 *  name and resolve its module path relative to the bin directory. Returns a
 *  Map<name, absoluteModulePath> (dashboard appears in both maps → deduped by
 *  name). Raw passthrough tools like `improvement-eval` (spawnSync, no module
 *  in the table) are correctly excluded — they carry no options/help/run. */
function dispatchTable() {
  const src = readFileSync(BIN, 'utf8');
  const re = /(['"]?)([\w-]+)\1:\s*\(\)\s*=>\s*import\('([^']+)'\)/g;
  const cmds = new Map();
  for (const m of src.matchAll(re)) {
    cmds.set(m[2], path.resolve(BIN_DIR, m[3]));
  }
  return cmds;
}

test('dispatch table parses and covers the previously-omitted commands', () => {
  // Arrange
  const table = dispatchTable();
  // Act / Assert
  assert.ok(table.size >= 6, `expected several commands, parsed ${table.size}`);
  assert.ok(table.has('dual'), 'dual must be in the dispatch table');
  assert.ok(table.has('dashboard'), 'dashboard must be in the dispatch table');
});

// One test per command: loads, and exposes a complete help surface.
for (const [name, modPath] of dispatchTable()) {
  test(`command "${name}" loads and ships a complete help surface`, async () => {
    // Arrange — importing the module proves it loads without throwing (DoD a).
    const mod = await import(pathToFileURL(modPath).href);

    // Assert — a run() entrypoint (DoD d)
    assert.equal(typeof mod.run, 'function', `${name} must export a run() function`);

    // Assert — a non-empty help string (DoD b)
    assert.equal(typeof mod.help, 'string', `${name} must export a help string`);
    assert.ok(mod.help.trim().length > 0, `${name} help must be non-empty`);

    // Assert — an Examples: section (DoD c)
    assert.match(mod.help, /Examples:/, `${name} help must contain an "Examples:" section`);
  });
}
