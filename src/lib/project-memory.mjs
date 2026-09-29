// Project-memory observability. The native bridge keeps its plaintext store in
// agentdb-memory.db while the compatibility/sql.js surface remains memory.db.
// Both are legitimate. `active` is a historical preferred-display field, not
// evidence of the actual writer or which corpus a CLI/MCP invocation selects.
// Everything here is read-only and bounded: stores are opened read-only, and
// the stray-store search walks a capped number of folders.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { withDb } from './sqlite.mjs';

function activityAt(file) {
  let latest = 0;
  for (const candidate of [file, `${file}-wal`]) {
    try { latest = Math.max(latest, fs.statSync(candidate).mtimeMs); } catch { /* absent */ }
  }
  return latest || null;
}

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}

// The largest namespace and how many of its active rows carry an expiry. Ruflo
// indexes namespace (memory-initializer.js idx_memory_namespace), so this stays
// in milliseconds even on a 168 MB store (measured 2026-09-26, 3.45.0).
function topNamespace(db, columns, active) {
  if (!columns.includes('namespace')) return null;
  const expiring = columns.includes('expires_at') ? 'SUM(expires_at IS NOT NULL)' : 'NULL';
  const row = db.prepare(
    `SELECT COALESCE(namespace, 'default') AS ns, COUNT(*) AS n, ${expiring} AS expiring `
    + `FROM memory_entries WHERE ${active} GROUP BY ns ORDER BY n DESC, ns LIMIT 1`,
  ).get();
  if (!row) return null;
  return { namespace: row.ns, entries: Number(row.n), expiring: row.expiring === null ? null : Number(row.expiring) };
}

