// ADR-0058 §3: ADR-0055's single-key AQE receipt engine, generalized to a set of keys.
// Same guarantees: regular files only, preimage check, backup copy, atomic replace,
// pending-receipt guard, foreign and user-edited values preserved.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFileAtomic } from './file-write.mjs';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validState = (s) => plain(s) && typeof s.present === 'boolean' && (!s.present || typeof s.value === 'string');
const ABSENT = Object.freeze({ present: false });

export function readRegularConfig(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('non-regular configuration preserved');
    if (stat.size > 4 * 1024 * 1024) throw new Error('configuration exceeds inspection bound');
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkDirectories(file, boundary) {
  let dir = path.dirname(file);
  while (dir === boundary || dir.startsWith(boundary + path.sep)) {
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('non-regular configuration directory preserved');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dir === boundary) break;
    dir = path.dirname(dir);
  }
}

/** Normalize either receipt format to { keys: {K: {before, after}} }. */
function parseReceipt(source, format) {
  if (source === null) return null;
  let value;
  try { value = JSON.parse(source); } catch { throw new Error('invalid ownership receipt preserved'); }
  if (value?.pending === true) throw new Error('interrupted projection requires reconciliation; receipt retained');
  if (format.single) {
    if (value.version !== 1 || !validState(value.before) || !validState(value.after)) throw new Error('invalid ownership receipt preserved');
    return { keys: { [format.single]: { before: value.before, after: value.after } } };
  }
  if (value.version !== 2 || !plain(value.keys)) throw new Error('invalid ownership receipt preserved');
  for (const entry of Object.values(value.keys)) {
    if (!validState(entry?.before) || !validState(entry?.after)) throw new Error('invalid ownership receipt preserved');
  }
  const created = plain(value.created) ? { ...(value.created.file === true ? { file: true } : {}), ...(value.created.table === true ? { table: true } : {}) } : {};
  return { keys: value.keys, created };
}

function serializeReceipt(keys, format, pending, created) {
  if (format.single) {
    const entry = keys[format.single];
    return JSON.stringify({ version: 1, before: entry.before, after: entry.after, pending }) + '\n';
  }
  return JSON.stringify({ version: 2, keys, pending, ...(created && Object.keys(created).length ? { created } : {}) }) + '\n';
}

const emptyDocument = (text) => ['', '{}'].includes(String(text).trim());

/**
 * @param {{file: string, boundary: string, enabled: boolean, required?: boolean}} target
 * @param {Record<string, {present: boolean, value?: string}>} desired
 * @param {{receiptSuffix: string, format?: 'multi' | {single: string}, editorFor: Function,
 *   adoptable?: (key: string, current: {present: boolean, value?: string}) => boolean, trackCreated?: boolean}} options
 *   `adoptable` names a value ak may replace under its receipt (the receipt keeps it as
 *   `before`, so a release puts it back), whether ak owned the key before or not (the
 *   tool re-wrote its own default); every other unowned or edited value stays a conflict.
 *   The single-key AQE embedding receipt (ADR-0055) passes no `adoptable`.
 *   `trackCreated` (multi-key only) records in the receipt whether ak created the file or
 *   the editor's table; the release that leaves them empty removes them again.
 */
