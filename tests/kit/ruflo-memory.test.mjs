import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  memoryProjectRoot, projectMemoryEnv, rufloMcpLaunch,
} from '../../src/lib/ruflo-memory.mjs';

test('every host launch resolves one absolute memory pin from the repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ruflo-memory-'));
  const nested = path.join(root, 'src', 'nested');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(nested, { recursive: true });
  try {
    const canonical = fs.realpathSync(root);
    assert.equal(memoryProjectRoot(nested), canonical);
    assert.deepEqual(projectMemoryEnv(nested, { KEEP: 'yes', CLAUDE_FLOW_DB_PATH: '/wrong' }), {
      KEEP: 'yes',
      CLAUDE_FLOW_DB_PATH: path.join(canonical, '.swarm', 'memory.db'),
    });
    const launch = rufloMcpLaunch(nested, { KEEP: 'yes' }, { cfg: { agentBrowser: false } });
    assert.deepEqual({ command: launch.command, args: launch.args, cwd: launch.cwd }, {
      command: 'ruflo', args: ['mcp', 'start'], cwd: canonical,
    });
    assert.equal(launch.env.CLAUDE_FLOW_DB_PATH, path.join(canonical, '.swarm', 'memory.db'));
    assert.equal(launch.env.AGENT_BROWSER_CONFIG, undefined);
    const browserLaunch = rufloMcpLaunch(nested, { KEEP: 'yes' }, { cfg: { agentBrowser: true } });
    assert.ok(path.isAbsolute(browserLaunch.env.AGENT_BROWSER_CONFIG));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
