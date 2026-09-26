// Receipts for edits ak makes inside another tool's install (audit 2026-09-26
// Addendum 2, problem 3, choice B).
//
// Ruflo overrides better-sqlite3 to >= 12.8.0 because AgentDB's optional
// ^11.8.1 has no Node 24-26 binaries and silently falls back to a
// non-persistent engine (ruflo/scripts/audit-better-sqlite3-override.mjs,
// ruvnet/ruflo#2219). An `npm install -g ruflo` does not apply that override
// (npm honors `overrides` only in the root project), so when a bundled copy
// cannot resolve better-sqlite3 at all, ak's natives heal (heal.mjs
// ensureNativeBsq3) installs one there, and first rewrites the package's own
// better-sqlite3 lines, or npm fails with EOVERRIDE. That edit matches Ruflo's
// intent but touches another tool's files, so every edit is recorded here
// BEFORE it is made (file, field, original value, ak's value, time), shown by
// `ak status` and `ak about`, and reversed by `ak uninstall` only where the
// file still holds ak's value. A receipt whose file no longer holds ak's value
// (Ruflo was upgraded or reinstalled) is superseded: nothing to restore, and
// the next heal forgets it.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { run } from './exec.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';

export const RUFLO_NATIVE_PIN_UPSTREAM = 'ruvnet/ruflo#2219';
const LEDGER_VERSION = 1;

/**
 * @typedef {{ file: string, section: string, name: string, from: string|null, to: string, at: number }} InstallEdit
 * @typedef {{ ledger?: string }} LedgerOptions
 */

/** @param {LedgerOptions} [options] @returns {{ version: number, edits: InstallEdit[] }} */
export function readInstallEdits({ ledger = paths.installEditsPath() } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    const edits = Array.isArray(data?.edits)
      ? data.edits.filter((edit) => typeof edit?.file === 'string' && typeof edit.section === 'string'
        && typeof edit.name === 'string' && typeof edit.to === 'string')
      : [];
    return { version: LEDGER_VERSION, edits };
  } catch {
    return { version: LEDGER_VERSION, edits: [] };
  }
}

function writeInstallEdits(edits, ledger) {
  if (!edits.length) { fs.rmSync(ledger, { force: true }); return; }
  writePrivateFileAtomic(ledger, `${JSON.stringify({ version: LEDGER_VERSION, edits }, null, 2)}\n`);
}

/** The value `section.name` holds in a package.json now; undefined when the
 *  file, the section or the key is gone. */
