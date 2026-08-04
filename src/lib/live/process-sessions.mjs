import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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

function rootControllers(rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const candidates = new Map();
  for (const row of rows) {
    const host = hostFromCommand(row.command, row.executable);
    if (host) candidates.set(row.pid, { ...row, host });
  }
  return [...candidates.values()].filter((candidate) => {
    const seen = new Set([candidate.pid]);
    let parent = byPid.get(candidate.ppid);
    while (parent && !seen.has(parent.pid)) {
      if (candidates.has(parent.pid)) return false;
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
    return true;
  });
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
 * }} [options]
 */
export async function listActiveHostSessions({
  platform = process.platform,
  execFileImpl = execFileAsync,
  processRows,
  cwdByPid,
} = {}) {
  if (platform === 'win32') {
    throw Object.assign(new Error('runtime process survey is unsupported on Windows'), {
      code: 'ERR_RUNTIME_UNSUPPORTED',
    });
  }
  let rows = processRows;
  if (!rows) {
    try {
      const result = await execFileImpl('ps', [
        '-axo', 'pid=,ppid=,lstart=,comm=,args=',
      ], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
      rows = parseProcessList(typeof result === 'string' ? result : result.stdout);
    } catch {
      throw Object.assign(new Error('runtime process survey failed'), {
        code: 'ERR_RUNTIME_PROCESS_SURVEY',
      });
    }
  }
  const controllers = rootControllers(rows);
  const pids = controllers.map((row) => row.pid);
  const cwds = cwdByPid ?? (platform === 'linux'
    ? await linuxCwds(pids) : await darwinCwds(pids, execFileImpl));
  return controllers.flatMap((row) => {
    const cwd = cwds.get(row.pid);
    return typeof cwd === 'string' && path.isAbsolute(cwd)
      ? [{ pid: row.pid, startedAt: row.startedAt, host: row.host, cwd }] : [];
  }).sort((left, right) => left.pid - right.pid);
}
