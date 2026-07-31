import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WORKTREE_MARKERS = new Set(['.autopilot', '.claude', '.git', '.worktrees', 'worktrees']);

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
export function resolveProjectLabel(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown';
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  for (let index = 1; index < segments.length - 1; index++) {
    if (WORKTREE_MARKERS.has(segments[index])
      && (['.worktrees', 'worktrees'].includes(segments[index])
        || segments[index + 1] === 'worktrees')) {
      return safeProjectLabel(segments[index - 1]);
    }
  }
  // Sessions frequently run from a subdirectory of their repository, so walk
  // toward the root for the nearest .git marker: "repo/scripts" belongs to
  // "repo", not to a phantom "scripts" project. Only one basename is ever
  // exposed, and retained paths that no longer exist keep the cwd fallback.
  let current = cwd;
  for (let depth = 0; depth < 32; depth++) {
    let marker = null;
    try { marker = fs.statSync(path.join(current, '.git')).isDirectory() ? 'dir' : 'file'; }
    catch { /* not a repository boundary; retained paths may be gone entirely */ }
    if (marker === 'file') {
      try {
        const pointer = fs.readFileSync(path.join(current, '.git'), 'utf8').trim();
        const match = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/i.exec(pointer);
        if (match) return safeProjectLabel(match[1]);
      } catch { /* unreadable pointer: the marker directory is still the root */ }
      return safeProjectLabel(current);
    }
    if (marker === 'dir') return safeProjectLabel(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return safeProjectLabel(cwd);
}

/** Opaque, deterministic identity derived only from the already-safe display label. */
export function stableProjectKey(project) {
  const label = safeProjectLabel(project);
  const canonical = label.normalize('NFKC').toLocaleLowerCase('en-US');
  return `project:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

/** Host qualification prevents Claude and Codex sessions with the same native id colliding. */
export function canonicalSessionKey(host, sessionId) {
  return `${host}:${sessionId}`;
}