export function planOwnedEnv(target, desired, { receiptSuffix, format = 'multi', editorFor, adoptable = () => false, trackCreated = false }) {
  const fmt = format === 'multi' ? {} : format;
  const { file } = target;
  const receiptFile = `${file}${receiptSuffix}`;
  checkDirectories(file, target.boundary);
  const source = readRegularConfig(file);
  const receiptSource = readRegularConfig(receiptFile);
  const receipt = parseReceipt(receiptSource, fmt);
  const wanted = Object.fromEntries(Object.entries(desired).map(([k, v]) => [k, target.enabled ? v : ABSENT]));
  const ownedKeys = new Set(Object.keys(receipt?.keys ?? {}));
  if (!Object.values(wanted).some((s) => s.present) && ownedKeys.size === 0) return { file, status: 'unmanaged', changed: false };
  const editor = editorFor(source, target);
  if (editor.missing) {
    if (ownedKeys.size) throw new Error('owned environment container is missing; receipt retained');
    return { file, status: target.required ? 'missing-registration' : 'absent', changed: false };
  }
  const nextStates = {};
  const nextReceipt = {};
  const keys = {};
  const conflicts = [];
  for (const key of new Set([...Object.keys(wanted), ...ownedKeys])) {
    const owned = receipt?.keys?.[key];
    const want = wanted[key] ?? ABSENT;
    const d = decideKey(editor.get(key), owned, want, Boolean(fmt.single), (current) => adoptable(key, current));
    keys[key] = d.state;
    if (d.conflict) {
      // Single-key receipts (AQE) keep ADR-0055's refuse-the-file contract; the multi-key
      // engine preserves just this key and still converges the others (ADR-0058 §3).
      if (fmt.single) throw new Error(`${key}: ${d.conflict}`);
      conflicts.push({ key, reason: `${key}: ${d.conflict}` });
      if (owned) nextReceipt[key] = owned; // user-edited: still reported, never overwritten
      continue;
    }
    if (!d.next) continue;
    nextStates[key] = d.next;
    if (want.present) nextReceipt[key] = { before: owned?.before ?? editor.get(key), after: d.next };
  }
  const envChanged = Object.entries(nextStates).some(([key, next]) => !same(editor.get(key), next));
  const receiptDropped = [...ownedKeys].some((key) => !(key in nextReceipt));
  if (!envChanged && !receiptDropped) return { file, status: 'converged', changed: false, keys, conflicts };
  const prior = receipt?.created ?? {};
  const created = trackCreated && !fmt.single ? {
    ...(prior.file || source === null ? { file: true } : {}),
    ...(prior.table || editor.containerPresent === false ? { table: true } : {}),
  } : undefined;
  const releasing = Object.keys(nextReceipt).length === 0;
  const after = editor.render(nextStates, { dropEmptyContainer: !!(releasing && created?.table) });
  const removeFile = !!(releasing && created?.file && emptyDocument(after));
  return { file, boundary: target.boundary, status: 'drift', changed: true, source, receiptSource, receiptFile,
    after, removeFile, created, nextReceipt, format: fmt, keys, conflicts };
}

/** One key's outcome: `state` for reporting, `next` when ak writes it, `conflict` when a
 *  value ak does not own (or a user edit of one it did) is preserved. */
function decideKey(current, owned, want, single, adopt = (/** @type {any} */ _current) => false) {
  if (owned && !current.present && !single) {
    // ak's value was deleted: restore it while wanted (nothing of the user's is
    // overwritten), otherwise there is nothing left to release.
    return want.present ? { state: 'restore', next: want } : { state: 'converged', next: ABSENT };
  }
  if (owned && current.present && !same(current, owned.after) && adopt(current)) {
    // The tool's own default came back (e.g. AQE re-init after an upgrade rewrote
    // its table): take it back while wanted; on release leave it as the tool
    // wrote it. The receipt keeps its first `before` (review M4).
    return want.present ? { state: 'write', next: want } : { state: 'converged', next: current };
  }
  if (owned && !same(current, owned.after)) return { state: 'user-edited', conflict: 'user-edited value preserved' };
  if (!owned && current.present && want.present && !same(current, want) && adopt(current)) return { state: 'write', next: want };
  if (!owned && current.present && !(want.present && same(current, want))) {
    return { state: 'foreign', conflict: 'conflicting unmanaged value preserved' };
  }
  if (!owned && current.present) return { state: 'converged' }; // equal foreign value: never adopted (ADR-0055)
  const next = want.present ? want : (owned ? owned.before : ABSENT);
  if (same(current, next)) return { state: 'converged', next };
  return { state: want.present ? 'write' : 'release', next };
}

