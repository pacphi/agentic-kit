// Opt-in live contract for issue #213: run the REAL probe against the REAL
// installed `ruflo` (CLI and MCP) in an isolated temp project. The unit tests
// prove the wiring against a fake that encodes our model of Ruflo; this is the
// test that can catch the model being wrong. Run: pnpm run test:ruflo-memory-live
//
// On a release/platform pair listed in OBSERVED_ROUTING the routing is asserted,
// so an upgrade that fixes (or changes) the split fails here and forces a human
// to update the claim. Elsewhere it only reports what was observed and requires
// that the MCP round trip worked, which is the evidence needed to add a pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeProjectMemoryRoutes } from '../../src/commands/x/verify.mjs';
import { projectMemoryEnv } from '../../src/lib/ruflo-memory.mjs';
import { installedRoutingVersion, memoryRoutingObserved } from '../../src/lib/ruflo-memory-contract.mjs';
import { run } from '../../src/lib/exec.mjs';

const hasRuflo = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ruflo'], { stdio: 'ignore' }).status === 0;

test('the real Ruflo CLI and MCP interfaces route project memory as the kit claims', { skip: !hasRuflo && 'ruflo is not on PATH', timeout: 600_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-routing-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = projectMemoryEnv(tmp, {
    RUFLO_DAEMON_AUTOSTART: '0',
    CLAUDE_FLOW_MEMORY_PATH: path.join(fs.realpathSync(tmp), '.swarm'),
  });
  assert.equal((await run('ruflo', ['memory', 'init'], { cwd: tmp, env, timeout: 120_000 })).code, 0, 'ruflo memory init');

  const observation = await probeProjectMemoryRoutes(tmp, env, `live-${process.pid}`);
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
