// Merge stray AQE stores into the project store, then archive them (decisions
// B5-D2..D4). A stray `.agentic-qe` below the project root holds patterns and
// experiences AQE learned while a command, hook or MCP server ran in that
// folder without ak's pin; the project's hosts never read it.
//
// Sequence (`mergeAqeStores`):
//   1 preview   copy the root and every stray store (memory.db, -wal, -shm)
//               into <run>/scratch and count there. A real store is never
//               opened for a preview, not even read-only (a WAL open touches
//               -shm). A dry run stops here and removes its scratch.
//   2 writers   refuse while any process holds the root or a stray store, or
//               when that cannot be checked (aqe-store-holders.mjs; on Windows
//               the census stands in). No force: AQE's writers take no lock a
//               merge could wait on (agentic-qe#753).
//   3 backup    VACUUM INTO <run>/backup/root-memory.db.
//   4 rehearse  on a copy of that backup: per stray copy, delete its
//               witness_chain rows (appended unlinked they break the root's
//               audit chain; Branch 5 Task 0.2), `aqe brain export --format
//               jsonl`, `aqe brain import --dry-run`, then the import. Counts
//               must equal the preview's union by (name, qe_domain,
//               pattern_type) and experience id; integrity and foreign keys
//               clean. AQE 3.14.4 skips shared patterns as conflicts without
//               pruning (Task 0.2), so no agentic-qe#736 prune step runs.
//   5 apply     writers again, then the same imports into the real root; its
//               counts must equal the rehearsal's. On a mismatch: stop, leave
//               the strays, print the backup and how to restore it.
//   6 archive   writers again; move each whole stray folder to
//               <run>/archive/<slug>/.agentic-qe (copy, check, remove across
//               filesystems; on Windows a failed rename leaves that stray).
//   7 receipt   <run>/receipt.json.
// <run> = <state>/agentic-kit/aqe-store-merge/<ISO time>. Nothing ak writes
// lies inside any .agentic-qe folder: AQE restores any memory*.db over 1 MB it
// finds there when memory.db is missing (AQE/dist/kernel/unified-memory.js).
// The archive is kept until the user deletes it.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { run } from './exec.mjs';
import { withDb } from './sqlite.mjs';
import { findStrayMemoryStores } from './project-memory.mjs';
import { storeHolders } from './aqe-store-holders.mjs';
import { desiredAqePin } from './aqe-project-pin.mjs';
import { cmpVersions, installedVersion } from './versions.mjs';

/** @typedef {{ root: string, status?: 'nothing'|'preview'|'refused'|'failed'|'merged', runId: string|null, dir: string|null,
 *   aqeVersion: string|null, skipped: Array<{ path: string, reason: string }>, backup: string|null,
 *   archived: Array<{ path: string, to: string }>, leftInPlace: Array<{ path: string, reason: string }>,
 *   strays?: any[], expected?: { patterns: number, experiences: number }|null, holders?: any, rootStore?: any,
 *   reason?: string, refusal?: string|null, restore?: string, receipt?: string, after?: { patterns: number, experiences: number }|null }} MergeResult */

export const MIN_AQE_VERSION = '3.14.4';
const STORE_FILES = ['memory.db', 'memory.db-wal', 'memory.db-shm'];
const AQE_TIMEOUT_MS = 10 * 60_000;
const CLOSE_SESSIONS = 'close the Claude Code, Codex and OpenCode sessions in this project (their AQE MCP servers and hooks write the store), then run it again';

/** Archive folder name for a stray at `relative` (e.g. `docs/.agentic-qe`):
 *  its parent path, dot folders spelled `dot-…`, never `.agentic-qe`. */
export function archiveSlug(relative) {
  const parent = path.posix.dirname(relative.split(path.sep).join('/'));
  return parent.split('/').filter((s) => s && s !== '.')
    .map((s) => (s.startsWith('.') ? `dot-${s.slice(1)}` : s).replace(/[^A-Za-z0-9._-]/g, '_'))
    .join('--') || 'root';
}