function inspectStore(file, kind) {
  if (!fs.existsSync(file)) {
    return {
      kind, file, present: false, readable: false, table: false, entries: null,
      top: null, sizeBytes: null, walBytes: null, activityAt: null,
    };
  }
  const result = withDb(file, (db) => {
    const columns = db.prepare('PRAGMA table_info(memory_entries)').all().map((column) => column.name);
    // `ruflo memory init` creates agentdb-memory.db before any bridge write adds
    // memory_entries (observed on 3.45.0): an empty store, not an unreadable one.
    if (!columns.length) return { readable: true, table: false, entries: 0, top: null };
    const active = columns.includes('status') ? "(status = 'active' OR status IS NULL)" : '1';
    const entries = Number(db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE ${active}`).get()?.n ?? 0);
    return { readable: true, table: true, entries, top: entries ? topNamespace(db, columns, active) : null };
  });
  const observed = result.ok
    ? result.value
    : { readable: false, table: false, entries: null, top: null, reason: result.error.kind };
  return {
    kind, file, present: true, ...observed,
    sizeBytes: fileBytes(file), walBytes: fileBytes(`${file}-wal`) ?? 0, activityAt: activityAt(file),
  };
}

function storePair(sqljsFile, nativeFile) {
  const sqljs = inspectStore(sqljsFile, 'sqljs');
  const native = inspectStore(nativeFile, 'native-agentdb');
  const active = native.present ? native : sqljs.present ? sqljs : null;
  const secondary = active === native && sqljs.present ? sqljs
    : active === sqljs && native.present ? native : null;
  return { active, secondary, stores: [sqljs, native] };
}

export function projectMemoryStatus(root) {
  return storePair(paths.projectMemoryDb(root), paths.projectAgentDbMemoryDb(root));
}

/** The same pair in the user-level store's folder (paths.userMemoryDir). */
export const memoryDirStatus = (dir) => storePair(path.join(dir, 'memory.db'), path.join(dir, 'agentdb-memory.db'));

const lookupEntry = (file, namespace, key) => withDb(file, (db) => {
  const row = db.prepare(
    'SELECT 1 AS found FROM memory_entries WHERE namespace = ? AND key = ? LIMIT 1',
  ).get(namespace, key);
  return row?.found === 1;
});

export function memoryEntryExists(file, namespace, key) {
  const result = lookupEntry(file, namespace, key);
  return result.ok ? result.value : false;
}

export function findMemoryEntry(root, namespace, key) {
  const status = projectMemoryStatus(root);
  return status.stores.find((store) => store.present
    && store.readable
    && store.table
    && memoryEntryExists(store.file, namespace, key)) ?? null;
}

// A disposable probe row is mirrored into both stores by the Ruflo CLI (observed
// on 3.42.4 and 3.45.0), so cleanup must not stop at the first store that holds
// it (issue #213). Ruflo's own `memory delete` only tombstones a row
// (status='deleted'), so the row itself is deleted with bound parameters. Only a
// store that actually holds the row is opened for writing, and an unreadable
// store is reported: it may hold the row, and "removed" must never mean "not
// looked at". A busy live store lands in `failed` for manual cleanup. A store
// without a memory_entries table (agentdb-memory.db right after `memory init`)
// cannot hold the row and is skipped.
export function removeMemoryProbe(root, namespace, key) {
  const removed = [];
  const failed = [];
  for (const store of projectMemoryStatus(root).stores) {
    if (!store.present || (store.readable && !store.table)) continue;
    if (!store.readable) { failed.push({ file: store.file, kind: store.reason }); continue; }
    const held = lookupEntry(store.file, namespace, key);
    if (!held.ok) { failed.push({ file: store.file, kind: held.error.kind }); continue; }
    if (!held.value) continue;
    const result = withDb(store.file, (db) => {
      db.prepare('DELETE FROM memory_entries WHERE namespace = ? AND key = ?').run(namespace, key);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      return true;
    }, { readonly: false });
    if (result.ok) removed.push(path.basename(store.file));
    else failed.push({ file: store.file, kind: result.error.kind });
  }
  return { removed, failed };
}

// Stray stores: memory files this project's hosts never read, each traced to
// its owner in the 2026-09-26 audit (docs/audits). This scan only reports.
// The one exception is the aqe kind: `ak x aqe-store merge --yes`
// (aqe-store-merge.mjs, ADR-0062) merges a stray AQE store into the project
// store and moves the whole folder to ak's state archive, after its holder,
// backup and rehearsal checks. ak never moves, merges or deletes the other
// kinds. Kinds:
//   ruflo       memory.db/agentdb-memory.db anywhere under .swarm/ except the
//               canonical pair and Ruflo's own .swarm/backups/, or a .swarm/
//               store in a subfolder (a Ruflo command ran with that folder as
//               its working directory; Ruflo derives the path from the cwd)
//   agentdb-cli ./agentdb.db, the AgentDB CLI default (agentdb-cli.js)
//   agentdb-rvf ./agentdb.rvf, AgentDB's RVF backend default in the cwd
//   ruvector    ./ruvector.db, RuVector's default in the cwd (`ruvector mcp
//               start`; `ruflo memory init` also creates it, 3.45.0)
//   aqe         a .agentic-qe/ folder below the project root (AQE resolves a
//               relative AQE_MEMORY_PATH against the folder it runs in)
// Bounded: at most `maxDirs` folders listed and `maxDepth` levels deep; dot
// tool homes (including other checkouts under .claude/worktrees), .git and
// node_modules are never walked. Ordinary dot folders are walked. A folder that
// holds `.git` (nested repository, submodule, worktree inside the checkout) is
// another repository: neither it nor anything below it is searched; it is
// listed in `nestedRepositories`.
const RUFLO_STORE_FILES = Object.freeze(['memory.db', 'agentdb-memory.db']);
const ROOT_STRAYS = Object.freeze([['agentdb.db', 'agentdb-cli'], ['agentdb.rvf', 'agentdb-rvf'], ['ruvector.db', 'ruvector']]);
const SCAN_EXCLUDED_DIRS = new Set(['.git', '.swarm', '.agentic-qe', '.claude', '.codex', '.claude-flow', '.agents', '.harness', 'node_modules']);

const isDirectory = (file) => { try { return fs.lstatSync(file).isDirectory(); } catch { return false; } };
const isFile = (file) => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
const storeBytes = (file) => (fileBytes(file) ?? 0) + (fileBytes(`${file}-wal`) ?? 0);

export function findStrayMemoryStores(root, { maxDepth = 4, maxDirs = 2000 } = {}) {
  if (!isDirectory(root)) return { strays: [], complete: true, visited: 0, nestedRepositories: [] };
  const found = new Map();
  const nestedRepositories = [];
  let visited = 0;
  let complete = true;
  const add = (kind, file, sizeBytes) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    found.set(relative, { kind, path: relative, file, sizeBytes });
  };
  const list = (dir) => {
    if (visited >= maxDirs) { complete = false; return null; }
    visited += 1;
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch { complete = false; return []; }
  };
  const checkMarkers = (dir, { ruflo = true } = {}) => {
    if (isDirectory(path.join(dir, '.agentic-qe'))) add('aqe', path.join(dir, '.agentic-qe'), null);
    if (!ruflo) return;
    for (const name of RUFLO_STORE_FILES) {
      const file = path.join(dir, '.swarm', name);
      if (isFile(file)) add('ruflo', file, storeBytes(file));
    }
  };
  const walkSwarm = (dir, depth) => {
    const entries = list(dir);
    for (const entry of entries ?? []) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && depth > 0 && RUFLO_STORE_FILES.includes(entry.name)) add('ruflo', full, storeBytes(full));
      else if (entry.isDirectory() && depth < maxDepth && !(depth === 0 && entry.name === 'backups')) walkSwarm(full, depth + 1);
    }
  };
  // A folder holding `.git` (a folder: nested repository or submodule; a file:
  // a worktree inside the checkout) is another repository: its stores are its
  // own, and ak's pin makes its `.agentic-qe` that repository's store (review M3).
  const otherRepository = (full) => {
    try { fs.lstatSync(path.join(full, '.git')); } catch { return false; }
    nestedRepositories.push(path.relative(root, full).split(path.sep).join('/'));
    return true;
  };
  const walk = (dir, depth) => {
    const entries = list(dir);
    for (const entry of entries ?? []) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name !== '.git' && otherRepository(full)) continue;
      if (entry.name !== '.git') checkMarkers(full, { ruflo: entry.name !== '.swarm' });
      if (SCAN_EXCLUDED_DIRS.has(entry.name)) continue;
      if (depth + 1 < maxDepth) walk(full, depth + 1);
      else {
        // A marker at the depth boundary is visible, but descendants are not.
        const children = list(full);
        if (children?.some((child) => child.isDirectory() && !SCAN_EXCLUDED_DIRS.has(child.name))) complete = false;
      }
    }
  };

  for (const [name, kind] of ROOT_STRAYS) {
    const file = path.join(root, name);
    if (isFile(file)) add(kind, file, storeBytes(file));
  }
  // .swarm first: it is small, and the most likely home of a stray Ruflo store.
  if (isDirectory(path.join(root, '.swarm'))) walkSwarm(path.join(root, '.swarm'), 0);
  walk(root, 0);
  const strays = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { strays, complete, visited, nestedRepositories: nestedRepositories.sort() };
}

