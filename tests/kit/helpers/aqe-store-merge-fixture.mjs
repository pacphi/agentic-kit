// AQE 3.14.4 store fixtures for the merge tests. Templates are closed before
// copying, so no test can read another test's WAL or mutate shared database pages.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './temp-dir.mjs';

const SCHEMA = fs.readFileSync(new URL('../../fixtures/aqe-store/schema-3.14.4.sql', import.meta.url), 'utf8');
const SHADOW = /^CREATE TABLE (sqlite_sequence|'qe_patterns_fts_(data|idx|docsize|config)')/;
const STATEMENTS = SCHEMA.split(/;\s*\n(?=CREATE)/).map((s) => s.trim().replace(/;$/, ''))
  .filter((s) => s && !SHADOW.test(s));
export const EXPERIENCE_DDL = STATEMENTS.filter((s) => /captured_experiences/.test(s));

const templateDir = tempDir('ak-aqe-schema-template');
let templates;

function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function schemaTemplates() {
  if (templates) return templates;
  const fresh = path.join(templateDir, 'fresh.db');
  const withExperiences = path.join(templateDir, 'with-experiences.db');
  const db = new DatabaseSync(fresh);
  try {
    inTransaction(db, () => {
      for (const sql of STATEMENTS) if (!/captured_experiences/.test(sql)) db.exec(sql);
    });
  } finally { db.close(); }
  fs.copyFileSync(fresh, withExperiences);
  const extended = new DatabaseSync(withExperiences);
  try { inTransaction(extended, () => { for (const sql of EXPERIENCE_DDL) extended.exec(sql); }); }
  finally { extended.close(); }
  templates = { fresh, withExperiences };
  return templates;
}

/** A private store as AQE 3.14.4 lays it out; null experiences means no table yet. */
export function buildStore(dir, { patterns = [], experiences = [], witness = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const template = schemaTemplates()[experiences === null ? 'fresh' : 'withExperiences'];
  const file = path.join(dir, 'memory.db');
  fs.copyFileSync(template, file);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    inTransaction(db, () => {
      const insertPattern = db.prepare('INSERT INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)');
      for (const name of patterns) insertPattern.run(`${path.basename(path.dirname(dir))}-${name}`, 'workflow', 'test-generation', 'test', name);
      if (experiences !== null) {
        const insertExperience = db.prepare('INSERT INTO captured_experiences (id, task, agent) VALUES (?, ?, ?)');
        for (const id of experiences) insertExperience.run(id, 'task', 'agent');
      }
      const insertWitness = db.prepare('INSERT INTO witness_chain (prev_hash, action_hash, action_type, timestamp, actor) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < witness; i += 1) insertWitness.run(`p${i}`, `a${i}-${dir}`, 'PATTERN_CREATE', new Date(i * 1000).toISOString(), 'aqe');
    });
  } finally { db.close(); }
  fs.writeFileSync(path.join(dir, 'patterns.rvf'), 'rvf');
}
