// Parse-time evidence only. Aggregation/rendering never probes a filesystem.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectProjectIdentity } from './footprint/project-identity.mjs';
import { transcriptSessionOrigin } from './footprint/session-origin.mjs';
import { safeProjectLabel } from './live/project-label.mjs';

const CACHE = new Map();
const keyFor = (value) => `working:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;

export function observeUsageProject(cwd, { observedAt = Date.now(), cache = CACHE } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const prior = cache.get(cwd);
  if (prior && observedAt - prior.observedAt >= 0 && observedAt - prior.observedAt < 60_000) return prior;
  const repository = inspectProjectIdentity(cwd, { observedAt });
  let workingPath = repository.worktreeRoot ?? cwd;
  try { workingPath = fs.realpathSync(workingPath); } catch { workingPath = path.resolve(workingPath); }
  const value = { key: keyFor(workingPath), label: safeProjectLabel(workingPath), kind: repository.kind,
    repositoryId: repository.repositoryId,
    repositoryLabel: repository.repositoryId ? safeProjectLabel(repository.root ?? repository.commonDir) : null,
    evidence: repository.evidence, observedAt, observationBasis: 'current-filesystem' };
  if (cache.size >= 2048) cache.delete(cache.keys().next().value);
  cache.set(cwd, value);
  return value;
}

/** Same bounded head and exact origin allowlists as footprint discovery. */
export function usageSessionOrigin(raw, host) {
  const head = Buffer.from(String(raw).slice(0, 256 * 1024)).subarray(0, 256 * 1024).toString('utf8');
  return transcriptSessionOrigin(head.split('\n').filter((line) => line.trim()).slice(0, 40), host);
}