export function manifestValue(file, section, name) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.[section]?.[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

const sameField = (a, b) => a.file === b.file && a.section === b.section && a.name === b.name;
const applied = (edit) => manifestValue(edit.file, edit.section, edit.name) === edit.to;

/**
 * Record an edit before it is made. When ak already changed this field and the
 * file still holds ak's value, the ORIGINAL value is kept, so uninstall
 * restores what the tool shipped, not ak's earlier edit.
 * @param {{ file: string, section: string, name: string, to: string, now?: () => number }} edit
 * @param {LedgerOptions} [options]
 */
export function recordInstallEdit({ file, section, name, to, now = Date.now }, { ledger = paths.installEditsPath() } = {}) {
  const { edits } = readInstallEdits({ ledger });
  const current = manifestValue(file, section, name) ?? null;
  const edit = { file, section, name, from: current, to, at: now() };
  const index = edits.findIndex((candidate) => sameField(candidate, edit));
  if (index >= 0 && edits[index].to === current) edit.from = edits[index].from;
  if (index >= 0) edits.splice(index, 1, edit); else edits.push(edit);
  writeInstallEdits(edits, ledger);
  return edit;
}

/** Every receipt with its state: `applied` while the file holds ak's value,
 *  else `superseded`. @param {LedgerOptions} [options] */
export function installEditStatus({ ledger = paths.installEditsPath() } = {}) {
  return readInstallEdits({ ledger }).edits.map((edit) => ({ ...edit, state: applied(edit) ? 'applied' : 'superseded' }));
}

/** Forget superseded receipts (the heal calls this before it edits anything,
 *  so a Ruflo upgrade that replaced the files is re-checked on every sync).
 *  @param {LedgerOptions} [options] */
export function pruneInstallEdits({ ledger = paths.installEditsPath() } = {}) {
  const { edits } = readInstallEdits({ ledger });
  const kept = edits.filter(applied);
  if (kept.length !== edits.length) writeInstallEdits(kept, ledger);
  return { pruned: edits.length - kept.length };
}

/** `<package> package.json` for a receipt, relative to the install that owns it. */
export function editLabel(edit, { rufloRoot = null } = {}) {
  const dir = path.dirname(edit.file);
  const base = rufloRoot ? path.join(rufloRoot, 'node_modules') : null;
  const rel = base ? path.relative(base, dir) : '';
  const name = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : dir;
  return `${name} package.json`;
}

/** `<label> <section> <name> <from> → <to>` for one receipt. */
export const describeInstallEdit = (edit, options = {}) =>
  `${editLabel(edit, options)} ${edit.section} ${edit.name} ${edit.from ?? '(absent)'} → ${edit.to}`;

const insideDir = (file, dir) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The status/About wording for ak's applied edits inside Ruflo's install. */
export const RUFLO_PIN_NOTE = `ak applied Ruflo's native SQLite pin (${RUFLO_NATIVE_PIN_UPSTREAM})`;

/** Split receipts by owner: applied inside Ruflo's install, applied anywhere
 *  else, and superseded. */
export function groupInstallEdits(edits, { rufloRoot = null } = {}) {
  const applied = edits.filter((edit) => edit.state === 'applied');
  const ruflo = applied.filter((edit) => rufloRoot && insideDir(edit.file, rufloRoot));
  return {
    ruflo,
    elsewhere: applied.filter((edit) => !ruflo.includes(edit)),
    superseded: edits.filter((edit) => edit.state !== 'applied'),
  };
}

/** One About line per applied edit inside Ruflo's install. */
export const rufloEditNotes = (edits, { rufloRoot = null } = {}) =>
  groupInstallEdits(edits, { rufloRoot }).ruflo.map((edit) => `${RUFLO_PIN_NOTE}: ${describeInstallEdit(edit, { rufloRoot })}`);

/**
 * Put back the original values ak changed, only where the file still holds
 * ak's value; forget the rest. A restore is verified by re-reading the file;
 * one that did not take keeps its receipt and makes `ok` false.
 * @param {LedgerOptions & { runner?: typeof run, rufloRoot?: string|null }} [options]
 */
export async function restoreInstallEdits({ ledger = paths.installEditsPath(), runner = run, rufloRoot = null } = {}) {
  const lines = [];
  const kept = [];
  for (const { state, ...receipt } of installEditStatus({ ledger })) {
    const label = editLabel(receipt, { rufloRoot });
    if (state !== 'applied') {
      lines.push({ level: 'info', text: `${label}: ${receipt.section} ${receipt.name} no longer holds ak's value; left as it is` });
      continue;
    }
    const key = `${receipt.section}.${receipt.name}`;
    const args = receipt.from == null ? ['pkg', 'delete', key] : ['pkg', 'set', `${key}=${receipt.from}`];
    await runner('npm', args, { cwd: path.dirname(receipt.file), timeout: 30_000 });
    if (manifestValue(receipt.file, receipt.section, receipt.name) === (receipt.from ?? undefined)) {
      lines.push({ level: 'ok', text: `restored ${label} ${receipt.section} ${receipt.name} to ${receipt.from ?? '(absent)'}` });
    } else {
      kept.push(receipt);
      lines.push({ level: 'warn', text: `could not restore ${describeInstallEdit(receipt, { rufloRoot })}; `
        + `run \`npm ${args.join(' ')}\` in ${path.dirname(receipt.file)}` });
    }
  }
  writeInstallEdits(kept, ledger);
  return { ok: kept.length === 0, lines };
}
