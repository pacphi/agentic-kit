// Merge stray AQE stores into the project store, then archive them (decisions
// B5-D2..D4). A stray `.agentic-qe` below the project root holds patterns and
// experiences AQE learned while a command, hook or MCP server ran in that
// folder without ak's pin; the project's hosts never read it.
//
// Sequence (`mergeAqeStores`):
//   1 preview   copy the root and every stray store (memory.db, -wal, -shm)
//               into <run>/scratch and count there. A real store is never
//               opened for a preview, not even read-only (a WAL open touches
//               -shm). AQE's starter patterns (decision B5-D5) come from a
//               fresh store AQE builds in <run>/scratch/seed: `aqe init --auto
//               --minimal` lays it out and `aqe learning stats --json` starts
//               the reasoning bank, which seeds 22 static patterns
//               (AQE/dist/learning/pretrained-patterns.js:15) and their
//               cross-domain copies named "<name> (from <domain>)"
//               (pattern-promotion.js:198), keeping those whose embedding is
//               not too close to a target-domain pattern (:183-190). The copies
//               depend on the embedder, so the build takes the project's
//               AQE_EMBEDDER_* keys; `aqe init` alone seeds nothing
//               (AQE/dist/init/phases/05-learning.js:76-97). Seeds are matched
//               by (name, qe_domain, pattern_type); no starter set = refuse. A
//               dry run stops here and removes its scratch.
//   2 writers   refuse while any process holds the root or a stray store, or
//               when that cannot be checked (aqe-store-holders.mjs; on Windows
//               the census stands in). No force: AQE's writers take no lock a
//               merge could wait on (agentic-qe#753).
//   3 backup    VACUUM INTO <run>/backup/root-memory.db.
//   4 rehearse  on a copy of that backup: per stray copy, delete its
//               witness_chain rows (appended unlinked they break the root's
//               audit chain; Branch 5 Task 0.2, agentic-qe#759) and the starter patterns the
//               root does not hold, with the rows that must reference them (a
//               *pattern_id column that is NOT NULL or a foreign key to
//               qe_patterns: embeddings, usage, null results, lineage,
//               relationships by source or target); nullable references such
//               as concept_nodes.pattern_id are cleared. Starter patterns the
//               root holds stay in the export: AQE skips them and remaps their
//               usage onto the root's pattern. Then `aqe brain export --format
//               jsonl`, `aqe brain import --dry-run`, then the import. Counts
//               must equal the preview's union by (name, qe_domain,
//               pattern_type) and experience id; integrity and foreign keys
//               clean. AQE 3.14.4 skips shared patterns as conflicts without
//               pruning (Task 0.2), so no agentic-qe#736 prune step runs.
//               The archived strays keep their starter patterns.
//   5 apply     writers again, and every store must look as it did when the
//               preview copied it (fingerprint: size and mtime of each file; the
//               holder checks only see files open at that instant, review M2);
//               a change stops here. Then the same imports into the real root;
//               its counts must equal the rehearsal's. On a mismatch: stop,
//               leave the strays, print the backup and how to restore it.
//   6 archive   writers again; move each whole stray folder to
//               <run>/archive/<slug>/.agentic-qe (copy, check, remove across
//               filesystems; on Windows a failed rename leaves that stray). A
//               stray that changed since its copy stays in place, reported.
//   7 receipt   <run>/receipt.json, first written with status "applying" right
//               before the real import (review minor 8): a run interrupted
//               there leaves it, and status reports it until a later merge of
//               the same root completes (that marks it "interrupted").
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
import { cmpVersions } from './versions.mjs';

/** @typedef {{ root: string, status?: 'nothing'|'preview'|'refused'|'failed'|'merged', runId: string|null, dir: string|null,
 *   aqeVersion: string|null, skipped: Array<{ path: string, reason: string }>, backup: string|null,
 *   archived: Array<{ path: string, to: string }>, leftInPlace: Array<{ path: string, reason: string }>,
 *   strays?: any[], expected?: { patterns: number, experiences: number }|null, holders?: any, rootStore?: any,
 *   reason?: string, refusal?: string|null, restore?: string, receipt?: string, after?: { patterns: number, experiences: number }|null,
 *   seeds?: { patterns: number, source: string|null, error?: string },
 *   interrupted?: Array<{ runId: string, receipt: string, backup: string|null }> }} MergeResult */

