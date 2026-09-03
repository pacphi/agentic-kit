// Daemon discovery — pidfile/registry-first (3.28's own state files), with a
// process-table sweep as fallback for pre-3.28 strays. Replaces the shell
// kit's `ps -eo pid,etime,args` parsing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { run } from './exec.mjs';
import { isWindows, home } from './paths.mjs';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Known-workspace discovery from ruflo's machine-level registries
 *  (~/.claude-flow/*.json record workspaces; each workspace has
 *  .claude-flow/daemon.pid + daemon-state.json with startedAt).
 *
 *  Module-private again: it was exported so the (now retired)
 *  project-discovery.mjs could reuse it verbatim as a project-discovery
 *  source. Project discovery moved to the shared census (ADR-0027), which
 *  reads session transcripts rather than these registries — the registries do
 *  not exist on every machine, which is precisely why they made a poor
 *  discovery source. Only daemon accounting reads them now. */
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

/** Match only executable shapes that directly launch Ruflo's stdio MCP
 * transport. A shell whose payload merely contains the words is deliberately
 * excluded: cleanup must identify the process itself, not a descendant or a
 * diagnostic command such as grep/echo. */
export function isRufloMcpCommand(command) {
  const text = String(command ?? '').trim();
  if (!text || /^(?:sh|bash|zsh|fish|cmd|powershell)(?:\.exe)?\s/i.test(text)) return false;
  return /^(?:node(?:\.exe)?\s+\S*(?:cli|ruflo)(?:\.m?js)?|\S*[\\/]?ruflo(?:\.cmd|\.exe)?|npx(?:\.cmd)?(?:\s+-\S+)*\s+ruflo(?:@\S+)?|npm(?:\.cmd)?\s+exec(?:\s+-\S+)*\s+ruflo(?:@\S+)?)\s+mcp\s+start(?:\s|$)/i.test(text);
}

/** Parse `uid pid ppid args` process output into an MCP transport row. A `-`
 * uid is accepted for Windows visibility, but can never pass orphan cleanup's
 * same-user proof. */
export function parseMcpTransportLine(line, found) {
  const match = String(line).trim().match(/^(\d+|-)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match || !isRufloMcpCommand(match[4])) return;
  found.push({
    uid: match[1] === '-' ? null : Number(match[1]),
    pid: Number(match[2]),
    ppid: Number(match[3]),
    command: match[4],
  });
}

/** Running Ruflo MCP stdio transports. This is visibility only: ordinary
 * parented transports are legitimate (one per active host/session) and are
 * never classified as stale by age, count, or workspace. */
export async function listMcpTransports({ runner = run } = {}) {
  const found = [];
  if (isWindows) {
    const result = await runner('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'mcp start' } | ForEach-Object { \"-`t$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }"]);
    for (const line of result.stdout.split('\n')) parseMcpTransportLine(line, found);
  } else {
    const result = await runner('ps', ['-eo', 'uid=,pid=,ppid=,args=']);
    for (const line of result.stdout.split('\n')) parseMcpTransportLine(line, found);
  }
  return found;
}

/** A stdio MCP server is provably orphaned only after its parent disappeared
 * and init adopted it (PPID 1), and only when its OS uid is this user. Unknown
 * ownership (notably Windows' basic CIM census) fails closed to no candidates. */
export function orphanedMcpTransports(transports, {
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  if (!Number.isInteger(uid)) return [];
  return (transports ?? []).filter((entry) =>
    entry?.uid === uid && entry?.ppid === 1 && isRufloMcpCommand(entry.command));
}

function inspectMcpTransport(pid) {
  if (!Number.isFinite(pid) || isWindows) return null;
  try {
    const line = execFileSync('ps', ['-p', String(pid), '-o', 'uid=,pid=,ppid=,args='], {
      encoding: 'utf8', timeout: 10_000,
    });
    const found = [];
    parseMcpTransportLine(line, found);
    return found[0] ?? null;
  } catch {
    return null;
  }
}

/** Reap only previously disclosed MCP orphans, re-probing immediately before
 * SIGTERM to defend against PID reuse and a transport gaining a real parent.
 * No age/count/workspace heuristic is accepted as kill authority. */
export function reapMcpTransports(transports, {
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  inspect = inspectMcpTransport,
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const results = [];
  for (const candidate of orphanedMcpTransports(transports, { uid })) {
    const current = inspect(candidate.pid);
    const verified = current
      && orphanedMcpTransports([current], { uid }).length === 1
      && current.pid === candidate.pid
      && current.command === candidate.command;
    if (!verified) {
      results.push({ ...candidate, killed: false, identityChanged: true });
      continue;
    }
    try {
      kill(candidate.pid, 'SIGTERM');
      results.push({ ...candidate, killed: true });
    } catch {
      results.push({ ...candidate, killed: false });
    }
  }
  return results;
}

export function parseSweepLine(line, found) {
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

/** True when `pid`'s command line looks like a ruflo daemon (`daemon start`).
 *  Guards reap() against pidfile pid-reuse: an orphaned daemon.pid whose pid
 *  the OS recycled onto an unrelated same-user process must not get our
 *  SIGTERM. The process-sweep path already matches cmdline; this brings the
 *  workspace/registry path up to the same standard, on every platform —
 *  POSIX via `ps`, Windows via the same CIM query the sweep uses (pid is
 *  numeric-coerced into the filter, so nothing user-shaped reaches the
 *  command). Unconfirmable (probe fails, no output) → false: never kill what
 *  we can't identify. */
function isDaemonProcess(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    const args = isWindows
      ? execFileSync('powershell', ['-NoProfile', '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
        { encoding: 'utf8', timeout: 10_000 })
      : execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    return /daemon start/.test(args);
  } catch { return false; }
}

export function reap(daemons) {
  const results = [];
  for (const d of daemons) {
    if (!isDaemonProcess(d.pid)) { results.push({ ...d, killed: false, pidReused: true }); continue; }
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
