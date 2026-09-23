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
  return { keys: value.keys };
}

function serializeReceipt(keys, format, pending) {
  if (format.single) {
    const entry = keys[format.single];
    return JSON.stringify({ version: 1, before: entry.before, after: entry.after, pending }) + '\n';
  }
  return JSON.stringify({ version: 2, keys, pending }) + '\n';
}

/**
 * @param {{file: string, boundary: string, enabled: boolean, required?: boolean}} target
 * @param {Record<string, {present: boolean, value?: string}>} desired
 * @param {{receiptSuffix: string, format?: 'multi' | {single: string}, editorFor: Function}} options
 */
export function planOwnedEnv(target, desired, { receiptSuffix, format = 'multi', editorFor }) {
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
  for (const key of new Set([...Object.keys(wanted), ...ownedKeys])) {
    const current = editor.get(key);
    const owned = receipt?.keys?.[key];
    const want = wanted[key] ?? ABSENT;
    if (owned && !same(current, owned.after)) throw new Error(`${key}: user-edited value preserved`);
    if (!owned && current.present && !(want.present && same(current, want))) throw new Error(`${key}: conflicting unmanaged value preserved`);
    if (!owned && current.present) continue; // equal foreign value: never adopted (ADR-0055)
    const next = want.present ? want : (owned ? owned.before : ABSENT);
    nextStates[key] = next;
    if (want.present) nextReceipt[key] = { before: owned?.before ?? current, after: next };
  }
  const changed = Object.entries(nextStates).some(([key, next]) => !same(editor.get(key), next));
  if (!changed) return { file, status: 'converged', changed: false };
  return { file, boundary: target.boundary, status: 'drift', changed: true, source, receiptSource, receiptFile,
    after: editor.render(nextStates), nextReceipt, format: fmt };
}

function assertCurrent(file, source) {
  if (readRegularConfig(file) !== source) throw new Error('configuration changed after inspection; retry');
}

export function applyOwnedEnv(plan, { backupTag }) {
  const { file, source, after, receiptFile, nextReceipt, format } = plan;
  checkDirectories(file, plan.boundary);
  assertCurrent(file, source);
  assertCurrent(receiptFile, plan.receiptSource);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (source !== null) fs.copyFileSync(file, `${file}.ak-${backupTag}-backup.${randomUUID()}`, fs.constants.COPYFILE_EXCL);
  const hasKeys = Object.keys(nextReceipt).length > 0;
  // Mark the write in flight: the new keys when adding, else the prior keys being released.
  const pendingKeys = hasKeys ? nextReceipt : (plan.receiptSource ? parseReceipt(plan.receiptSource, format).keys : {});
  if (Object.keys(pendingKeys).length) writePrivateFileAtomic(receiptFile, serializeReceipt(pendingKeys, format, true));
  const tmp = `${file}.ak-${backupTag}-tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, after, { flag: 'wx', mode: source === null ? 0o600 : fs.statSync(file).mode & 0o777 });
    assertCurrent(file, source);
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  if (hasKeys) writePrivateFileAtomic(receiptFile, serializeReceipt(nextReceipt, format, false));
  else if (fs.existsSync(receiptFile)) fs.unlinkSync(receiptFile);
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