// Stray Ruflo stores outside any project (audit 2026-09-26 Addendum 2,
// problem 2): `~/.swarm` (Ruflo ran with the home folder as its working
// directory) and `<CODEX_HOME>/.chatgpt-projects/*/.swarm` (Codex started
// Ruflo inside its own ChatGPT project folders). Report only, like every stray
// store: ak never moves, merges or deletes them. One entry per .swarm folder;
// bounded to `maxProjects` Codex project folders.
/** @param {{ home: string, codexHome?: string, maxProjects?: number }} options */
export function findUserStrayStores({ home, codexHome = path.join(home, '.codex'), maxProjects = 500 }) {
  const strays = [];
  const check = (dir, where) => {
    const files = RUFLO_STORE_FILES.map((name) => path.join(dir, '.swarm', name)).filter(isFile);
    if (files.length) strays.push({ where, dir: path.join(dir, '.swarm'), sizeBytes: files.reduce((sum, file) => sum + storeBytes(file), 0) });
  };
  check(home, 'home');
  const projects = path.join(codexHome, '.chatgpt-projects');
  let entries = [];
  try { entries = fs.readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { /* none */ }
  const complete = entries.length <= maxProjects;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxProjects)) {
    check(path.join(projects, entry.name), 'codex-projects');
  }
  return { strays, complete, projectsDir: projects };
}
