// Golden snapshot of `ak status` collect() — the refactor net for the
// status decomposition track. The 46 behavior tests in status-command.test.mjs
// assert individual sections; this one pins the WHOLE contract for one fixed
// fixture: every row, in order, byte-for-byte. Subsystem strings, row order,
// messages, and fix strings are load-bearing (`ak sync` builds its plan from
// them), so a mechanical split of collect() must reproduce them exactly.
//
// Regenerate deliberately, never casually:
//   STATUS_GOLDEN_UPDATE=1 node --test tests/kit/status-golden.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-status-golden');
const paths = await import('../../src/lib/paths.mjs');
const status = await import('../../src/commands/status.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-status-golden');
const GOLDEN = path.join(PKG_ROOT, 'tests', 'kit', 'fixtures', 'status-golden.json');

paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));

// The kit's own version appears in the `self` row and changes every release;
// pin it to a token so the golden survives version bumps.
const SELF_VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
const normalize = (rows) => rows.map((r) => ({
  ...r,
  message: r.message.split(SELF_VERSION).join('<self-version>'),
}));

test('collect() output matches the golden snapshot for the offline fixture', async () => {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, offlineKitConfig());

  const rows = normalize(await status.collect({ pkgRoot: PKG_ROOT, cwd: PROJECT }));

  if (process.env.STATUS_GOLDEN_UPDATE === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(rows, null, 2)}\n`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(rows, golden,
    'collect() rows drifted from the golden snapshot. If the change is intentional, '
    + 'regenerate with STATUS_GOLDEN_UPDATE=1 and review the diff.');
});
