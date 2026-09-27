// Opt-in live contract for issue #213: run the REAL probe against the REAL
// installed `ruflo` (CLI and MCP) in an isolated temp project. The unit tests
// prove the wiring against a fake that encodes our model of Ruflo; this is the
// test that can catch the model being wrong. Run: pnpm run test:ruflo-memory-live
//
// On a release/platform pair listed in OBSERVED_ROUTING the routing is asserted,
// so an upgrade that fixes (or changes) the split fails here and forces a human
// to update the claim. Elsewhere it only reports what was observed and requires
// that the MCP round trip worked, which is the evidence needed to add a pair.
//
// It runs in a disposable home: sandboxHome() redirects HOME/XDG_*/APPDATA/
// LOCALAPPDATA before any kit module loads (paths.mjs snapshots the home at
// module scope), so neither the probe nor the Ruflo it launches reads the real
// kit.json or writes the real ~/.claude-flow, ~/.swarm or memory stores. The
// project is createDisposableMemoryProject()'s git-initialised, daemon-off folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sandboxHome, rmrf } from '../kit/helpers/home-sandbox.mjs';

const hasRuflo = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ruflo'], { stdio: 'ignore' }).status === 0; // spawn-env: inherits (PATH probe for an installed ruflo)
// sandboxHome() also blanks PATH; the real `ruflo`, `git` and `npm` are needed, so PATH is restored.
const realPath = process.env.PATH;
const home = sandboxHome('ak-live-routing');
process.env.PATH = realPath;
after(() => rmrf(home));
// A shell or Claude Code session inside an ak-managed project exports that project's
// Ruflo settings (CLAUDE_FLOW_DB_PATH at its real store, RUFLO_MCP_ENFORCE_POLICY=1,
// which makes Ruflo 3.46.1 fail closed without the project's .harness/mcp-policy.json).
// The disposable project sets its own; nothing is inherited.
for (const key of Object.keys(process.env)) if (/^(RUFLO_|CLAUDE_FLOW_)/.test(key)) delete process.env[key];
const paths = await import('../../src/lib/paths.mjs');
const { probeProjectMemoryRoutes } = await import('../../src/commands/x/verify.mjs');
const { installedRoutingVersion, memoryRoutingObserved } = await import('../../src/lib/ruflo-memory-contract.mjs');
const { createDisposableMemoryProject } = await import('./disposable-memory-project.mjs');

test('the real Ruflo CLI and MCP interfaces route project memory as the kit claims', { skip: !hasRuflo && 'ruflo is not on PATH', timeout: 600_000 }, async (t) => {
  assert.ok(fs.realpathSync(paths.home).startsWith(fs.realpathSync(os.tmpdir())),
    `the live probe must run in a disposable home, not ${paths.home}`);
  const project = await createDisposableMemoryProject({ prefix: 'ak-live-routing-' });
  t.after(() => project.cleanup());

  const observation = await probeProjectMemoryRoutes(project.root, project.env, `live-${process.pid}`);
  const version = installedRoutingVersion();
  console.log(JSON.stringify({ version, platform: process.platform, observation }));

  assert.equal(observation.status, 'observed', `the MCP round trip must work: ${observation.detail ?? ''}`);
  assert.notEqual(observation.cliToMcp, 'unknown', 'MCP retrieve returned an unexpected shape');
  assert.notEqual(observation.mcpToCli, 'unknown', 'CLI retrieve failed for a reason other than a miss');
  if (memoryRoutingObserved(version)) {
    assert.deepEqual([observation.cliToMcp, observation.mcpToCli], ['visible', 'not-visible'],
      `ruflo ${version} on ${process.platform} no longer routes as OBSERVED_ROUTING claims; re-verify and update src/lib/ruflo-memory-contract.mjs, docs/TROUBLESHOOTING.md and the guidance`);
    assert.equal(observation.mcpStore, 'agentdb-memory.db');
  }
});
