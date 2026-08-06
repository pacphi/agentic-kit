import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inspectGitWorkspace } from './git-workspace.mjs';

const execFileAsync = promisify(execFile);

// Off by default (ADR-0023 §5/§4 precedent: AK_STATUSLINE_DEBUG). Set
// AK_RUNTIME_DEBUG=1 to trace why a controller process was or wasn't
// surfaced — which rows the ps survey saw, which were classified as a
// host, which got dropped as a nested child of another candidate, and
// whether cwd resolution found each controller. Unlike the statusline
// diagnostic (which runs on every keystroke for users who may not even
// know the flag exists), this is opt-in and single-purpose, so the cwd
// path IS logged — it's the exact fact being debugged and it's not a
// secret. Raw argv/command strings are still never logged: a pasted
// prompt or token could be sitting in there.
function runtimeDebug(stage, fields = {}) {
  if (!process?.env || process.env.AK_RUNTIME_DEBUG !== '1') return;
  try {
    const root = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    const file = process.env.AK_RUNTIME_DEBUG_FILE || path.join(root, 'agentic-kit', 'runtime-debug.log');
    const safeStage = String(stage || 'unknown').replace(/[^a-z0-9._-]/gi, '_').slice(0, 64);
    const kv = Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v).replace(/[\s\n]+/g, '_').slice(0, 200)}`)
      .join(' ');
    const line = `${new Date().toISOString()} stage=${safeStage} ${kv}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first write */ }
    if (size >= 65536) fs.writeFileSync(file, line, { mode: 0o600 });
    else fs.appendFileSync(file, line, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
  } catch { /* diagnostics must never break discovery */ }
}
const HOST_NAMES = new Map([
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
]);

const tokens = (command) => String(command ?? '').trim().split(/\s+/)
  .map((token) => token.replace(/^['"]|['"]$/g, ''));
const executableName = (value) => path.basename(String(value ?? '')).toLowerCase()
  .replace(/\.exe$/, '');

/** Identify only a controller executable or its supported Node launcher. */
export function hostFromCommand(command, executable = null) {
  const argv = tokens(command);
  const program = executableName(executable ?? argv[0]);
  let host = HOST_NAMES.get(program) ?? null;
  let argumentOffset = executable == null || executableName(argv[0]) === program ? 1 : 0;
  if (!host && ['node', 'nodejs'].includes(program)) {
    const wrapperIndex = executable == null || executableName(argv[0]) === program ? 1 : 0;
    host = HOST_NAMES.get(executableName(argv[wrapperIndex])) ?? null;
    argumentOffset = wrapperIndex + 1;
  }
  if (host === 'codex' && argv[argumentOffset] === 'mcp-server') return null;
  return host;
}

/** Parse `ps -axo pid=,ppid=,lstart=,comm=,args=` without command guessing. */
export function parseProcessList(output) {
  const rows = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/;
  for (const line of String(output ?? '').split('\n')) {
    const match = pattern.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3],
      executable: match[4], command: match[5],
    });
  }
  return rows;
}

/** Parse the privacy-minimized first survey, which deliberately omits argv. */
export function parseProcessHeaders(output) {
  const rows = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*$/;
  for (const line of String(output ?? '').split('\n')) {
    const match = pattern.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3],
      executable: match[4], command: '',
    });
  }
  return rows;
}

function parseArgsByPid(output) {
  const commands = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return commands;
}