/** Keys marked in flight while a plan is applied: every key the prior receipt held plus
 *  every key the next one holds, so an interruption never loses a released key's `before`. */
export function pendingReceiptKeys(plan) {
  const prior = plan.receiptSource ? parseReceipt(plan.receiptSource, plan.format).keys : {};
  return { ...prior, ...plan.nextReceipt };
}

/** Delete this projection's backups of `file` beyond the newest `keep` (ak's own files
 *  only: `<name>.ak-<tag>-backup.<uuid>`). */
function pruneBackups(file, backupTag, keep) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.ak-${backupTag}-backup.`;
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)); } catch { return; }
  const byAge = names.map((name) => {
    try { return { name, mtime: fs.lstatSync(path.join(dir, name)).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const { name } of byAge.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* best effort: a backup ak cannot remove stays */ }
  }
}

function assertCurrent(file, source) {
  if (readRegularConfig(file) !== source) throw new Error('configuration changed after inspection; retry');
}

/** @param {any} plan @param {{backupTag: string, keepBackups?: number}} options `keepBackups`
 *  prunes this projection's older backups of the file (default: keep all). */
export function applyOwnedEnv(plan, { backupTag, keepBackups }) {
  const { file, source, after, receiptFile, nextReceipt, format } = plan;
  checkDirectories(file, plan.boundary);
  assertCurrent(file, source);
  assertCurrent(receiptFile, plan.receiptSource);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hasKeys = Object.keys(nextReceipt).length > 0;
  const pendingKeys = pendingReceiptKeys(plan);
  if (plan.removeFile) {
    // ak created this file and the release leaves it empty: remove it, its receipt and
    // this projection's backups of it (they only ever held ak's own keys).
    if (Object.keys(pendingKeys).length) writePrivateFileAtomic(receiptFile, serializeReceipt(pendingKeys, format, true, plan.created));
    assertCurrent(file, source);
    fs.unlinkSync(file);
    if (fs.existsSync(receiptFile)) fs.unlinkSync(receiptFile);
    if (keepBackups !== undefined) pruneBackups(file, backupTag, 0);
    return;
  }
  if (source !== null) fs.copyFileSync(file, `${file}.ak-${backupTag}-backup.${randomUUID()}`, fs.constants.COPYFILE_EXCL);
  if (Object.keys(pendingKeys).length) writePrivateFileAtomic(receiptFile, serializeReceipt(pendingKeys, format, true, plan.created));
  const tmp = `${file}.ak-${backupTag}-tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, after, { flag: 'wx', mode: source === null ? 0o600 : fs.statSync(file).mode & 0o777 });
    assertCurrent(file, source);
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  if (hasKeys) writePrivateFileAtomic(receiptFile, serializeReceipt(nextReceipt, format, false, plan.created));
  else if (fs.existsSync(receiptFile)) fs.unlinkSync(receiptFile);
  if (keepBackups !== undefined) pruneBackups(file, backupTag, keepBackups);
}

/** Claude settings files: `env` is a top-level object. */
export function jsonTopLevelEnvEditor(source) {
  let doc;
  try { doc = source === null ? {} : JSON.parse(source); } catch { throw new Error('invalid JSON configuration preserved'); }
  if (!plain(doc)) throw new Error('configuration is not an object');
  if (doc.env !== undefined && !plain(doc.env)) throw new Error('environment is not an object');
  return {
    get: (key) => (doc.env && Object.hasOwn(doc.env, key) ? { present: true, value: doc.env[key] } : { present: false }),
    render(nextStates) {
      doc.env ??= {};
      for (const [key, next] of Object.entries(nextStates)) {
        if (next.present) doc.env[key] = next.value; else delete doc.env[key];
      }
      if (Object.keys(doc.env).length === 0) delete doc.env;
      return JSON.stringify(doc, null, 2) + '\n';
    },
  };
}
