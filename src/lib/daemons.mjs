// Daemon discovery — pidfile/registry-first (3.28's own state files), with a
// process-table sweep as fallback for pre-3.28 strays. Replaces the shell
// kit's `ps -eo pid,etime,args` parsing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from './exec.mjs';
import { isWindows, home } from './paths.mjs';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Known-workspace discovery from ruflo's machine-level registries
 *  (~/.claude-flow/*.json record workspaces; each workspace has
 *  .claude-flow/daemon.pid + daemon-state.json with startedAt). */
function registryWorkspaces() {
  const out = new Set();
  const reg = path.join(home, '.claude-flow');
  for (const f of ['ai-jobs.json', 'workspace-leases.json', 'repo-supervisors.json']) {
    const j = readJsonSafe(path.join(reg, f));
    if (!j) continue;
    for (const v of walkStrings(j)) {
      if (v.includes(path.sep) && fs.existsSync(path.join(v, '.claude-flow'))) out.add(v);
    }
  }
  return out;
}

function* walkStrings(node) {
  if (typeof node === 'string') { yield node; return; }
  if (Array.isArray(node)) { for (const v of node) yield* walkStrings(v); return; }
  if (node && typeof node === 'object') for (const v of Object.values(node)) yield* walkStrings(v);
}

const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function daemonFromWorkspace(ws) {
  const pidFile = path.join(ws, '.claude-flow', 'daemon.pid');
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  if (!Number.isFinite(pid) || !alive(pid)) return null;
  const state = readJsonSafe(path.join(ws, '.claude-flow', 'daemon-state.json'));
  const startedAt = state?.startedAt ? Date.parse(state.startedAt) : null;
  return {
    pid,
    workspace: ws,
    ageSecs: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null,
    workspaceExists: fs.existsSync(ws),
  };
}

/** Fallback sweep of the process table for `cli.js daemon start` processes the
 *  registries don't know about. Returns [{pid, workspace}]. */
async function processSweep() {
  const found = [];
  if (isWindows) {
    const r = await run('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'daemon start' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"]);
    for (const line of r.stdout.split('\n')) parseSweepLine(line, found);
  } else {
    const r = await run('ps', ['-eo', 'pid=,args=']);
    for (const line of r.stdout.split('\n')) {
      if (line.includes('cli.js daemon start')) parseSweepLine(line, found);
    }
  }
  return found;
}

function parseSweepLine(line, found) {
  const m = line.trim().match(/^(\d+)[\s\t]+(.*)$/);
  if (!m) return;
  const wsMatch = m[2].match(/--workspace[= ]([^\s"]+|"[^"]+")/);
  found.push({
    pid: Number(m[1]),
    workspace: wsMatch ? wsMatch[1].replace(/"/g, '') : null,
    ageSecs: null,
    workspaceExists: wsMatch ? fs.existsSync(wsMatch[1].replace(/"/g, '')) : true,
  });
}

/** All running ruflo daemons, deduped by pid. */
export async function listDaemons({ cwd = process.cwd() } = {}) {
  const byPid = new Map();
  const workspaces = registryWorkspaces();
  workspaces.add(cwd); // the project we're standing in
  for (const ws of workspaces) {
    try {
      const d = daemonFromWorkspace(ws);
      if (d) byPid.set(d.pid, d);
    } catch { /* no pidfile here */ }
  }
  for (const d of await processSweep()) {
    if (!byPid.has(d.pid)) byPid.set(d.pid, d);
  }
  return [...byPid.values()];
}

/** Stale = workspace gone OR older than ttlSecs (0 disables age rule). */
export function staleDaemons(daemons, ttlSecs = Number(process.env.RUFLO_DAEMON_TTL_SECS ?? 43200)) {
  return daemons.filter((d) =>
    !d.workspaceExists || (ttlSecs > 0 && d.ageSecs !== null && d.ageSecs > ttlSecs));
}

export function reap(daemons) {
  const results = [];
  for (const d of daemons) {
    try { process.kill(d.pid); results.push({ ...d, killed: true }); }
    catch { results.push({ ...d, killed: false }); }
  }
  return results;
}

/** Cached machine-wide count for the statusline (shared tmp cache, TTL-gated —
 *  same contract as the footer's old pgrep cache). */
export async function cachedDaemonCount(ttlMs = 30_000) {
  const cache = path.join(os.tmpdir(), 'ruflo-daemon-count.json');
  const c = readJsonSafe(cache);
  if (c && typeof c.n === 'number' && Date.now() - c.ts < ttlMs) return c.n;
  const n = (await listDaemons()).length;
  try { fs.writeFileSync(cache, JSON.stringify({ ts: Date.now(), n })); } catch { /* ignore */ }
  return n;
}
