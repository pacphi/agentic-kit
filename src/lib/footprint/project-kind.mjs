// Presentation evidence only. Never use this classification in project identity
// or action authorization, and never turn an unreadable marker into non-Git.
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_KINDS = Object.freeze(['git', 'folder', 'worktree', 'unknown']);
export const PROJECT_KIND_LABELS = Object.freeze({ git: 'Git', folder: 'Folder', worktree: 'Worktree', unknown: 'Not checked' });

function boundedText(file, fsImpl) {
  const stat = fsImpl.lstatSync(file);
  if (!stat.isFile() || stat.size > 4096) return null;
  return fsImpl.readFileSync(file, 'utf8').trim();
}

function linkedKind(marker, stat, fsImpl) {
  if (stat.size > 4096) return 'unknown';
  const match = /^gitdir:\s*([^\r\n]+)\s*$/u.exec(fsImpl.readFileSync(marker, 'utf8').trim());
  if (!match) return 'unknown';
  const target = path.resolve(path.dirname(marker), match[1]);
  if (!fsImpl.lstatSync(target).isDirectory()) return 'unknown';
  if (/[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/u.test(target)) return 'worktree';
  // Bare repositories and separate Git directories need not be named .git.
  // The shared directory plus reverse pointer establishes a linked worktree.
  try {
    const common = boundedText(path.join(target, 'commondir'), fsImpl);
    const backlink = boundedText(path.join(target, 'gitdir'), fsImpl);
    if (common && backlink && fsImpl.lstatSync(path.resolve(target, common)).isDirectory()
      && path.resolve(target, backlink) === path.resolve(marker)) return 'worktree';
  } catch { /* A valid ordinary gitdir does not require worktree metadata. */ }
  return 'git';
}

/** Include a containing repository when a retained working folder is nested.
 * Only a readable folder with no Git marker through its ancestors is Folder. */
export function measureProjectKind(root, { fsImpl = fs } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return 'unknown';
  try { if (!fsImpl.lstatSync(root).isDirectory()) return 'unknown'; } catch { return 'unknown'; }
  let current = path.resolve(root);
  for (let depth = 0; depth < 128; depth++) {
    const marker = path.join(current, '.git');
    try {
      const stat = fsImpl.lstatSync(marker);
      if (stat.isDirectory()) return 'git';
      if (stat.isFile()) {
        try { return linkedKind(marker, stat, fsImpl); } catch { return 'unknown'; }
      }
      return 'unknown';
    } catch (error) {
      if (error?.code !== 'ENOENT') return 'unknown';
    }
    const parent = path.dirname(current);
    if (parent === current) return 'folder';
    current = parent;
  }
  return 'unknown';
}