function rootControllers(rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const candidates = new Map();
  for (const row of rows) {
    const host = hostFromCommand(row.command, row.executable);
    if (host) candidates.set(row.pid, { ...row, host });
    else if (row.command) runtimeDebug('classify', { pid: row.pid, exe: row.executable, host: 'none' });
  }
  const roots = [...candidates.values()].filter((candidate) => {
    const seen = new Set([candidate.pid]);
    let parent = byPid.get(candidate.ppid);
    while (parent && !seen.has(parent.pid)) {
      if (candidates.has(parent.pid)) {
        runtimeDebug('exclude-nested-child', { pid: candidate.pid, host: candidate.host, parentPid: parent.pid });
        return false;
      }
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
    return true;
  });
  for (const root of roots) runtimeDebug('root-controller', { pid: root.pid, host: root.host });
  return roots;
}

async function linuxCwds(pids) {
  const found = new Map();
  await Promise.all(pids.map(async (pid) => {
    try { found.set(pid, await fs.promises.readlink(`/proc/${pid}/cwd`)); }
    catch { /* process exited between ps and readlink */ }
  }));
  return found;
}

/** Parse lsof's field output: p<pid> followed by n<cwd>. */
export function parseLsofCwds(output) {
  const found = new Map();
  let pid = null;
  for (const line of String(output ?? '').split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (pid != null && line.startsWith('n/')) found.set(pid, line.slice(1));
  }
  return found;
}

async function darwinCwds(pids, run) {
  if (!pids.length) return new Map();
  const args = ['-n', '-a', '-d', 'cwd', '-Fpn'];
  for (const pid of pids) args.push('-p', String(pid));
  try {
    const result = await run('lsof', args, {
      encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
    });
    return parseLsofCwds(typeof result === 'string' ? result : result.stdout);
  } catch (error) {
    const partial = parseLsofCwds(error?.stdout);
    if (partial.size) return partial;
    throw Object.assign(new Error('runtime cwd survey failed'), {
      code: 'ERR_RUNTIME_CWD_SURVEY',
    });
  }
}

/**
 * Observe top-level Claude Code, Codex and OpenCode controller processes.
 * Child host CLIs remain part of their parent controller's execution graph.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   execFileImpl?: typeof execFileAsync,
 *   processRows?: Array<{
 *     pid:number, ppid:number, startedAt:string, executable:string, command:string
 *   }>,
 *   cwdByPid?: Map<number, string>
 *   inspectWorkspace?: typeof inspectGitWorkspace
 *   uid?: number
 * }} [options]
 */
export async function listActiveHostSessions({
  platform = process.platform,
  execFileImpl = execFileAsync,
  processRows,
  cwdByPid,
  inspectWorkspace = (cwd) => inspectGitWorkspace(cwd, { execFileImpl }),
  uid = process.getuid?.(),
} = {}) {
  if (platform === 'win32') {
    throw Object.assign(new Error('runtime process survey is unsupported on Windows'), {
      code: 'ERR_RUNTIME_UNSUPPORTED',
    });
  }
  let rows = processRows;
  if (!rows) {
    if (!Number.isInteger(uid) || uid < 0) {
      throw Object.assign(new Error('runtime process survey cannot determine the current user'), {
        code: 'ERR_RUNTIME_PROCESS_SURVEY',
      });
    }
    try {
      const result = await execFileImpl('ps', [
        '-U', String(uid), '-x', '-o', 'pid=,ppid=,lstart=,comm=',
      ], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' } });
      const output = typeof result === 'string' ? result : result.stdout;
      rows = parseProcessHeaders(output);
      runtimeDebug('survey', { uid, rowCount: rows.length });
      if (String(output ?? '').trim() && !rows.length) {
        throw Object.assign(new Error('runtime process output was not understood'), {
          code: 'ERR_RUNTIME_PROCESS_FORMAT',
        });
      }
      // argv can contain sensitive prompts/tokens. Fetch it only for executables
      // that can actually be a supported controller or Node launcher.
      const possible = rows.filter((row) => {
        const name = executableName(row.executable);
        return HOST_NAMES.has(name) || name === 'node' || name === 'nodejs';
      });
      runtimeDebug('argv-candidates', { count: possible.length, pids: possible.map((r) => r.pid).join(',') });
      if (possible.length) {
        const argsResult = await execFileImpl('ps', [
          '-p', possible.map((row) => row.pid).join(','), '-o', 'pid=,args=',
        ], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
          env: { ...process.env, LC_ALL: 'C' } });
        const commands = parseArgsByPid(typeof argsResult === 'string' ? argsResult : argsResult.stdout);
        rows = rows.map((row) => commands.has(row.pid)
          ? { ...row, command: commands.get(row.pid) } : row);
      }
    } catch (error) {
      runtimeDebug('survey-failed', { name: error?.name, code: error?.code });
      throw Object.assign(new Error('runtime process survey failed'), {
        code: 'ERR_RUNTIME_PROCESS_SURVEY',
      });
    }
  }
  const controllers = rootControllers(rows);
  const pids = controllers.map((row) => row.pid);
  const cwds = cwdByPid ?? (platform === 'linux'
    ? await linuxCwds(pids) : await darwinCwds(pids, execFileImpl));
  for (const pid of pids) runtimeDebug('cwd', { pid, found: cwds.has(pid), cwd: cwds.get(pid) ?? '' });
  const workspaceByCwd = new Map();
  await Promise.all([...new Set(cwds.values())].map(async (cwd) => {
    try { workspaceByCwd.set(cwd, await inspectWorkspace(cwd)); }
    catch { workspaceByCwd.set(cwd, null); }
  }));
  const sessions = controllers.flatMap((row) => {
    const cwd = cwds.get(row.pid);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      runtimeDebug('drop-no-cwd', { pid: row.pid, host: row.host });
      return [];
    }
    const workspace = workspaceByCwd.get(cwd);
    return workspace
      ? [{ pid: row.pid, startedAt: row.startedAt, host: row.host, cwd, workspace }]
      : [{ pid: row.pid, startedAt: row.startedAt, host: row.host, cwd }];
  }).sort((left, right) => left.pid - right.pid);
  runtimeDebug('result', { sessionCount: sessions.length });
  return sessions;
}
