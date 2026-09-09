// Exact postimages authorize teardown; labels and environment names do not.
// Receipts are persisted before projection, so interruption can only withdraw
// teardown authority. Router drift remains unresolved across subsequent syncs.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';

export const routerReceiptFile = (file) => `${file}.agentic-kit-ownership.json`;
const envReceiptFile = (file) => `${file}.agentic-kit-env-ownership.json`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const regular = (file) => {
  try { return fs.lstatSync(file).isFile(); } catch { return false; }
};
function hashFile(file) { return regular(file) ? hash(fs.readFileSync(file)) : null; }

export function writeOwnedRouter(file, next) {
  const receiptFile = routerReceiptFile(file);
  const prior = readJson(receiptFile);
  const currentHash = hashFile(file);
  const existing = readJson(file);
  const backupHash = hashFile(`${file}.bak`);
  const established = prior?.version === 1 && prior.postimage === currentHash && !prior.unresolved;
  const fresh = !fs.existsSync(receiptFile) && existing?._managedBy !== 'agentic-kit'
    && (!fs.existsSync(file) || regular(file))
    && (!fs.existsSync(`${file}.bak`) || backupHash === currentHash);
  const receipt = {
    version: 1,
    postimage: hash(jsonBytes(next)),
    preimage: established ? prior.preimage : currentHash,
    unresolved: !(established || fresh),
  };
  writePrivateFileAtomic(receiptFile, jsonBytes(receipt));
  if (established && prior.preimage === null) writePrivateFileAtomic(file, jsonBytes(next));
  else writeJsonWithBackup(file, next);
}

export function undoOwnedRouter(file, { fsImpl = fs } = {}) {
  const receiptFile = routerReceiptFile(file);
  const receipt = readJson(receiptFile);
  const preserved = (reason) => ({ ok: false, changed: false,
    detail: `llm-config.json preserved: ${reason}; review the current file and .bak, then reconcile manually` });
  if (receipt?.version !== 1 || receipt.unresolved || typeof receipt.postimage !== 'string') {
    return preserved('no verified postimage ownership');
  }
  if (hashFile(file) !== receipt.postimage) return preserved('post-setup edits or interrupted projection');
  if (receipt.preimage !== null) {
    if (typeof receipt.preimage !== 'string' || hashFile(`${file}.bak`) !== receipt.preimage) {
      return preserved('original backup missing or changed');
    }
    // Atomic rename keeps both the live postimage and backup intact if the
    // replacement fails. Keep the backup as recovery evidence after success.
    writePrivateFileAtomic(file, fs.readFileSync(`${file}.bak`), { fsImpl });
    fsImpl.rmSync(receiptFile, { force: true });
    return { ok: true, changed: true, detail: 'restored pre-ak llm-config.json (backup retained)' };
  }
  fsImpl.rmSync(file);
  fsImpl.rmSync(receiptFile, { force: true });
  return { ok: true, changed: true, detail: 'removed ak-created llm-config.json' };
}

const state = (env, key) => Object.hasOwn(env, key) ? { present: true, value: env[key] } : { present: false };
const matches = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validState = (s) => s && typeof s === 'object' && typeof s.present === 'boolean'
  && (!s.present || Object.hasOwn(s, 'value'));
const validEntry = (entry) => validState(entry?.before) && validState(entry?.after);

export function recordProviderEnv(file, env, desired, keys) {
  const prior = readJson(envReceiptFile(file));
  const entries = {};
  for (const key of keys) {
    const before = state(env, key); const after = state(desired, key);
    const entry = prior?.version === 1 ? prior.entries?.[key] : null;
    if (validEntry(entry) && matches(before, entry.after)) entries[key] = { before: entry.before, after };
    else if (!matches(before, after)) entries[key] = { before, after };
  }
  const receipt = { version: 1, entries, pending: true,
    unresolved: prior?.pending === true || prior?.unresolved === true };
  writePrivateFileAtomic(envReceiptFile(file), jsonBytes(receipt));
  // Confirm only after the target write succeeds. A failed/interrupted
  // projection cannot be mistaken for a later user edit on the next sync.
  return () => writePrivateFileAtomic(envReceiptFile(file), jsonBytes({ ...receipt, pending: false }));
}

export function undoOwnedProviderEnv(file, settings, keys) {
  const receiptFile = envReceiptFile(file); const receipt = readJson(receiptFile);
  if (receipt?.pending || receipt?.unresolved) return { ok: false, changed: false,
    detail: 'env values preserved: interrupted projection; review settings and .bak, then reconcile manually' };
  let restored = 0; let preserved = 0;
  for (const key of keys) {
    const entry = receipt?.version === 1 ? receipt.entries?.[key] : null;
    if (!validEntry(entry) || !matches(state(settings.env, key), entry.after)) {
      if (Object.hasOwn(settings.env, key)) preserved++;
      continue;
    }
    if (entry.before.present) settings.env[key] = entry.before.value;
    else delete settings.env[key];
    restored++;
  }
  if (restored) writeJsonWithBackup(file, settings);
  if (fs.existsSync(receiptFile)) fs.rmSync(receiptFile);
  return { ok: preserved === 0, changed: restored > 0,
    detail: `${restored} owned env key(s) reverted; ${preserved} unowned/edited key(s) preserved`
      + (preserved ? ' — review preserved settings manually' : '') };
}
