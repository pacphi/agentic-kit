// Persisted OpenCode source selection. Never infer an installation channel from
// a filename, version, or mtime, and never combine potentially copied stores.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { xdgBase } from './paths.mjs';

// Reject filesystem control bytes rather than letting path normalization hide them.
// eslint-disable-next-line no-control-regex
const validPath = (value) => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/u.test(value);
const unavailable = (reason, status = 'degraded') => ({ dbFile: null, legacyRoot: null, sourceIdentity: null, health: { status, reason } });

function selected(file, selection, fsImpl) {
  if (!validPath(file) || !path.isAbsolute(file)) return unavailable('database-path-invalid');
  let dbFile = path.resolve(file);
  try { dbFile = fsImpl.realpathSync(dbFile); }
  catch (error) {
    if (error.code !== 'ENOENT') return unavailable('database-path-unreadable');
  }
  return { dbFile, legacyRoot: path.join(path.dirname(dbFile), 'storage'), sourceIdentity: createHash('sha256').update(dbFile).digest('hex'),
    health: { status: 'ok', reason: null, selection } };
}

function discover(dataRoot, fsImpl) {
  let dir;
  const candidates = new Set();
  try { dir = fsImpl.opendirSync(dataRoot); }
  catch (error) {
    return error.code === 'ENOENT'
      ? selected(path.join(dataRoot, 'opencode.db'), 'discovered', fsImpl)
      : unavailable('database-discovery-unreadable');
  }
  try {
    try {
      for (let count = 0; ; count++) {
        const entry = dir.readSync();
        if (!entry) break;
        if (count >= 256) return unavailable('database-discovery-limit');
        if (!/^opencode(?:-[A-Za-z0-9_-]+)?\.db$/.test(entry.name)) continue;
        const candidate = selected(path.join(dataRoot, entry.name), 'discovered', fsImpl);
        if (!candidate.dbFile) return candidate;
        if (!fsImpl.statSync(candidate.dbFile).isFile()) return unavailable('database-path-invalid');
        candidates.add(candidate.dbFile);
      }
    } finally { dir.closeSync(); }
  } catch {
    // Once the root opened, any read/stat/close failure leaves enumeration
    // incomplete. A missing candidate cannot establish a unique source.
    return unavailable('database-discovery-unreadable');
  }
  if (candidates.size > 1) return unavailable('database-selection-ambiguous');
  return selected([...candidates][0] ?? path.join(dataRoot, 'opencode.db'), 'discovered', fsImpl);
}

/** @param {{roots?: {opencode?: string}, env?: NodeJS.ProcessEnv, fsImpl?: typeof fs}} [options] */
export function selectOpencodeSource({ roots, env = process.env, fsImpl = fs } = {}) {
  if (roots !== undefined) return roots?.opencode === undefined
    ? unavailable(null, 'absent') : selected(roots.opencode, 'explicit-root', fsImpl);
  const override = env.OPENCODE_DB;
  if (override && (!validPath(override) || override.split(/[\\/]/).includes('..'))) return unavailable('database-path-invalid');
  const direct = override === ':memory:' ? unavailable('database-in-memory')
    : override && path.isAbsolute(override) ? selected(override, 'environment', fsImpl) : null;
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const base = xdgBase('XDG_DATA_HOME', null, { env }) ?? path.join(home, '.local', 'share');
  if (!validPath(base) || !path.isAbsolute(base)) return direct
    ? { ...direct, legacyRoot: null } : unavailable('database-path-invalid');
  const dataRoot = path.join(base, 'opencode');
  // Upstream legacy storage stays under Path.data even when OPENCODE_DB moves.
  const withLegacyRoot = (result) => ({ ...result, legacyRoot: path.join(dataRoot, 'storage') });
  if (direct) return withLegacyRoot(direct);
  if (override) return withLegacyRoot(selected(path.join(dataRoot, override), 'environment', fsImpl));
  if (['1', 'true'].includes(env.OPENCODE_DISABLE_CHANNEL_DB)) {
    return withLegacyRoot(selected(path.join(dataRoot, 'opencode.db'), 'channel-disabled', fsImpl));
  }
  return withLegacyRoot(discover(dataRoot, fsImpl));
}
