// Regression: bin/agentic-kit.mjs's post-command drift nudge ran
// unconditionally after every non-`sync`, non-`--json` command — including
// under --dry-run. It shells `npm view` (versions.mjs's driftReport), which
// writes to npm's own cache (~/.npm/_cacache, ~/.npm/_logs) as a side effect
// of the network call. That contradicts every mutating command's documented
// contract ("--dry-run: prints the plan, changes nothing"), even though it
// never touches an ak-managed path.
//
// Spawns the REAL CLI (this is bin/agentic-kit.mjs's own dispatch logic, not
// a pure function) with HOME sandboxed (provider-cli.test.mjs's pattern) and
// a fake `npm` prepended to PATH that only records whether it was invoked —
// proving the nudge is skipped structurally, not just that a shared cache
// directory happened not to change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-nudge-home-'));
  fs.mkdirSync(path.join(home, '.config', 'agentic-kit'), { recursive: true });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-nudge-proj-'));
  fs.mkdirSync(path.join(project, '.git'));
  return { home, project };
}

/** A fake `npm` on PATH ahead of the real one: any invocation touches
 *  `marker`, then exits 1 so a call that slips through fails loudly instead
 *  of silently succeeding against a fake registry. */
function fakeNpmBin(marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-nudge-bin-'));
  const shim = path.join(dir, 'npm');
  fs.writeFileSync(shim, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  return dir;
}

function rm(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('ak setup --dry-run never invokes npm (the drift nudge is skipped)', { skip: process.platform === 'win32' }, () => {
  const { home, project } = sandbox();
  const marker = path.join(home, 'npm-was-invoked');
  const fakeBinDir = fakeNpmBin(marker);
  try {
    const r = spawnSync(process.execPath, [BIN, 'setup', '--dry-run', '--project'], {
      encoding: 'utf8',
      cwd: project,
      env: {
        ...process.env,
        NO_COLOR: '1',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        APPDATA: path.join(home, '.config'),
        // The fake shim first so it wins over any real npm already on PATH.
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(r.status, 0, `expected a clean dry-run exit, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /dry-run/, 'must reach the dry-run path, not fail before it');
    assert.ok(!fs.existsSync(marker), 'npm must never be invoked under --dry-run (the post-command drift nudge must be skipped)');
  } finally {
    rm(home, project, fakeBinDir);
  }
});
