// Shared, per-test AQE merge harness. Every store and mutable runner is private.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './temp-dir.mjs';
import { withDb } from '../../../src/lib/sqlite.mjs';
import { buildStore, EXPERIENCE_DDL } from './aqe-store-merge-fixture.mjs';
export { buildStore };

// AQE 3.14.4 creates this table on demand (AQE/dist/integrations/ruvector/brain-table-ddl.js:163-167).
export const RELATIONSHIPS_DDL = `CREATE TABLE IF NOT EXISTS pattern_relationships (
    id TEXT PRIMARY KEY, source_pattern_id TEXT NOT NULL,
    target_pattern_id TEXT NOT NULL, relationship_type TEXT NOT NULL,
    similarity_score REAL, created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (source_pattern_id) REFERENCES qe_patterns(id) ON DELETE CASCADE
  )`;
const tables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The fake `aqe`: brain export/import over JSONL, recording each call. `init`
 *  lays out an empty store at AQE_MEMORY_PATH and `learning stats` seeds it
 *  with `seeds` the way AQE's reasoning bank does on its first start
 *  (AQE/dist/learning/qe-reasoning-bank.js:147-160). */
export function fakeAqe({ underImportInto = null, version = '3.14.4', seeds = ['S1', 'S2'], initCode = 0 } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
    const flag = (name) => args[args.indexOf(name) + 1];
    if (args[0] === 'init') {
      if (initCode) return { code: initCode, stdout: '', stderr: 'init exploded' };
      buildStore(path.dirname(opts.env.AQE_MEMORY_PATH), { experiences: null });
      return { code: 0, stdout: 'AQE initialized\n', stderr: '' };
    }
    if (args[0] === 'learning' && args[1] === 'stats') {
      const db = new DatabaseSync(opts.env.AQE_MEMORY_PATH);
      for (const name of seeds) {
        db.prepare('INSERT INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)').run(`seed-${name}`, 'workflow', 'test-generation', 'test', name);
      }
      db.close();
      return { code: 0, stdout: JSON.stringify({ totalPatterns: seeds.length }), stderr: '' };
    }
    if (args[0] === 'brain' && args[1] === 'export') {
      const out = flag('-o');
      fs.mkdirSync(out, { recursive: true });
      const db = new DatabaseSync(flag('--db'), { readOnly: true });
      const have = tables(db);
      const dump = (table, file) => fs.writeFileSync(path.join(out, file),
        have.has(table) ? db.prepare(`SELECT * FROM ${table}`).all().map((r) => JSON.stringify(r)).join('\n') : '');
      dump('qe_patterns', 'patterns.jsonl');
      dump('captured_experiences', 'captured-experiences.jsonl');
      dump('witness_chain', 'witness-chain.jsonl');
      dump('qe_pattern_usage', 'pattern-usage.jsonl');
      dump('pattern_relationships', 'pattern-relationships.jsonl');
      dump('concept_nodes', 'concept-nodes.jsonl');
      db.close();
      fs.writeFileSync(path.join(out, 'manifest.json'), '{}');
      return { code: 0, stdout: 'Export complete.\n', stderr: '' };
    }
    if (args[0] === 'brain' && args[1] === 'import') {
      const target = flag('--db');
      const input = flag('-i');
      const dry = args.includes('--dry-run');
      const db = new DatabaseSync(target);
      let imported = 0; let skipped = 0;
      db.exec('BEGIN');
      if (!tables(db).has('captured_experiences')) for (const s of EXPERIENCE_DDL) db.exec(s);
      let patterns = readJsonl(path.join(input, 'patterns.jsonl'));
      if (underImportInto && target === underImportInto) patterns = patterns.slice(0, -1);
      // AQE keeps the root's id for a pattern it already holds and remaps the
      // stray's child rows onto it (brain-shared.js mergeGenericRow, remapPatternReferences).
      const ids = new Map();
      for (const p of patterns) {
        const r = db.prepare('INSERT OR IGNORE INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)')
          .run(p.id, p.pattern_type, p.qe_domain, p.domain, p.name);
        if (r.changes) imported += 1; else skipped += 1;
        const kept = db.prepare('SELECT id FROM qe_patterns WHERE name = ? AND qe_domain = ? AND pattern_type = ?').get(p.name, p.qe_domain, p.pattern_type);
        ids.set(p.id, kept?.id ?? p.id);
      }
      const remap = (id) => (id === null || id === undefined ? id : ids.get(id) ?? id);
      for (const u of readJsonl(path.join(input, 'pattern-usage.jsonl'))) {
        const pid = remap(u.pattern_id);
        if (!db.prepare('SELECT 1 FROM qe_pattern_usage WHERE pattern_id = ? AND created_at = ?').get(pid, u.created_at)) {
          db.prepare('INSERT INTO qe_pattern_usage (pattern_id, success, created_at) VALUES (?, ?, ?)').run(pid, u.success, u.created_at);
        }
      }
      const relationships = readJsonl(path.join(input, 'pattern-relationships.jsonl'));
      if (relationships.length) db.exec(RELATIONSHIPS_DDL);
      for (const r of relationships) {
        db.prepare('INSERT OR IGNORE INTO pattern_relationships (id, source_pattern_id, target_pattern_id, relationship_type) VALUES (?, ?, ?, ?)')
          .run(r.id, remap(r.source_pattern_id), remap(r.target_pattern_id), r.relationship_type);
      }
      for (const c of readJsonl(path.join(input, 'concept-nodes.jsonl'))) {
        db.prepare('INSERT OR IGNORE INTO concept_nodes (id, concept_type, content, pattern_id) VALUES (?, ?, ?, ?)').run(c.id, c.concept_type, c.content, remap(c.pattern_id));
      }
      for (const e of readJsonl(path.join(input, 'captured-experiences.jsonl'))) {
        const r = db.prepare('INSERT OR IGNORE INTO captured_experiences (id, task, agent) VALUES (?, ?, ?)').run(e.id, e.task, e.agent);
        if (r.changes) imported += 1; else skipped += 1;
      }
      for (const w of readJsonl(path.join(input, 'witness-chain.jsonl'))) {
        db.prepare('INSERT INTO witness_chain (prev_hash, action_hash, action_type, timestamp, actor) VALUES (?, ?, ?, ?, ?)')
          .run(w.prev_hash, w.action_hash, w.action_type, w.timestamp, w.actor);
        imported += 1;
      }
      db.exec(dry ? 'ROLLBACK' : 'COMMIT');
      db.close();
      return { code: 0, stdout: `Import complete.\n  Imported:  ${imported}\n  Skipped:   ${skipped}\n  Conflicts: ${skipped}\n`, stderr: '' };
    }
    if (args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected aqe call ${args.join(' ')}` };
  };
  return { runner, calls };
}

export const count = (file, table) => withDb(file, (db) => (tables(db).has(table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) : 0)).value;

/** Root with patterns A,B and experience e1; strays docs (B,C, e2, 3 witness rows),
 *  .agentic-qe/.agentic-qe (C,D, no experience table yet), and an empty docker/.agentic-qe. */
export function project(t) {
  const base = tempDir('ak-aqe-merge', t);
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  buildStore(path.join(root, '.agentic-qe'), { patterns: ['A', 'B'], experiences: ['e1'], witness: 2 });
  buildStore(path.join(root, 'docs', '.agentic-qe'), { patterns: ['B', 'C'], experiences: ['e2'], witness: 3 });
  buildStore(path.join(root, '.agentic-qe', '.agentic-qe'), { patterns: ['C', 'D'], experiences: null, witness: 1 });
  fs.mkdirSync(path.join(root, 'docker', '.agentic-qe'), { recursive: true });
  const mergeDir = path.join(base, 'state', 'agentic-kit', 'aqe-store-merge');
  return { base, root, mergeDir, rootDb: path.join(root, '.agentic-qe', 'memory.db') };
}

/** Every file under `dir` with size and mtime, for "nothing changed" checks. */
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else { const st = fs.statSync(full); out[path.relative(dir, full)] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
}

export const noHolders = async () => ({ holders: [], method: 'lsof', complete: true });
export const sequence = (...results) => { let i = 0; return async () => results[Math.min(i++, results.length - 1)]; };
export const held = { holders: [{ pid: 4242, command: 'npm exec agentic-qe mcp', files: [] }], method: 'lsof', complete: true };
export const base = (p, extra = {}) => ({ mergeDir: p.mergeDir, now: Date.UTC(2026, 8, 27, 12, 0, 0), aqeVersion: '3.14.4', platform: 'darwin', ...extra });

// Review M2: a store written between the preview copy and the move must not lose rows.
/** Wrap a fake runner: run `hook(call)` before the call it names. */
export const hooked = (inner, when, hook) => async (cmd, args, opts) => {
  if (when(args, opts)) { hook(); when = () => false; }
  return inner(cmd, args, opts);
};
export const realImport = (p) => (args) => args[1] === 'import' && args.includes(p.rootDb) && !args.includes('--dry-run');
export const lastRehearsalImport = (p) => { let n = 0; return (args) => args[1] === 'import' && !args.includes(p.rootDb) && !args.includes('--dry-run') && ++n === 2; };
export const writeTo = (file) => () => {
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO captured_experiences (id, task, agent) VALUES (?, ?, ?)').run(`late-${Math.random()}`, 'task', 'agent');
  db.close();
};

/** project() plus AQE starter patterns S1, S2 in the strays (the root has none of
 *  them, like the real root), rows that hard-reference S1 in docs (an embedding,
 *  a usage row, a null-result row), and the project's embedder endpoint. */
export function projectWithSeeds(t, { embedder = 'settings' } = {}) {
  const p = project(t);
  const add = (dir, names) => {
    const db = new DatabaseSync(path.join(p.root, dir, 'memory.db'));
    for (const name of names) {
      db.prepare('INSERT INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)').run(`${dir}-${name}`, 'workflow', 'test-generation', 'test', name);
    }
    return db;
  };
  const docs = add('docs/.agentic-qe', ['S1', 'S2']);
  docs.prepare('INSERT INTO qe_pattern_embeddings (pattern_id, embedding, dimension) VALUES (?, ?, ?)').run('docs/.agentic-qe-S1', Buffer.alloc(4), 1);
  docs.prepare('INSERT INTO qe_pattern_usage (pattern_id, success) VALUES (?, ?)').run('docs/.agentic-qe-S1', 1);
  docs.prepare('INSERT INTO qe_pattern_nulls (id, pattern_id, context_fingerprint, failure_mode) VALUES (?, ?, ?, ?)').run('n1', 'docs/.agentic-qe-S1', 'fp', 'none');
  docs.close();
  add('.agentic-qe/.agentic-qe', ['S1']).close();
  if (embedder === 'settings') {
    fs.mkdirSync(path.join(p.root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(p.root, '.claude', 'settings.local.json'), JSON.stringify({ env: { AQE_EMBEDDER_ENDPOINT: 'http://embed.test', OTHER: 'x' } }));
  } else if (embedder === 'mcp') {
    fs.writeFileSync(path.join(p.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'agentic-qe': { command: 'aqe-mcp', env: { AQE_EMBEDDER_ENDPOINT: 'http://mcp-embed.test' } } } }));
  }
  return p;
}

export const names = (file) => withDb(file, (db) => db.prepare('SELECT name FROM qe_patterns ORDER BY name').all().map((r) => r.name)).value;
