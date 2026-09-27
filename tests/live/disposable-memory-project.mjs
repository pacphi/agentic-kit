// A throwaway Ruflo project for opt-in live tests whose real hosts write memory
// through MCP. The qe-court live test used to run its seats in the checkout and
// clean up with a default `ruflo memory purge`, which clears memory.db only, so
// the MCP rows stayed: 118 rows in 30 ak-qe-court-live-* namespaces of the real
// agentdb-memory.db (audit 2026-09-26, H D7). Here the whole project is deleted.
//
// Why each piece exists:
// - `git init`: `codex exec` refuses to run outside a Git repository unless
//   given --skip-git-repo-check (codex-cli 0.157.0 `codex exec --help`), and a
//   repository root makes memoryProjectRoot() — what `ak x ruflo-mcp` launches
//   Ruflo in — resolve this folder rather than any enclosing checkout.
// - claude-flow.config.json {daemon:{autostart:false}}: Ruflo starts a daemon
//   on any `ruflo` command in a Ruflo project (daemon-autostart.js, 3.45.0). An
//   env opt-out does not reach an MCP server Codex launches, because Codex
//   passes stdio MCP servers a fixed set of variables (HOME, PATH, USER, ...;
//   neokapi/neokapi#2923, measured on codex-cli 0.155.1); the file opt-out does.
// - CLAUDE_FLOW_DB_PATH / CLAUDE_FLOW_MEMORY_PATH inside the project: the CLI
//   follows the first, the MCP bridge the second (else <cwd>/.swarm), so an
//   inherited value can never steer a seat at the real store. A Codex seat's
//   MCP server gets neither, and `ak x ruflo-mcp` pins it from its cwd instead.
// Lives beside the live tests it serves, which ship in the package (`files`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../src/lib/exec.mjs';
import { projectDaemonAlive, reap } from '../../src/lib/daemons.mjs';
import { findMemoryEntry } from '../../src/lib/project-memory.mjs';

export function disposableMemoryEnv(root) {
  return {
    CLAUDE_FLOW_DB_PATH: path.join(root, '.swarm', 'memory.db'),
    CLAUDE_FLOW_MEMORY_PATH: path.join(root, '.swarm'),
    RUFLO_DAEMON_AUTOSTART: '0',
  };
}

function removeProject(root) {
  const pidFile = path.join(root, '.claude-flow', 'daemon.pid');
  if (projectDaemonAlive(root)) {
    // reap() re-checks that the pid is a `daemon start` process before signalling.
    reap([{ pid: Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10), workspace: root }]);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

export async function createDisposableMemoryProject({
  runner = run, tmpRoot = os.tmpdir(), prefix = 'ak-live-memory-',
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, prefix)));
  const env = disposableMemoryEnv(root);
  try {
    fs.writeFileSync(path.join(root, 'claude-flow.config.json'), `${JSON.stringify({ daemon: { autostart: false } }, null, 2)}\n`);
    const git = await runner('git', ['init', '-q'], { cwd: root, env: process.env, timeout: 30_000 });
    if (git.code !== 0) throw new Error(`git init failed: ${git.stderr}`);
    const init = await runner('ruflo', ['memory', 'init'], { cwd: root, env: { ...process.env, ...env }, timeout: 120_000 });
    if (init.code !== 0) throw new Error(`ruflo memory init failed: ${String(init.stderr).trim().slice(-400)}`);
  } catch (error) {
    removeProject(root);
    throw error;
  }
  return { root, env, cleanup: () => removeProject(root) };
}

/** Run `fn` with `overrides` in process.env (spawned seats inherit it), then
 *  restore every key, deleting any that was absent before. */
export async function withProcessEnv(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Proof keys that landed in the real project's stores. Read-only: stores are
 *  opened read-only and nothing is written or deleted. */
export function leakedProofKeys(realRoot, namespace, keys) {
  return keys.filter((key) => findMemoryEntry(realRoot, namespace, key) !== null);
}
