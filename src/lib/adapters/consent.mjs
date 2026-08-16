// Hash-pinned adapter trust store (Codex-hooks/Hermes-allowlist precedent).
// A JSON map of adapter name -> { hash, consentedAt } under the kit config
// dir. Edit-invalidation is inherent: change an adapter's hook command and
// its hash changes, so `isTrusted` fails closed until consent is re-granted.
//
// No interactive prompting lives here — consent is GRANTED elsewhere (a
// future `ak host adapters trust <name>` command). `recordConsent` is the
// programmatic seam that command will call.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../paths.mjs';

export const adapterConsentPath = () => path.join(configDir(), 'adapter-consent.json');

function readStore(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic tmp+rename write at 0600, matching the rest of the kit's
 * user-owned config writes (live/process-sessions.mjs's WorkspaceSnapshotStore). */
function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup must not mask the write error */ }
    }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms without POSIX perms */ }
}

function validEntry(value) {
  return !!value && typeof value === 'object'
    && typeof value.hash === 'string' && value.hash.length > 0
    && typeof value.consentedAt === 'string' && Number.isFinite(Date.parse(value.consentedAt));
}

/** The hash this adapter was last consented to, or null if never recorded
 * (or the file is missing/unreadable/corrupt — this never throws). */
export function recordedHashFor(name, { file = adapterConsentPath() } = {}) {
  if (typeof name !== 'string' || !name) return null;
  const entry = readStore(file)[name];
  return validEntry(entry) ? entry.hash : null;
}

/** True only on an exact hash match against the recorded consent. Any
 * mismatch — including "never consented" — is untrusted. */
export function isTrusted(name, hash, { file = adapterConsentPath() } = {}) {
  if (typeof hash !== 'string' || !hash) return false;
  const recorded = recordedHashFor(name, { file });
  return recorded !== null && recorded === hash;
}

/** Record consent for `name` at `hash`, overwriting any prior entry. */
export function recordConsent(name, hash, { file = adapterConsentPath() } = {}) {
  if (typeof name !== 'string' || !name) throw new TypeError('recordConsent requires an adapter name');
  if (typeof hash !== 'string' || !hash) throw new TypeError('recordConsent requires a hash');
  const store = readStore(file);
  store[name] = { hash, consentedAt: new Date().toISOString() };
  writeStore(file, store);
}

/** Remove any recorded consent for `name`. Returns whether an entry existed. */
export function revokeConsent(name, { file = adapterConsentPath() } = {}) {
  if (typeof name !== 'string' || !name) return false;
  const store = readStore(file);
  // Object.hasOwn, not `name in store`: `in` walks the prototype chain, so
  // revokeConsent('constructor') (or 'toString', 'hasOwnProperty', ...)
  // would read true off Object.prototype and report revoking consent for an
  // adapter that was never actually consented to.
  if (!Object.hasOwn(store, name)) return false;
  delete store[name];
  writeStore(file, store);
  return true;
}