export const MIN_AQE_VERSION = '3.14.4';
const STORE_FILES = ['memory.db', 'memory.db-wal', 'memory.db-shm'];
const AQE_TIMEOUT_MS = 10 * 60_000;
const EMBEDDER_KEY = /^AQE_EMBEDDER_/;
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

/** What a store looked like when the preview copied it (review M2): every file of a
 *  stray folder (the whole folder moves) with size and mtime; for the root only
 *  memory.db and a non-empty -wal, since the backup's own read-only open creates an
 *  empty -wal and a -shm there (the -shm holds no data). */
function fingerprint(dir, { root = false } = {}) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { if (!root) walk(full); continue; }
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      const relative = path.relative(dir, full);
      if (root && (!STORE_FILES.includes(relative) || relative === 'memory.db-shm' || (relative === 'memory.db-wal' && st.size === 0))) continue;
      out.push(`${relative}:${st.size}:${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

const CHANGED = 'changed since it was copied for this merge; its data may be newer than the copy';

function strayFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  } catch { return []; }
}

// ---- 1 preview ------------------------------------------------------------

function preview(root, strays, scratch, openDb, seedKeys) {
  const fingerprints = { root: fingerprint(path.join(root, '.agentic-qe'), { root: true }), strays: new Map() };
  const rootFile = copyStore(path.join(root, '.agentic-qe'), path.join(scratch, 'root'));
  const rootCopy = readStore(rootFile, openDb);
  // Checked on the copy before any backup (review minor 7): a root that already
  // fails would fail every rehearsal and leave a backup per retry.
  const rootProblem = rootCopy.readable ? checkStore(rootFile, openDb) : null;
  const inRoot = new Set(rootCopy.keys);
  const known = new Set(rootCopy.keys);
  const ids = new Set(rootCopy.experiences);
  const rootExperiences = new Set(rootCopy.experiences);
  const rows = strays.map((stray) => {
    fingerprints.strays.set(stray.file, fingerprint(stray.file));
    const copy = copyStore(stray.file, path.join(scratch, 'strays', stray.slug));
    const store = readStore(copy, openDb);
    const kept = store.keys.filter((key) => !seedKeys.has(key));
    const seedsInRoot = store.keys.filter((key) => seedKeys.has(key) && inRoot.has(key)).length;
    const entry = {
      path: stray.path, dir: stray.file, slug: stray.slug, copy, readable: store.readable, ...(store.error ? { error: store.error } : {}),
      patterns: store.keys.length, experiences: store.experiences.length, witnessRows: store.witnessRows,
      alreadyInRoot: store.keys.filter((key) => inRoot.has(key)).length,
      seedPatterns: store.keys.length - kept.length - seedsInRoot, seedPatternsInRoot: seedsInRoot,
      newPatterns: kept.filter((key) => !known.has(key)).length,
      newExperiences: store.experiences.filter((id) => !ids.has(id)).length,
      // AQE's import (skip-conflicts) skips an id the root holds even when its content differs.
      experiencesInRoot: store.experiences.filter((id) => rootExperiences.has(id)).length,
    };
    for (const key of kept) known.add(key);
    for (const id of store.experiences) ids.add(id);
    return entry;
  });
  return {
    rootStore: { ...counts(rootCopy), readable: rootCopy.readable, ...(rootCopy.error ? { error: rootCopy.error } : {}), ...(rootProblem ? { problem: rootProblem } : {}) },
    strays: rows, expected: { patterns: known.size, experiences: ids.size }, fingerprints, rootKeys: inRoot,
  };
}

/** The first store that changed since the preview copied it, as a refusal, or null. */
function changedSinceCopy(root, rows, fingerprints) {
  if (fingerprint(path.join(root, '.agentic-qe'), { root: true }) !== fingerprints.root) {
    return 'the project store changed since the preview copied it (a writer ran in between)';
  }
  const stray = rows.find((row) => fingerprint(row.dir) !== fingerprints.strays.get(row.dir));
  return stray ? `${stray.path} ${CHANGED}` : null;
}

/** The AQE_EMBEDDER_* keys the project's hosts give AQE: Claude Code's
 *  settings (local, then shared), then the project AQE MCP registration. */
export function projectEmbedderEnv(root) {
  /** @type {Array<[string, (doc: any) => any]>} */
  const sources = [
    ['.claude/settings.local.json', (doc) => doc?.env],
    ['.claude/settings.json', (doc) => doc?.env],
    ['.mcp.json', (doc) => doc?.mcpServers?.['agentic-qe']?.env],
  ];
  for (const [relative, pick] of sources) {
    let env;
    try { env = pick(JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))); } catch { continue; }
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    const keys = Object.entries(env).filter(([key, value]) => EMBEDDER_KEY.test(key) && typeof value === 'string');
    if (keys.length) return { env: Object.fromEntries(keys), source: relative };
  }
  return { env: {}, source: 'inherited environment' };
}

/** AQE's starter patterns, from a fresh store AQE builds in <scratch>/seed. */
async function starterSet(o, root, scratch) {
  const dir = path.join(scratch, 'seed');
  fs.mkdirSync(dir, { recursive: true });
  const store = path.join(dir, '.agentic-qe', 'memory.db');
  const embedder = projectEmbedderEnv(root);
  const context = { cwd: dir, env: {
    ...embedder.env, AQE_PROJECT_ROOT: dir, AQE_MEMORY_PATH: store, AQE_STORAGE_PATH: path.dirname(store),
    npm_config_prefix: path.join(dir, 'npm-global'), npm_config_cache: path.join(dir, 'npm-cache'),
  } };
  const none = (error) => ({ keys: new Set(), source: embedder.source, error });
  try {
    await aqe(o, ['init', '--auto', '--minimal'], context);
    await aqe(o, ['learning', 'stats', '--json'], context);
  } catch (error) { return none(String(error?.message ?? error)); }
  const fresh = readStore(store, o.openDb);
  if (!fresh.readable) return none(`cannot read the fresh store (${fresh.error})`);
  if (!fresh.keys.length) return none(`the fresh store holds no starter patterns; AQE stores none without a working embedder (embedder from ${embedder.source})`);
  return { keys: new Set(fresh.keys), source: embedder.source };
}

const starterRefusal = (seeds) => (seeds.error
  ? `could not build AQE's starter pattern set (${seeds.error}); without it a merge would import AQE's starter patterns again`
  : null);

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

const quoted = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** The columns of `table` that name a qe_patterns row (pattern_id, source_pattern_id,
 *  target_pattern_id, ...: the columns AQE's import remaps, brain-shared.js
 *  remapPatternReferences). `required`: NOT NULL or a foreign key to qe_patterns, so a
 *  row pointing at a left-out pattern goes; otherwise the reference is cleared. */
function patternReferences(db, table) {
  const fks = db.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all();
  return db.prepare(`PRAGMA table_info(${quoted(table)})`).all()
    .filter((c) => /(^|_)pattern_id$/.test(c.name))
    .map((c) => ({ table, column: String(c.name), required: !!c.notnull || fks.some((fk) => fk.table === 'qe_patterns' && fk.from === c.name) }));
}

/** Delete AQE's starter patterns the root does not hold, and the rows that must
 *  reference them, from a stray's scratch copy (B5-D5); nullable references to them
 *  are cleared (review minor 5). Seeds the root already holds stay: AQE's import skips
 *  them and remaps their usage and lineage onto the root's pattern (review minor 4).
 *  Returns the number of patterns removed. */
function dropStarterPatterns(file, seedKeys, rootKeys, openDb) {
  const result = openDb(file, (db) => {
    if (!seedKeys.size || !hasTable(db, 'qe_patterns')) return 0;
    const ids = db.prepare('SELECT id, name, qe_domain, pattern_type FROM qe_patterns').all()
      .filter((row) => seedKeys.has(patternKey(row)) && !rootKeys.has(patternKey(row))).map((row) => row.id);
    if (!ids.length) return 0;
    const references = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'qe_patterns'").all()
      .flatMap((row) => patternReferences(db, String(row.name)));
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        for (const ref of references) {
          db.prepare(ref.required
            ? `DELETE FROM ${quoted(ref.table)} WHERE ${quoted(ref.column)} = ?`
            : `UPDATE ${quoted(ref.table)} SET ${quoted(ref.column)} = NULL WHERE ${quoted(ref.column)} = ?`).run(id);
        }
        db.prepare('DELETE FROM qe_patterns WHERE id = ?').run(id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return ids.length;
  }, { readonly: false });
  if (!result.ok) throw new Error(`cannot leave AQE's starter patterns out of ${file} (${result.error.kind}: ${result.error.message})`);
  return result.value;
}

