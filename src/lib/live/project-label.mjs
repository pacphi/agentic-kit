import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WORKTREE_MARKERS = new Set(['.autopilot', '.claude', '.git', '.worktrees', 'worktrees']);

const hashProject = (value) => `project:${createHash('sha256')
  .update(value).digest('hex').slice(0, 16)}`;

/** Derive a display label from an explicit cwd without retaining path segments. */
export function safeProjectLabel(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown';
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const label = normalized.split('/').pop();
  if (!label || label === '.' || label === '..') return 'unknown';
  return label.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 96) || 'unknown';
}

/**
 * Resolve a cwd to its owning repository without exposing the path. Linked Git
 * worktrees carry a `.git` file pointing into `<repo>/.git/worktrees/<name>`;
 * retained paths may no longer exist, so known nested layouts are a fallback.
 */
function resolveProjectRoot(cwd, { fsImpl = fs } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  // Sessions frequently run from a subdirectory of their repository, so walk
  // toward the root for the nearest .git marker: "repo/scripts" belongs to
  // "repo", not to a phantom "scripts" project. Only one basename is ever
  // exposed, and retained paths that no longer exist keep the cwd fallback.
  let current = cwd;
  for (let depth = 0; depth < 32; depth++) {
    let marker = null;
    try { marker = fsImpl.statSync(path.join(current, '.git')).isDirectory() ? 'dir' : 'file'; }
    catch { /* not a repository boundary; retained paths may be gone entirely */ }
    if (marker === 'file') {
      try {
        const pointer = fsImpl.readFileSync(path.join(current, '.git'), 'utf8').trim();
        const match = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/i.exec(pointer);
        if (match) return path.resolve(current, match[1]);
      } catch { /* unreadable pointer: the marker directory is still the root */ }
      return current;
    }
    if (marker === 'dir') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Retained transcript paths may point at a worktree that has already been
  // removed. Apply the layout heuristic only after filesystem evidence has
  // been exhausted so a real nested repository always wins.
  const segments = normalized.split('/').filter(Boolean);
  for (let index = 1; index < segments.length - 1; index++) {
    if (WORKTREE_MARKERS.has(segments[index])
      && (['.worktrees', 'worktrees'].includes(segments[index])
        || segments[index + 1] === 'worktrees')) {
      const rootSegments = segments.slice(0, index);
      return `${normalized.startsWith('/') ? '/' : ''}${rootSegments.join('/')}`;
    }
  }
  return null;
}

/**
 * Resolve a runtime cwd to a privacy-safe repository label and opaque identity.
 * The key hashes the canonical repository root, so unrelated same-named repos
 * remain distinct without exposing either path. Retained paths fall back to
 * the display label because no repository boundary can be proven.
 */
export function resolveProjectIdentity(cwd, { fsImpl = fs } = {}) {
  const root = resolveProjectRoot(cwd, { fsImpl });
  const rawLabel = safeProjectLabel(root ?? cwd);
  const label = root && rawLabel === 'unknown' ? 'unknown repository' : rawLabel;
  if (label === 'unknown') {
    return { label, key: stableProjectKey(label), canonical: false };
  }
  let hasGitMarker = false;
  try { hasGitMarker = Boolean(root && fsImpl.statSync(path.join(root, '.git'))); } catch { /* fallback */ }
  let canonical = hasGitMarker ? root : null;
  if (canonical) {
    try {
      const realpath = fsImpl.realpathSync?.native ?? fsImpl.realpathSync;
      canonical = realpath ? realpath(root) : path.resolve(root);
    } catch { canonical = path.resolve(root); }
  }
  return {
    label,
    canonical: hasGitMarker,
    key: canonical
      ? hashProject(`root\0${canonical.replaceAll('\\', '/').normalize('NFKC')}`)
      : stableProjectKey(label),
  };
}

export function resolveProjectLabel(cwd) {
  return resolveProjectIdentity(cwd).label;
}

/** Opaque, deterministic identity derived only from the already-safe display label. */
export function stableProjectKey(project) {
  const label = safeProjectLabel(project);
  const canonical = label.normalize('NFKC').toLocaleLowerCase('en-US');
  return hashProject(canonical);
}

/** Accept only the opaque key shape produced above; untrusted adapters fall back. */
export function safeProjectKey(value, project) {
  return typeof value === 'string' && /^project:[a-f0-9]{16}$/.test(value)
    ? value : stableProjectKey(project);
}

/** Host qualification prevents Claude and Codex sessions with the same native id colliding. */
export function canonicalSessionKey(host, sessionId) {
  return `${host}:${sessionId}`;
}
