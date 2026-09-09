// Parse-time evidence only. Aggregation/rendering never probes a filesystem.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { inspectProjectIdentity } from './footprint/project-identity.mjs';
import { transcriptSessionOrigin } from './footprint/session-origin.mjs';
import { safeProjectLabel } from './live/project-label.mjs';
import { claudeDir, codexDir, opencodeDir, configDir } from './paths.mjs';

const CACHE = new Map();
const keyFor = (value) => `working:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
let rootObservation = null;

function canonicalPath(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  let resolved;
  try { resolved = (fs.realpathSync.native ?? fs.realpathSync)(candidate); } catch { resolved = path.resolve(candidate); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function userRootObservation(roots) {
  const signature = JSON.stringify(roots);
  if (rootObservation?.signature !== signature) {
    rootObservation = { signature, roots: new Set(roots.map(canonicalPath).filter(Boolean)) };
  }
  return rootObservation;
}
function hasRealParentRoot(repository) {
  if (!repository.root || !repository.commonDir) return false;
  try {
    if (!fs.statSync(repository.root).isDirectory()) return false;
    const file = path.join(repository.commonDir, 'HEAD'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return false;
    return /^(?:ref: refs\/[^\s]+|[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(fs.readFileSync(file, 'utf8').trim());
  } catch { return false; }
}

export function observeUsageProject(cwd, { observedAt = Date.now(), cache = CACHE,
  userRoots = [os.homedir(), claudeDir(), codexDir(), opencodeDir(), configDir()] } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const scope = userRootObservation(userRoots), cacheKey = `${cwd}\0${scope.signature}`;
  const prior = cache.get(cacheKey);
  if (prior && observedAt - prior.observedAt >= 0 && observedAt - prior.observedAt < 60_000) return prior;
  const repository = inspectProjectIdentity(cwd, { observedAt });
  let workingPath = repository.worktreeRoot ?? cwd;
  try { workingPath = (fs.realpathSync.native ?? fs.realpathSync)(workingPath); } catch { workingPath = path.resolve(workingPath); }
  const value = { key: keyFor(workingPath), label: safeProjectLabel(workingPath), kind: repository.kind,
    repositoryId: repository.repositoryId,
    repositoryLabel: repository.repositoryId ? safeProjectLabel(repository.root ?? repository.commonDir) : null,
    parentRootExists: hasRealParentRoot(repository),
    userLevel: [cwd, workingPath, repository.root].some((candidate) => scope.roots.has(canonicalPath(candidate))),
    evidence: repository.evidence, observedAt, observationBasis: 'current-filesystem' };
  if (cache.size >= 2048) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, value);
  return value;
}

/** Same bounded head and exact origin allowlists as footprint discovery. */
export function usageSessionOrigin(raw, host) {
  const head = Buffer.from(String(raw).slice(0, 256 * 1024)).subarray(0, 256 * 1024).toString('utf8');
  return transcriptSessionOrigin(head.split('\n').filter((line) => line.trim()).slice(0, 40), host);
}
