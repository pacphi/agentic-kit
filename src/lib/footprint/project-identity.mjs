// Additive grouping evidence. Working paths remain the discovery/count identity;
// a shared Git directory relates them without merging their measurements.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function canonical(file, fsImpl) {
  return (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(file);
}

function boundedText(file, fsImpl) {
  const stat = fsImpl.lstatSync(file);
  if (!stat.isFile() || stat.size > 4096) throw new Error('unreadable-git-metadata');
  return fsImpl.readFileSync(file, 'utf8').trim();
}

function directory(file, fsImpl) {
  if (!fsImpl.statSync(file).isDirectory()) throw new Error('invalid-git-directory');
  return canonical(file, fsImpl);
}

function linkedIdentity(marker, current, fsImpl) {
  const match = /^gitdir:\s*([^\r\n]+)\s*$/u.exec(boundedText(marker, fsImpl));
  if (!match) throw new Error('invalid-git-pointer');
  const gitDir = directory(path.resolve(current, match[1]), fsImpl);
  let common;
  try { common = boundedText(path.join(gitDir, 'commondir'), fsImpl); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (common === undefined) return { commonDir: gitDir, kind: 'git', evidence: 'git-pointer', root: current };
  if (!common) throw new Error('empty-git-common-directory');
  const commonDir = directory(path.resolve(gitDir, common), fsImpl);
  const backlink = boundedText(path.join(gitDir, 'gitdir'), fsImpl);
  if (canonical(path.resolve(gitDir, backlink), fsImpl) !== canonical(marker, fsImpl)) {
    throw new Error('git-backlink-mismatch');
  }
  // Bare repositories group by commonDir without inventing a main checkout.
  const candidate = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
  const root = candidate && directory(path.join(candidate, '.git'), fsImpl) === commonDir ? candidate : null;
  return { commonDir, kind: 'worktree', evidence: 'git-common-directory-and-backlink', root };
}

/** No retained-path/name/remote inference. Unknown means association unverified. */
export function inspectProjectIdentity(cwd, { fsImpl = fs, observedAt = Date.now() } = {}) {
  const base = { kind: 'unknown', repositoryId: null, commonDir: null, root: null,
    worktreeRoot: null, evidence: 'unavailable', observedAt };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return base;
  let current;
  try { current = directory(cwd, fsImpl); } catch { return base; }
  for (let depth = 0; depth < 128; depth++) {
    const marker = path.join(current, '.git');
    let stat;
    try { stat = fsImpl.lstatSync(marker); }
    catch (error) {
      if (error?.code !== 'ENOENT') return { ...base, evidence: 'git-metadata-unreadable' };
      const parent = path.dirname(current);
      if (parent === current) return { ...base, kind: 'folder', evidence: 'no-git-boundary' };
      current = parent;
      continue;
    }
    try {
      let identity;
      if (stat.isDirectory()) identity = { commonDir: directory(marker, fsImpl), kind: 'git', evidence: 'git-directory', root: current };
      else if (stat.isFile()) identity = linkedIdentity(marker, current, fsImpl);
      else throw new Error('invalid-git-marker');
      const { commonDir, kind, evidence, root } = identity;
      const repositoryId = `repository:${createHash('sha256').update(commonDir).digest('hex').slice(0, 20)}`;
      return { kind, repositoryId, commonDir, root, worktreeRoot: current, evidence, observedAt };
    } catch { return { ...base, evidence: 'git-metadata-unverified' }; }
  }
  return { ...base, evidence: 'ancestor-budget-exhausted' };
}
