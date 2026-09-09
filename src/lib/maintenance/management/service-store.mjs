// ADR-0048 facade-owned private state: the last-good inventory snapshot, the
// owner-private locator table `revealLocator` reads from, and the
// `lastRefresh` outcome signal. All live at `<controlRoot>/management`
// alongside Q's and D's own stores. Integrity-sealed and size-bounded like
// `scan-store.mjs`; a failed build never replaces the last-good snapshot
// (MNT-PERF-007).
import { createHash } from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import { canonicalJson } from './model.mjs';

// D6 (QE): a real machine's inventory (8,304 placements observed) produced a
// 17.1 MB JSON envelope — comfortably past the original 16 MiB ceiling. The
// snapshot is gzip-compressed on disk; the two ceilings below bound the
// UNCOMPRESSED JSON (what the facade actually builds and must hold in memory
// regardless of compression) and the COMPRESSED bytes written to disk.
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const INVENTORY_SNAPSHOT_SCHEMA = 'maintenance-management-inventory-snapshot/v1';
const LOCATOR_STORE_SCHEMA = 'maintenance-management-locators/v1';
const LAST_REFRESH_SCHEMA = 'maintenance-management-last-refresh/v1';

function sha256(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

function ensurePrivateDir(dir, fsImpl) {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

/** Parse and integrity-check one envelope's canonical `{schemaVersion, ...}`
 *  shape. Returns the base object's own payload field, or `null` on any
 *  schema/integrity mismatch — corrupt or foreign state is treated as
 *  absent, never thrown. */
function readVerifiedEnvelope(raw, schema, payloadKey) {
  const parsed = JSON.parse(raw);
  const { integrity, ...base } = parsed ?? {};
  if (parsed?.schemaVersion !== schema
    || integrity?.algorithm !== 'sha256' || integrity.digest !== sha256(base)) return null;
  return base[payloadKey];
}

function sealedEnvelope(schema, payloadKey, payload) {
  const base = { schemaVersion: schema, [payloadKey]: payload };
  return { ...base, integrity: { algorithm: 'sha256', digest: sha256(base) } };
}

/** `<root>/inventory-latest.json.gz` — the last successfully built,
 *  privacy-projected ManagementInventory plus its admitted guidance, gzip-
 *  compressed on disk (D6). Read by every path-free facade method so a read
 *  never runs a collector, a provider, the network, or a credential check
 *  (MNT-PERF-001). The integrity digest covers the UNCOMPRESSED canonical
 *  JSON, so it verifies identically regardless of the compression codec.
 *  `read()` also accepts a legacy uncompressed `inventory-latest.json` (the
 *  shape this store wrote before D6) so an installation upgrading mid-session
 *  does not lose its last-good snapshot. */
export function createInventorySnapshotStore(root, { fsImpl }) {
  const compressedFile = path.join(root, 'inventory-latest.json.gz');
  const legacyFile = path.join(root, 'inventory-latest.json');

  function readFrom(file, decode) {
    let raw;
    try { raw = decode(fsImpl.readFileSync(file)); } catch { return null; }
    try { return readVerifiedEnvelope(raw, INVENTORY_SNAPSHOT_SCHEMA, 'snapshot'); } catch { return null; }
  }

  function read() {
    return readFrom(compressedFile, (buffer) => zlib.gunzipSync(buffer).toString('utf8'))
      ?? readFrom(legacyFile, (buffer) => buffer.toString('utf8'));
  }

  /** @returns {{ uncompressedBytes: number, compressedBytes: number }} the
   *  measured sizes, for a caller that wants to record them (D6). */
  function write(snapshot) {
    const envelope = sealedEnvelope(INVENTORY_SNAPSHOT_SCHEMA, 'snapshot', snapshot);
    const json = JSON.stringify(envelope);
    const uncompressedBytes = Buffer.byteLength(json);
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`management inventory snapshot exceeds ${MAX_UNCOMPRESSED_BYTES} uncompressed bytes (measured ${uncompressedBytes})`);
    }
    const compressed = zlib.gzipSync(`${json}\n`);
    if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
      throw new Error(`management inventory snapshot exceeds ${MAX_COMPRESSED_BYTES} compressed bytes (measured ${compressed.byteLength})`);
    }
    ensurePrivateDir(root, fsImpl);
    writePrivateFileAtomic(compressedFile, compressed, { fsImpl });
    // A stale legacy file would otherwise outrank a fresh compressed write
    // the next time an older-format reader (or this store's own legacy
    // fallback) looks for one.
    try { fsImpl.rmSync(legacyFile, { force: true }); } catch { /* best effort */ }
    return { uncompressedBytes, compressedBytes: compressed.byteLength };
  }

  return { read, write };
}

/** `<root>/last-refresh.json` — the outcome of the most recent
 *  `refreshInventory` attempt, `{status:'ok'|'failed', at, code?, message?}`
 *  (D6b): a failed chained refresh previously left no wire signal at all
 *  (Activity showed `complete`, Inventory showed `scanRequired:true`, and
 *  nothing said why). Written on EVERY refresh outcome, independent of
 *  whether that refresh produced a new last-good snapshot. */
export function createLastRefreshStore(root, { fsImpl }) {
  const file = path.join(root, 'last-refresh.json');

  function read() {
    let raw;
    try { raw = fsImpl.readFileSync(file, 'utf8'); } catch { return null; }
    try { return readVerifiedEnvelope(raw, LAST_REFRESH_SCHEMA, 'lastRefresh'); } catch { return null; }
  }

  function write(lastRefresh) {
    const envelope = sealedEnvelope(LAST_REFRESH_SCHEMA, 'lastRefresh', lastRefresh);
    ensurePrivateDir(root, fsImpl);
    writePrivateFileAtomic(file, `${JSON.stringify(envelope)}\n`, { fsImpl });
  }

  return { read, write };
}

/** `<root>/locators.json` — owner-private `placementId -> {path, selector?,
 *  file?}` map, 0600. This is the ONLY place a real filesystem path is ever
 *  persisted by the facade; `revealLocator` is the sole reader. Rewritten in
 *  full on every successful `refreshInventory` (bounded by inventory size). */
export function createLocatorStore(root, { fsImpl }) {
  const file = path.join(root, 'locators.json');

  function write(locators) {
    const entries = locators instanceof Map ? [...locators.entries()] : Object.entries(locators ?? {});
    const envelope = { schemaVersion: LOCATOR_STORE_SCHEMA, locators: Object.fromEntries(entries) };
    ensurePrivateDir(root, fsImpl);
    writePrivateFileAtomic(file, `${JSON.stringify(envelope)}\n`, { fsImpl });
  }

  function read() {
    let raw;
    try { raw = fsImpl.readFileSync(file, 'utf8'); } catch { return new Map(); }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.schemaVersion !== LOCATOR_STORE_SCHEMA) return new Map();
      return new Map(Object.entries(parsed.locators ?? {}));
    } catch { return new Map(); }
  }

  return { read, write };
}