const insideAqeFolder = (file) => path.resolve(file).split(path.sep).includes('.agentic-qe');
function assertOutsideAqe(file) {
  if (insideAqeFolder(file)) throw new Error(`refusing to write ${file}: it lies inside a .agentic-qe folder`);
}

/** cp -p: contents, mode and times. */
function copyPreserving(from, to) {
  fs.copyFileSync(from, to);
  const st = fs.statSync(from);
  fs.chmodSync(to, st.mode & 0o777);
  fs.utimesSync(to, st.atime, st.mtime);
}

function copyStore(dir, into) {
  fs.mkdirSync(into, { recursive: true });
  for (const name of STORE_FILES) {
    const from = path.join(dir, name);
    if (fs.existsSync(from)) copyPreserving(from, path.join(into, name));
  }
  return path.join(into, 'memory.db');
}

const hasTable = (db, name) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const patternKey = (row) => JSON.stringify([row.name, row.qe_domain, row.pattern_type]);

/** Pattern keys, experience ids and witness rows of one store copy. */
function readStore(file, openDb) {
  const result = openDb(file, (db) => ({
    keys: hasTable(db, 'qe_patterns') ? db.prepare('SELECT name, qe_domain, pattern_type FROM qe_patterns').all().map(patternKey) : [],
    experiences: hasTable(db, 'captured_experiences') ? db.prepare('SELECT id FROM captured_experiences').all().map((r) => String(r.id)) : [],
    witnessRows: hasTable(db, 'witness_chain') ? Number(db.prepare('SELECT COUNT(*) AS n FROM witness_chain').get()?.n ?? 0) : 0,
  }));
  return result.ok ? { readable: true, ...result.value } : { readable: false, keys: [], experiences: [], witnessRows: 0, error: result.error.kind };
}

const counts = (store) => ({ patterns: store.keys.length, experiences: store.experiences.length });

function checkStore(file, openDb) {
  const result = openDb(file, (db) => ({
    integrity: String(Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? ''),
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length,
  }));
  if (!result.ok) return `cannot read ${file} (${result.error.kind})`;
  if (result.value.integrity !== 'ok') return `integrity_check: ${result.value.integrity}`;
  if (result.value.foreignKeys) return `foreign_key_check: ${result.value.foreignKeys} violation(s)`;
  return null;
}

function strayFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  } catch { return []; }
}

// ---- 1 preview ------------------------------------------------------------

function preview(root, strays, scratch, openDb) {
  const rootCopy = readStore(copyStore(path.join(root, '.agentic-qe'), path.join(scratch, 'root')), openDb);
  const inRoot = new Set(rootCopy.keys);
  const known = new Set(rootCopy.keys);
  const ids = new Set(rootCopy.experiences);
  const rows = strays.map((stray) => {
    const copy = copyStore(stray.file, path.join(scratch, 'strays', stray.slug));
    const store = readStore(copy, openDb);
    const entry = {
      path: stray.path, dir: stray.file, slug: stray.slug, copy, readable: store.readable, ...(store.error ? { error: store.error } : {}),
      patterns: store.keys.length, experiences: store.experiences.length, witnessRows: store.witnessRows,
      alreadyInRoot: store.keys.filter((key) => inRoot.has(key)).length,
      newPatterns: store.keys.filter((key) => !known.has(key)).length,
      newExperiences: store.experiences.filter((id) => !ids.has(id)).length,
    };
    for (const key of store.keys) known.add(key);
    for (const id of store.experiences) ids.add(id);
    return entry;
  });
  return {
    rootStore: { ...counts(rootCopy), readable: rootCopy.readable, ...(rootCopy.error ? { error: rootCopy.error } : {}) },
    strays: rows, expected: { patterns: known.size, experiences: ids.size },
  };
}

// ---- 2 writers --------------------------------------------------------------

