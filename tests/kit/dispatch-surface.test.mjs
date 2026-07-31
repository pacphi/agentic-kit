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
import { spawnSync } from 'node:child_process';

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

test('dispatch table exposes canonical commands and omits removed aliases', () => {
  // Arrange
  const table = dispatchTable();
  // Act / Assert
  assert.ok(table.size >= 6, `expected several commands, parsed ${table.size}`);
  assert.ok(table.has('dashboard'), 'dashboard must be in the dispatch table');
  assert.ok(table.has('host'), 'canonical host management must be in the dispatch table');
  assert.equal(table.has('dual'), false, 'removed dual command must stay absent');
  assert.equal(table.has('provider'), false, 'removed provider aliases must stay absent');
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

// code-quality Finding 6: PORCELAIN/PLUMBING used to be plain object literals,
// so `cmd in table` resolved Object.prototype members as legitimate commands.
// `ak toString` called Object.prototype.toString (callable, returns a string)
// then crashed on `mod.run is not a function`; `ak __proto__` threw outright
// (table['__proto__'] is Object.prototype, not a function). Both leaked a raw
// Node stack trace with internal file paths for what should read as a plain
// "unknown command" — undermining a kit whose whole job is diagnosing other
// tools' failures. These spawn the REAL CLI (not an in-process import) because
// the bug lived in bin/agentic-kit.mjs's own dispatch, not in any command module.
const BIN_ARGV = [BIN];
for (const hostile of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
  test(`"ak ${hostile}" is an unknown command, not a prototype-chain hit`, () => {
    const r = spawnSync(process.execPath, [...BIN_ARGV, hostile], { encoding: 'utf8' });
    assert.equal(r.status, 2, `expected exit 2 (unknown command), got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /unknown command/, 'must print the normal "unknown command" message');
    assert.equal(r.stderr, '', `must never leak a stack trace to stderr for a typo'd command name, got: ${r.stderr}`);
  });

  test(`"ak x ${hostile}" is an unknown plumbing command, not a prototype-chain hit`, () => {
    const r = spawnSync(process.execPath, [...BIN_ARGV, 'x', hostile], { encoding: 'utf8' });
    assert.equal(r.status, 2, `expected exit 2 (unknown plumbing command), got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /unknown plumbing command/, 'must print the normal "unknown plumbing command" message');
    assert.equal(r.stderr, '', `must never leak a stack trace to stderr for a typo'd plumbing command name, got: ${r.stderr}`);
  });
}