async function exportStrays(o, rows, scratch, scratchEnv, seedKeys, rootKeys) {
  for (const stray of rows) {
    stray.witnessRowsNotImported = dropWitnessRows(stray.copy, o.openDb);
    stray.seedPatternsSkipped = dropStarterPatterns(stray.copy, seedKeys, rootKeys, o.openDb);
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

function moveAcrossDevices(from, to, remove) {
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  const want = listTree(from).join('\n');
  if (listTree(to).join('\n') !== want) throw Object.assign(new Error('copied archive differs from the source'), { code: 'ECOPY' });
  try { remove(from); } catch (error) {
    // The archive copy is complete; part of the source may already be gone (review minor 10).
    let remains = [];
    try { remains = listTree(from).map((entry) => entry.replace(/:\d+$/, '')); } catch { /* gone after all */ }
    throw Object.assign(new Error(`partially moved: the archive copy at ${to} is complete, but removing the source failed `
      + `(${error?.code ?? 'error'}: ${error?.message}) and left ${remains.length ? remains.join(', ') : 'an empty folder'}`), { code: 'EPARTIAL' });
  }
}

function archive(o, rows, runDir, fingerprints) {
  const archived = [];
  const leftInPlace = [];
  for (const stray of rows) {
    if (fingerprint(stray.dir) !== fingerprints.strays.get(stray.dir)) {
      leftInPlace.push({ path: stray.path, reason: `${CHANGED}; run ak x aqe-store merge --yes again to merge what it gained` });
      continue;
    }
    const to = path.join(runDir, 'archive', stray.slug, '.agentic-qe');
    assertOutsideAqe(path.dirname(to));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      try { o.rename(stray.dir, to); } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        moveAcrossDevices(stray.dir, to, o.remove);
      }
      archived.push({ path: stray.path, to });
    } catch (error) {
      const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
      leftInPlace.push({ path: stray.path, reason: error?.code === 'EPARTIAL' ? error.message
        : busy ? `${error.code}: a process still holds it` : `${error?.code ?? 'error'}: ${error?.message}` });
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
  const scan = findStrayMemoryStores(root);
  const found = scan.strays.filter((stray) => stray.kind === 'aqe');
  const slugs = new Set();
  const strays = [];
  // A nested repository or a worktree inside the checkout keeps its own store (review M3).
  const skipped = (scan.nestedRepositories ?? [])
    .filter((relative) => fs.existsSync(path.join(root, ...relative.split('/'), '.agentic-qe')))
    .map((relative) => ({ path: relative, reason: 'its own repository; its .agentic-qe is that repository\'s store' }));
  for (const stray of found) {
    if (!fs.existsSync(path.join(stray.file, 'memory.db'))) { skipped.push({ path: stray.path, reason: 'no memory.db' }); continue; }
    let slug = archiveSlug(stray.path);
    for (let n = 2; slugs.has(slug); n += 1) slug = `${archiveSlug(stray.path)}-${n}`;
    slugs.add(slug);
    strays.push({ ...stray, slug });
  }
  return { strays, skipped };
}

/** The version of the `aqe` on PATH, the one that runs the import (npm's
 *  global tree can be another install, or redirected by npm_config_prefix). */
async function aqeCliVersion(runner) {
  const result = await runner('aqe', ['--version'], { env: quiet, timeout: 60_000 });
  return result.code === 0 ? /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(String(result.stdout))?.[1] ?? null : null;
}

function versionRefusal(version) {
  if (!version) return `agentic-qe is not installed; install agentic-qe ${MIN_AQE_VERSION} or later first`;
  if (cmpVersions(version, MIN_AQE_VERSION) < 0) return `agentic-qe ${version} is older than ${MIN_AQE_VERSION}, the first release this merge was proven with; upgrade it first (ak sync)`;
  return null;
}

/** Earlier runs for this root whose receipt still says "applying": interrupted during
 *  the real import (review minor 8). */
function interruptedRuns(mergeDir, root, currentRunId = null) {
  let names;
  try { names = fs.readdirSync(mergeDir); } catch { return []; }
  const runs = [];
  for (const name of names.sort()) {
    if (name === currentRunId) continue;
    const file = path.join(mergeDir, name, 'receipt.json');
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (receipt?.status === 'applying' && receipt.root === root) runs.push({ runId: receipt.runId ?? name, receipt: file, backup: receipt.backup ?? null });
  }
  return runs;
}

/** A completed merge of the same root supersedes the interrupted ones. */
function resolveInterrupted(runs, runId) {
  for (const run of runs) {
    try {
      const receipt = JSON.parse(fs.readFileSync(run.receipt, 'utf8'));
      fs.writeFileSync(run.receipt, `${JSON.stringify({ ...receipt, status: 'interrupted', resolvedBy: runId }, null, 2)}\n`);
    } catch { /* left as it was; status keeps reporting it */ }
  }
}

function writeReceipt(result, extra) {
  const file = path.join(result.dir, 'receipt.json');
  assertOutsideAqe(file);
  fs.writeFileSync(file, `${JSON.stringify({
    root: result.root, runId: result.runId, status: result.status, aqeVersion: result.aqeVersion,
    holderMethod: result.holders?.method ?? null, backup: result.backup, ...extra, seedSet: result.seeds ?? null,
    strays: result.strays.map((s) => ({
      path: s.path, patterns: s.patterns, experiences: s.experiences, alreadyInRoot: s.alreadyInRoot,
      witnessRowsNotImported: s.witnessRowsNotImported ?? 0, seedPatternsSkipped: s.seedPatternsSkipped ?? s.seedPatterns ?? 0,
      seedPatternsInRoot: s.seedPatternsInRoot ?? 0, experiencesInRoot: s.experiencesInRoot ?? 0, prunedPatterns: 0,
    })),
    archived: result.archived, leftInPlace: result.leftInPlace,
  }, null, 2)}\n`);
  return file;
}

function rootRefusal(root, store) {
  if (store.problem) {
    return `the project store ${path.join(root, '.agentic-qe', 'memory.db')} already fails ${store.problem}, before any merge; `
      + 'a merge checks the same on its result, so it would fail; nothing was written. If a session was writing the store '
      + 'while the preview copied it, the copy may be torn: close the sessions and run it again; otherwise repair the store with AQE first';
  }
  if (store.readable) return null;
  if (store.error === 'absent') return `no project store at ${path.join(root, '.agentic-qe', 'memory.db')}; run \`aqe init\` in ${root} (or \`ak setup --project\`) first`;
  return `the root store copy is unreadable (${store.error})`;
}

export const restoreSteps = (backup, root) => {
  const db = path.join(root, '.agentic-qe', 'memory.db');
  return `close every Claude Code, Codex and OpenCode session in this project (their AQE servers and hooks write the store), `
    + `then delete ${db}-wal and ${db}-shm, then copy ${backup} over ${db}, with nothing opening the store in between; `
    + 'this discards every write made to the project store after the backup, the merge\'s and any other';
};

/** Steps 3-7, after the preview and the first writer check passed. */
async function applyMerge(o, root, result, rows, seedKeys, { fingerprints, rootKeys }) {
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
  await exportStrays(o, rows, scratch, scratchEnv, seedKeys, rootKeys);
  const rehearsed = await importAll(o, rows, rehearsal, scratchEnv);
  if (rehearsed.problem || !sameCounts(rehearsed.counts, result.expected)) {
    return { ...result, status: 'failed', reason: rehearsed.problem ?? `rehearsal count mismatch: expected ${JSON.stringify(result.expected)}, got ${JSON.stringify(rehearsed.counts)}; nothing was changed` };
  }

  const second = await writersCheck(o, root, rows);
  if (second.refusal) return { ...result, status: 'refused', reason: `${second.refusal} (stopped before the real import; nothing was changed)` };
  const changed = changedSinceCopy(root, rows, fingerprints);
  if (changed) return { ...result, status: 'refused', reason: `${changed}; stopped before the real import, nothing was changed; run the merge again` };
  writeReceipt({ ...result, status: 'applying' }, { before: { patterns: result.rootStore.patterns, experiences: result.rootStore.experiences }, after: null });
  const applied = await importAll(o, rows, real, { cwd: root, env: desiredAqePin(root) });
  const done = { ...result, after: applied.counts };
  if (applied.problem || !sameCounts(applied.counts, rehearsed.counts)) {
    return { ...done, status: 'failed', restore: restoreSteps(result.backup, root),
      reason: `${applied.problem ?? `count mismatch after the import: rehearsal ${JSON.stringify(rehearsed.counts)}, root ${JSON.stringify(applied.counts)}`}; the strays were left in place` };
  }

  const third = await writersCheck(o, root, rows, { withRoot: false });
  if (third.refusal) return { ...done, status: 'refused', reason: `${third.refusal} (the stores were merged; run it again to archive the strays)` };
  const moved = archive(o, rows, result.dir, fingerprints);
  fs.rmSync(scratch, { recursive: true, force: true });
  return { ...done, ...moved, status: 'merged' };
}

/**
 * Preview (default) or merge every stray AQE store below `root` into
 * `<root>/.agentic-qe/memory.db`.
 * @param {string} root the project root (repoRoot)
 * @param {{ apply?: boolean, mergeDir?: string, now?: number, platform?: NodeJS.Platform, runner?: typeof run,
 *   holders?: typeof storeHolders, openDb?: typeof withDb, rename?: (from: string, to: string) => void, remove?: (dir: string) => void,
 *   aqeVersion?: string|null }} [options]
 * @returns {Promise<MergeResult>}
 */
export async function mergeAqeStores(root, options = {}) {
  const o = {
    apply: false, mergeDir: paths.aqeStoreMergeDir(), now: Date.now(), platform: process.platform, runner: run,
    holders: storeHolders, openDb: withDb, rename: fs.renameSync, remove: (dir) => fs.rmSync(dir, { recursive: true }), ...options,
  };
  const { strays, skipped } = strayStores(root);
  if (strays.length && !('aqeVersion' in options)) o.aqeVersion = await aqeCliVersion(o.runner);
  const interrupted = interruptedRuns(path.resolve(o.mergeDir), root);
  /** @type {MergeResult} */
  const base = { root, runId: null, dir: null, aqeVersion: o.aqeVersion, skipped, backup: null, archived: [], leftInPlace: [], interrupted };
  if (!strays.length) return { ...base, status: 'nothing', strays: [], expected: null, holders: null };

  const runId = stampOf(o.now);
  const dir = path.join(path.resolve(o.mergeDir), runId);
  assertOutsideAqe(dir);
  /** @type {MergeResult} */
  let result = { ...base, runId, dir };
  try {
    const scratch = path.join(dir, 'scratch');
    const tooOld = versionRefusal(o.aqeVersion);
    const starters = tooOld ? { keys: new Set(), source: null, error: tooOld } : await starterSet(o, root, scratch);
    const { fingerprints, rootKeys, ...seen } = preview(root, strays, scratch, o.openDb, starters.keys);
    const first = await writersCheck(o, root, strays);
    const seeds = { patterns: starters.keys.size, source: starters.source, ...(starters.error ? { error: starters.error } : {}) };
    result = { ...result, ...seen, holders: first.found, seeds };
    const unreadable = seen.strays.filter((s) => !s.readable).map((s) => s.path);
    if (!o.apply) {
      removeRunScratch(o, dir);
      return { ...result, status: 'preview', refusal: first.refusal ?? tooOld ?? (seen.rootStore.problem ? rootRefusal(root, seen.rootStore) : null) ?? starterRefusal(starters) };
    }
    const refusal = [first.refusal, tooOld, rootRefusal(root, seen.rootStore),
      unreadable.length ? `unreadable stray store copies: ${unreadable.join(', ')}` : null, starterRefusal(starters)].find(Boolean);
    if (refusal) { removeRunScratch(o, dir); return { ...result, status: 'refused', reason: refusal }; }
    result = await applyMerge(o, root, result, seen.strays, starters.keys, { fingerprints, rootKeys });
  } catch (error) {
    result = { ...result, status: 'failed', reason: String(error?.message ?? error),
      ...(result.backup ? { restore: restoreSteps(result.backup, root) } : {}) };
  }
  if (result.backup) {
    const before = { patterns: result.rootStore.patterns, experiences: result.rootStore.experiences };
    result.receipt = writeReceipt(result, { before, after: result.after ?? null });
  }
  if (result.status === 'merged' && interrupted.length) { resolveInterrupted(interrupted, runId); result.interrupted = []; }
  return result;
}