function holderRefusal(found, platform) {
  if (found.error) return `could not check which processes hold the AQE stores (${found.error}); ${CLOSE_SESSIONS}`;
  if (found.holders.length) {
    const list = found.holders.map((h) => `PID ${h.pid} ${h.command || '(unknown)'}`).join(', ');
    return `${found.holders.length} process(es) hold the AQE stores: ${list}; ${CLOSE_SESSIONS}`;
  }
  if (!found.complete && platform !== 'win32') return `could not check every process holding the AQE stores (${found.method}); ${CLOSE_SESSIONS}`;
  return null;
}

async function writersCheck(o, root, strays, { withRoot = true } = {}) {
  const files = [
    ...(withRoot ? STORE_FILES.map((name) => path.join(root, '.agentic-qe', name)) : []),
    ...strays.flatMap((stray) => strayFiles(stray.dir)),
  ];
  const found = await o.holders(files, { platform: o.platform, root });
  return { found, refusal: holderRefusal(found, o.platform) };
}

// ---- 4/5 AQE brain export/import -------------------------------------------

const quiet = { NO_COLOR: '1', FORCE_COLOR: '0' };
const importCount = (stdout, label) => Number(new RegExp(`${label}:\\s*(\\d+)`).exec(String(stdout))?.[1] ?? NaN);

async function aqe(o, args, { cwd, env }) {
  const result = await o.runner('aqe', args, { cwd, env: { ...env, ...quiet }, timeout: AQE_TIMEOUT_MS });
  if (result.code !== 0) {
    const tail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new Error(`aqe ${args.slice(0, 2).join(' ')} failed: ${tail}`);
  }
  return { imported: importCount(result.stdout, 'Imported'), skipped: importCount(result.stdout, 'Skipped') };
}

/** Delete the audit-trail rows from a stray's scratch copy (B5-D4). */
function dropWitnessRows(file, openDb) {
  const result = openDb(file, (db) => (hasTable(db, 'witness_chain') ? Number(db.prepare('DELETE FROM witness_chain').run().changes) : 0), { readonly: false });
  if (!result.ok) throw new Error(`cannot prepare ${file} (${result.error.kind})`);
  return result.value;
}

async function exportStrays(o, rows, scratch, scratchEnv) {
  for (const stray of rows) {
    stray.witnessRowsNotImported = dropWitnessRows(stray.copy, o.openDb);
    stray.export = path.join(scratch, 'export', stray.slug);
    await aqe(o, ['brain', 'export', '--db', stray.copy, '--format', 'jsonl', '-o', stray.export], scratchEnv);
  }
}

async function importAll(o, rows, target, context) {
  for (const stray of rows) {
    await aqe(o, ['brain', 'import', '--db', target, '-i', stray.export, '--dry-run'], context);
    await aqe(o, ['brain', 'import', '--db', target, '-i', stray.export], context);
  }
  const after = readStore(target, o.openDb);
  if (!after.readable) throw new Error(`cannot read ${target} after the import (${after.error})`);
  return { counts: counts(after), problem: checkStore(target, o.openDb) };
}

const sameCounts = (a, b) => a.patterns === b.patterns && a.experiences === b.experiences;

// ---- 6 archive --------------------------------------------------------------

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}:${fs.lstatSync(full).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

function moveAcrossDevices(from, to) {
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  const want = listTree(from).join('\n');
  if (listTree(to).join('\n') !== want) throw Object.assign(new Error('copied archive differs from the source'), { code: 'ECOPY' });
  fs.rmSync(from, { recursive: true });
}

function archive(o, rows, runDir) {
  const archived = [];
  const leftInPlace = [];
  for (const stray of rows) {
    const to = path.join(runDir, 'archive', stray.slug, '.agentic-qe');
    assertOutsideAqe(path.dirname(to));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      try { o.rename(stray.dir, to); } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        moveAcrossDevices(stray.dir, to);
      }
      archived.push({ path: stray.path, to });
    } catch (error) {
      const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
      leftInPlace.push({ path: stray.path, reason: busy ? `${error.code}: a process still holds it` : `${error?.code ?? 'error'}: ${error?.message}` });
    }
  }
  return { archived, leftInPlace };
}

