import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';

/**
 * Exact-folder correlator for Live sessions outside a Git repository
 * (ADR-0012, 2026-09-26). A plain folder's public project key hashes only its
 * name, so two unrelated `scratch` folders share it and cannot safely join a
 * running process to a transcript. This value tells them apart.
 *
 * It is an HMAC-SHA-256 of the folder's real path under a secret generated
 * for each correlator (one per live service) and never stored, following
 * ADR-0053's "per-server secret, not a public hash" rule. It lives only in
 * the service's memory: it is never put in events, snapshots, API payloads,
 * the workspace store, or logs. A folder that does not exist yields null, so
 * a retained transcript whose folder is gone never matches.
 *
 * @returns {(cwd: unknown) => string | null}
 */
export function createFolderCorrelator() {
  const secret = randomBytes(32);
  const realpath = fs.realpathSync.native ?? fs.realpathSync;
  return (cwd) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    let resolved;
    try { resolved = realpath(cwd); } catch { return null; }
    return createHmac('sha256', secret)
      .update(`folder\0${resolved.replaceAll('\\', '/').normalize('NFKC')}`)
      .digest('hex');
  };
}
