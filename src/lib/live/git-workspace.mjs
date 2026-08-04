import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CACHE = new Map();
const SECRET_SHAPE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:secret|token|password|api[_-]?key)[=:][^/\s]{8,})/gi;

const stripControls = (value) => [...value]
  .filter((character) => {
    const code = character.codePointAt(0);
    return code != null && code > 31 && code !== 127;
  }).join('');

const bounded = (value, max = 160) => {
  if (typeof value !== 'string') return null;
  const clean = stripControls(value).replace(SECRET_SHAPE, '…redacted').trim();
  return clean ? clean.slice(0, max) : null;
};

export function parseGitNumstat(output) {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  let binaryFiles = 0;
  for (const line of String(output ?? '').split('\n')) {
    if (!line) continue;
    const [added, deleted] = line.split('\t', 3);
    if (added === '-' || deleted === '-') { binaryFiles++; files++; continue; }
    const plus = Number(added);
    const minus = Number(deleted);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
    additions += Math.max(0, plus);
    deletions += Math.max(0, minus);
    files++;
  }
  return { additions, deletions, files, binaryFiles };
}

function opaqueWorkspaceKey(root) {
  let canonical;
  try { canonical = fs.realpathSync.native(root); } catch { canonical = path.resolve(root); }
  return `workspace:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

async function runGit(run, cwd, args) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key];
  }
  const result = await run('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', timeout: 2500, maxBuffer: 2 * 1024 * 1024,
    env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return String(typeof result === 'string' ? result : result.stdout ?? '').trim();
}

/**
 * Read a privacy-bounded snapshot of one Git working tree. Counts describe
 * tracked files compared with HEAD; they are never session attribution.
 */
export async function inspectGitWorkspace(cwd, {
  execFileImpl = execFileAsync, now = () => new Date().toISOString(),
  cache = CACHE, cacheMs = 5_000,
} = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let canonicalCwd;
  try { canonicalCwd = fs.realpathSync.native(cwd); } catch { canonicalCwd = path.resolve(cwd); }
  const prior = cache?.get(canonicalCwd);
  const currentMs = Date.parse(now());
  if (prior && Number.isFinite(currentMs) && currentMs - prior.cachedAt < cacheMs) {
    return prior.value;
  }
  let root;
  try { root = await runGit(execFileImpl, canonicalCwd, ['rev-parse', '--show-toplevel']); }
  catch { return null; }
  if (!path.isAbsolute(root)) return null;
  try { root = fs.realpathSync.native(root); } catch { root = path.resolve(root); }
  const relative = path.relative(root, canonicalCwd).replaceAll('\\', '/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const directoryLabel = !relative || relative === '.' ? 'repo root' : bounded(relative, 180);
  let branchLabel = null;
  let branchState;
  try {
    branchLabel = bounded(await runGit(execFileImpl, root,
      ['symbolic-ref', '--quiet', '--short', 'HEAD']));
    branchState = branchLabel ? 'attached' : 'unknown';
  } catch {
    try {
      const revision = bounded(await runGit(execFileImpl, root, ['rev-parse', '--short', 'HEAD']), 24);
      branchLabel = revision ? `detached@${revision}` : null;
      branchState = revision ? 'detached' : 'unborn';
    } catch { branchState = 'unborn'; }
  }
  let changes = null;
  try {
    changes = {
      ...parseGitNumstat(await runGit(execFileImpl, root,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', 'HEAD', '--'])),
      basis: 'tracked-vs-head', completeness: 'untracked-and-binary-lines-excluded',
    };
  } catch { /* no HEAD or Git inspection unavailable: never fabricate zero */ }
  const capturedAt = now();
  if (changes) changes.capturedAt = capturedAt;
  const value = {
    key: opaqueWorkspaceKey(root), repositoryLabel: bounded(path.basename(root), 96),
    directoryLabel, branchLabel, branchState, changes, capturedAt,
    source: 'git', confidence: 'observed',
  };
  if (cache) cache.set(canonicalCwd, { cachedAt: Date.parse(capturedAt), value });
  return value;
}

export function workspaceFromSource({ cwd, branch, project, capturedAt, source }) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const branchLabel = bounded(branch);
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  const projectIndex = parts.lastIndexOf(String(project ?? ''));
  const relative = projectIndex >= 0 ? parts.slice(projectIndex + 1).join('/') : '';
  return {
    key: null,
    repositoryLabel: bounded(project, 96),
    directoryLabel: bounded(relative, 180) ?? 'repo root',
    branchLabel,
    branchState: branchLabel ? 'attached' : 'unknown',
    changes: null,
    capturedAt,
    source: bounded(source, 48) ?? 'source', confidence: 'observed',
  };
}