// ---- the command ------------------------------------------------------------

const stampOf = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');

/** Remove a run folder that holds only this run's scratch copies. */
function removeRunScratch(o, dir) {
  if (path.dirname(dir) === path.resolve(o.mergeDir)) fs.rmSync(dir, { recursive: true, force: true });
}

function strayStores(root) {
  const found = findStrayMemoryStores(root).strays.filter((stray) => stray.kind === 'aqe');
  const slugs = new Set();
  const strays = [];
  const skipped = [];
  for (const stray of found) {
    if (!fs.existsSync(path.join(stray.file, 'memory.db'))) { skipped.push({ path: stray.path, reason: 'no memory.db' }); continue; }
    let slug = archiveSlug(stray.path);
    for (let n = 2; slugs.has(slug); n += 1) slug = `${archiveSlug(stray.path)}-${n}`;
    slugs.add(slug);
    strays.push({ ...stray, slug });
  }
  return { strays, skipped };
}

function versionRefusal(version) {
  if (!version) return `agentic-qe is not installed; install agentic-qe ${MIN_AQE_VERSION} or later first`;
  if (cmpVersions(version, MIN_AQE_VERSION) < 0) return `agentic-qe ${version} is older than ${MIN_AQE_VERSION}, the first release this merge was proven with; upgrade it first (ak sync)`;
  return null;
}

function writeReceipt(result, extra) {
  const file = path.join(result.dir, 'receipt.json');
  assertOutsideAqe(file);
  fs.writeFileSync(file, `${JSON.stringify({
    root: result.root, runId: result.runId, status: result.status, aqeVersion: result.aqeVersion,
    holderMethod: result.holders?.method ?? null, backup: result.backup, ...extra,
    strays: result.strays.map((s) => ({
      path: s.path, patterns: s.patterns, experiences: s.experiences, alreadyInRoot: s.alreadyInRoot,
      witnessRowsNotImported: s.witnessRowsNotImported ?? 0, prunedPatterns: 0,
    })),
    archived: result.archived, leftInPlace: result.leftInPlace,
  }, null, 2)}\n`);
  return file;
}

function rootRefusal(root, store) {
  if (store.readable) return null;
  if (store.error === 'absent') return `no project store at ${path.join(root, '.agentic-qe', 'memory.db')}; run \`aqe init\` in ${root} (or \`ak setup --project\`) first`;
  return `the root store copy is unreadable (${store.error})`;
}

const restoreText = (backup, root) => `with every Claude Code, Codex and OpenCode session in this project closed, copy ${backup} over `
  + `${path.join(root, '.agentic-qe', 'memory.db')} and delete memory.db-wal and memory.db-shm beside it`;

/** Steps 3-7, after the preview and the first writer check passed. */
async function applyMerge(o, root, result, rows) {
  const scratch = path.join(result.dir, 'scratch');
  const real = path.join(root, '.agentic-qe', 'memory.db');
  result.backup = path.join(result.dir, 'backup', 'root-memory.db');
  assertOutsideAqe(result.backup);
  fs.mkdirSync(path.dirname(result.backup), { recursive: true });
  const vacuum = o.openDb(real, (db) => db.exec(`VACUUM INTO '${result.backup.replaceAll("'", "''")}'`));
  if (!vacuum.ok) return { ...result, status: 'failed', reason: `could not back up the root store (${vacuum.error.kind})` };

  const rehearsal = path.join(scratch, 'rehearsal', 'memory.db');
  fs.mkdirSync(path.dirname(rehearsal), { recursive: true });
  fs.copyFileSync(result.backup, rehearsal);
  const scratchEnv = { cwd: scratch, env: { AQE_PROJECT_ROOT: scratch, AQE_MEMORY_PATH: rehearsal, AQE_STORAGE_PATH: path.join(scratch, 'aqe-state') } };
  await exportStrays(o, rows, scratch, scratchEnv);
  const rehearsed = await importAll(o, rows, rehearsal, scratchEnv);
  if (rehearsed.problem || !sameCounts(rehearsed.counts, result.expected)) {
    return { ...result, status: 'failed', reason: rehearsed.problem ?? `rehearsal count mismatch: expected ${JSON.stringify(result.expected)}, got ${JSON.stringify(rehearsed.counts)}; nothing was changed` };
  }

  const second = await writersCheck(o, root, rows);
  if (second.refusal) return { ...result, status: 'refused', reason: `${second.refusal} (stopped before the real import; nothing was changed)` };
  const applied = await importAll(o, rows, real, { cwd: root, env: desiredAqePin(root) });
  const done = { ...result, after: applied.counts };
  if (applied.problem || !sameCounts(applied.counts, rehearsed.counts)) {
    return { ...done, status: 'failed', restore: restoreText(result.backup, root),
      reason: `${applied.problem ?? `count mismatch after the import: rehearsal ${JSON.stringify(rehearsed.counts)}, root ${JSON.stringify(applied.counts)}`}; the strays were left in place` };
  }

  const third = await writersCheck(o, root, rows, { withRoot: false });
  if (third.refusal) return { ...done, status: 'refused', reason: `${third.refusal} (the stores were merged; run it again to archive the strays)` };
  const moved = archive(o, rows, result.dir);
  fs.rmSync(scratch, { recursive: true, force: true });
  return { ...done, ...moved, status: 'merged' };
}

/**
 * Preview (default) or merge every stray AQE store below `root` into
 * `<root>/.agentic-qe/memory.db`.
 * @param {string} root the project root (repoRoot)
 * @param {{ apply?: boolean, mergeDir?: string, now?: number, platform?: NodeJS.Platform, runner?: typeof run,
 *   holders?: typeof storeHolders, openDb?: typeof withDb, rename?: (from: string, to: string) => void,
 *   aqeVersion?: string|null }} [options]
 * @returns {Promise<MergeResult>}
 */
export async function mergeAqeStores(root, options = {}) {
  const o = {
    apply: false, mergeDir: paths.aqeStoreMergeDir(), now: Date.now(), platform: process.platform, runner: run,
    holders: storeHolders, openDb: withDb, rename: fs.renameSync, ...options,
  };
  if (!('aqeVersion' in options)) o.aqeVersion = installedVersion('agentic-qe');
  const { strays, skipped } = strayStores(root);
  /** @type {MergeResult} */
  const base = { root, runId: null, dir: null, aqeVersion: o.aqeVersion, skipped, backup: null, archived: [], leftInPlace: [] };
  if (!strays.length) return { ...base, status: 'nothing', strays: [], expected: null, holders: null };

  const runId = stampOf(o.now);
  const dir = path.join(path.resolve(o.mergeDir), runId);
  assertOutsideAqe(dir);
  /** @type {MergeResult} */
  let result = { ...base, runId, dir };
  try {
    const seen = preview(root, strays, path.join(dir, 'scratch'), o.openDb);
    const first = await writersCheck(o, root, strays);
    result = { ...result, ...seen, holders: first.found };
    const unreadable = seen.strays.filter((s) => !s.readable).map((s) => s.path);
    if (!o.apply) { removeRunScratch(o, dir); return { ...result, status: 'preview', refusal: first.refusal }; }
    const refusal = first.refusal ?? versionRefusal(o.aqeVersion)
      ?? rootRefusal(root, seen.rootStore)
      ?? (unreadable.length ? `unreadable stray store copies: ${unreadable.join(', ')}` : null);
    if (refusal) { removeRunScratch(o, dir); return { ...result, status: 'refused', reason: refusal }; }
    result = await applyMerge(o, root, result, seen.strays);
  } catch (error) {
    result = { ...result, status: 'failed', reason: String(error?.message ?? error),
      ...(result.backup ? { restore: restoreText(result.backup, root) } : {}) };
  }
  if (result.backup) {
    const before = { patterns: result.rootStore.patterns, experiences: result.rootStore.experiences };
    result.receipt = writeReceipt(result, { before, after: result.after ?? null });
  }
  return result;
}
