// Starter-pattern filtering and CLI contracts for AQE stray-store merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './helpers/temp-dir.mjs';
import { withDb } from '../../src/lib/sqlite.mjs';
import { mergeAqeStores } from '../../src/lib/aqe-store-merge.mjs';
import { fakeAqe, project, projectWithSeeds, noHolders, base, count, names,
  RELATIONSHIPS_DDL } from './helpers/aqe-store-merge-harness.mjs';

test('AQE starter patterns: the set comes from a fresh store in scratch, built with the project\'s embedder', async (t) => {
  const p = projectWithSeeds(t);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: false, runner, holders: noHolders }));
  assert.equal(result.status, 'preview');
  assert.equal(result.refusal, null);
  assert.deepEqual(result.seeds, { patterns: 2, source: '.claude/settings.local.json' });
  const build = calls.filter((c) => c.args[0] !== 'brain');
  assert.deepEqual(build.map((c) => c.args), [['init', '--auto', '--minimal'], ['learning', 'stats', '--json']]);
  const seedDir = path.join(p.mergeDir, result.runId, 'scratch', 'seed');
  for (const c of build) {
    assert.equal(c.cwd, seedDir);
    assert.equal(c.env.AQE_PROJECT_ROOT, seedDir);
    assert.equal(c.env.AQE_MEMORY_PATH, path.join(seedDir, '.agentic-qe', 'memory.db'));
    assert.equal(c.env.AQE_STORAGE_PATH, path.join(seedDir, '.agentic-qe'));
    assert.ok(c.env.npm_config_prefix.startsWith(seedDir + path.sep), 'never the user\'s global npm prefix');
    assert.equal(c.env.AQE_EMBEDDER_ENDPOINT, 'http://embed.test');
    assert.equal(c.env.OTHER, undefined, 'only the embedder keys are taken from the project');
  }
  assert.equal(fs.existsSync(path.join(p.mergeDir, result.runId)), false, 'the preview removes the fresh store with its scratch');
});

test('AQE starter patterns: the embedder falls back to the project .mcp.json registration', async (t) => {
  const p = projectWithSeeds(t, { embedder: 'mcp' });
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: false, runner, holders: noHolders }));
  assert.equal(result.seeds.source, '.mcp.json');
  assert.ok(calls.filter((c) => c.args[0] === 'init').every((c) => c.env.AQE_EMBEDDER_ENDPOINT === 'http://mcp-embed.test'));
});

test('AQE starter patterns are counted per stray and left out of the expected root', async (t) => {
  const p = projectWithSeeds(t);
  const result = await mergeAqeStores(p.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders }));
  const docs = result.strays.find((s) => s.path === 'docs/.agentic-qe');
  const nested = result.strays.find((s) => s.path === '.agentic-qe/.agentic-qe');
  // Strays are read in path order: .agentic-qe/.agentic-qe brings C and D first.
  assert.deepEqual([nested.patterns, nested.seedPatterns, nested.newPatterns], [3, 1, 2]);
  assert.deepEqual([docs.patterns, docs.seedPatterns, docs.newPatterns], [4, 2, 0]);
  assert.deepEqual(result.expected, { patterns: 4, experiences: 2 }, 'A, B, C, D: no starter pattern');
});

test('--yes leaves AQE starter patterns and their rows out of the root; the archive keeps them', async (t) => {
  const p = projectWithSeeds(t);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.deepEqual(names(p.rootDb), ['A', 'B', 'C', 'D']);
  assert.equal(count(p.rootDb, 'qe_pattern_nulls'), 0);
  const runDir = path.join(p.mergeDir, result.runId);
  assert.deepEqual(names(path.join(runDir, 'archive', 'docs', '.agentic-qe', 'memory.db')), ['B', 'C', 'S1', 'S2'], 'the archived stray is whole');
  assert.equal(count(path.join(runDir, 'archive', 'docs', '.agentic-qe', 'memory.db'), 'qe_pattern_nulls'), 1);
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  assert.deepEqual(receipt.seedSet, { patterns: 2, source: '.claude/settings.local.json' });
  assert.deepEqual(receipt.strays.map((s) => [s.path, s.seedPatternsSkipped]), [['.agentic-qe/.agentic-qe', 1], ['docs/.agentic-qe', 2]]);
});

test('starter patterns the root already holds are imported for AQE to skip, so their usage reaches the root (review minor 4/5)', async (t) => {
  const p = projectWithSeeds(t);
  const root = new DatabaseSync(p.rootDb);
  root.prepare('INSERT INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)').run('proj-S1', 'workflow', 'test-generation', 'test', 'S1');
  root.close();
  const docs = new DatabaseSync(path.join(p.root, 'docs', '.agentic-qe', 'memory.db'));
  docs.prepare('INSERT INTO qe_pattern_usage (pattern_id, success, created_at) VALUES (?, ?, ?)').run('docs/.agentic-qe-S2', 0, '2026-09-20');
  docs.exec(RELATIONSHIPS_DDL);
  const rel = docs.prepare('INSERT INTO pattern_relationships (id, source_pattern_id, target_pattern_id, relationship_type) VALUES (?, ?, ?, ?)');
  rel.run('r-to-s1', 'docs-C', 'docs/.agentic-qe-S1', 'similar');
  rel.run('r-to-s2', 'docs-C', 'docs/.agentic-qe-S2', 'similar');
  const node = docs.prepare('INSERT INTO concept_nodes (id, concept_type, content, pattern_id) VALUES (?, ?, ?, ?)');
  node.run('n-s1', 'pattern', 'x', 'docs/.agentic-qe-S1');
  node.run('n-s2', 'pattern', 'y', 'docs/.agentic-qe-S2');
  docs.close();
  const preview = await mergeAqeStores(p.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders }));
  const row = preview.strays.find((s) => s.path === 'docs/.agentic-qe');
  assert.deepEqual([row.seedPatterns, row.seedPatternsInRoot], [1, 1], 'S2 left out; S1 already in the root');
  assert.deepEqual(preview.expected, { patterns: 5, experiences: 2 });
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders, now: Date.UTC(2026, 8, 27, 17) }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.deepEqual(names(p.rootDb), ['A', 'B', 'C', 'D', 'S1']);
  const got = withDb(p.rootDb, (db) => ({
    usage: db.prepare('SELECT pattern_id FROM qe_pattern_usage ORDER BY pattern_id').all().map((r) => r.pattern_id),
    rels: db.prepare('SELECT id, target_pattern_id FROM pattern_relationships ORDER BY id').all().map((r) => [r.id, r.target_pattern_id]),
    nodes: db.prepare('SELECT id, pattern_id FROM concept_nodes ORDER BY id').all().map((r) => [r.id, r.pattern_id]),
  })).value;
  assert.deepEqual(got.usage, ['proj-S1'], 'the usage of a seed the root holds follows onto the root\'s pattern; S2\'s is left out');
  assert.deepEqual(got.rels, [['r-to-s1', 'proj-S1']], 'a relationship whose target is a left-out seed is left out');
  assert.deepEqual(got.nodes, [['n-s1', 'proj-S1'], ['n-s2', null]], 'a nullable reference to a left-out seed is cleared');
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  const docsReceipt = receipt.strays.find((s) => s.path === 'docs/.agentic-qe');
  assert.deepEqual([docsReceipt.seedPatternsSkipped, docsReceipt.seedPatternsInRoot], [1, 1]);
});

test('no starter set (an empty fresh store) refuses the merge before any backup, and the preview says why', async (t) => {
  const p = projectWithSeeds(t);
  const empty = fakeAqe({ seeds: [] });
  const preview = await mergeAqeStores(p.root, base(p, { apply: false, runner: empty.runner, holders: noHolders }));
  assert.match(preview.refusal, /starter pattern/);
  assert.match(preview.refusal, /no starter patterns/);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: empty.runner, holders: noHolders, now: Date.UTC(2026, 8, 27, 15) }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /starter pattern/);
  assert.equal(result.backup, null);
  assert.equal(empty.calls.filter((c) => c.args[0] === 'brain').length, 0);
  assert.equal(fs.existsSync(path.join(p.mergeDir, result.runId)), false);
});

test('a failed fresh-store build refuses the merge and names the failure', async (t) => {
  const p = projectWithSeeds(t);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe({ initCode: 1 }).runner, holders: noHolders }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /aqe init/);
  assert.match(result.reason, /init exploded/);
});

// ---- the command ----------------------------------------------------------

const cli = await import('../../src/commands/x/aqe-store.mjs');

async function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { return { code: await fn(), out: lines.join('\n') }; } finally { console.log = original; }
}

test('ak x aqe-store: help has usage, the merge sequence, the archive and Examples', () => {
  assert.match(cli.help, /^ak x aqe-store — /);
  for (const needle of [/status/, /merge/, /--yes/, /--dry-run/, /--json/, /aqe-store-merge/, /Examples:/, /no --force/i]) assert.match(cli.help, needle);
});

test('ak x aqe-store merge is a dry run unless --yes; --dry-run wins over --yes', async (t) => {
  const p = project(t);
  const seen = [];
  const merge = async (root, options) => { seen.push([root, options.apply]); return { status: 'preview', root, strays: [], skipped: [], expected: null, holders: null }; };
  await capture(() => cli.run({ flags: {}, positionals: ['merge'], cwd: path.join(p.root, 'docs'), merge }));
  await capture(() => cli.run({ flags: { yes: true }, positionals: ['merge'], cwd: p.root, merge }));
  await capture(() => cli.run({ flags: { yes: true, 'dry-run': true }, positionals: ['merge'], cwd: p.root, merge }));
  await capture(() => cli.run({ flags: { yes: true }, positionals: ['status'], cwd: p.root, merge }));
  assert.deepEqual(seen, [[p.root, false], [p.root, true], [p.root, false], [p.root, false]]);
});

test('ak x aqe-store --json prints exactly one object; a refusal exits 1', async (t) => {
  const p = project(t);
  const merge = async (root) => ({ status: 'refused', reason: 'PID 1 holds it', root, strays: [], skipped: [], expected: null, holders: null });
  const { code, out } = await capture(() => cli.run({ flags: { json: true, yes: true }, positionals: ['merge'], cwd: p.root, merge }));
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).status, 'refused');
});

test('ak x aqe-store status prints the preview for a real fixture project', async (t) => {
  const p = project(t);
  const merge = (root, options) => mergeAqeStores(root, { ...options, ...base(p, { apply: false }), runner: fakeAqe().runner, holders: noHolders });
  const { code, out } = await capture(() => cli.run({ flags: {}, positionals: ['status'], cwd: p.root, merge }));
  assert.equal(code, 0);
  assert.match(out, /docs\/\.agentic-qe: 2 patterns \(1 already in the root\), 1 experience/);
  assert.match(out, /0 already in the root, skipped/);
  assert.match(out, /after the merge the root would hold 4 patterns and 2 experiences/);
  assert.match(out, /docker\/\.agentic-qe: skipped \(no memory\.db\)/);
  assert.match(out, /AQE starter set: 2 patterns/);
  assert.match(out, /ak x aqe-store merge --yes/);
});

test('outside a repository the command says so and exits 1', async (t) => {
  const dir = tempDir('ak-aqe-store-norepo', t);
  const { code, out } = await capture(() => cli.run({ flags: {}, positionals: ['status'], cwd: dir, merge: async () => { throw new Error('not called'); } }));
  assert.equal(code, 1);
  assert.match(out, /not inside a repository/);
});

test('status reports an interrupted merge until a later merge completes (review minor 8)', async (t) => {
  const p = project(t);
  const old = path.join(p.mergeDir, '2026-09-26T10-00-00-000Z');
  fs.mkdirSync(path.join(old, 'backup'), { recursive: true });
  fs.writeFileSync(path.join(old, 'backup', 'root-memory.db'), 'x');
  fs.writeFileSync(path.join(old, 'receipt.json'), JSON.stringify({ root: p.root, runId: '2026-09-26T10-00-00-000Z', status: 'applying', backup: path.join(old, 'backup', 'root-memory.db') }));
  const merge = (root, options) => mergeAqeStores(root, { ...options, ...base(p, { apply: false }), runner: fakeAqe().runner, holders: noHolders });
  const { out } = await capture(() => cli.run({ flags: {}, positionals: ['status'], cwd: p.root, merge }));
  assert.match(out, /interrupted/);
  assert.match(out, /2026-09-26T10-00-00-000Z/);
  assert.match(out, /root-memory\.db/);
  const other = project(t);
  const elsewhere = await mergeAqeStores(other.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders }));
  assert.deepEqual(elsewhere.interrupted, [], 'another project\'s receipt is not this project\'s');
  const merged = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders }));
  assert.equal(merged.status, 'merged', JSON.stringify(merged.reason));
  const resolved = JSON.parse(fs.readFileSync(path.join(old, 'receipt.json'), 'utf8'));
  assert.equal(resolved.status, 'interrupted');
  assert.equal(resolved.resolvedBy, merged.runId);
  const after = await mergeAqeStores(p.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders, now: Date.UTC(2026, 8, 28) }));
  assert.deepEqual(after.interrupted, []);
  // A receipt that recorded no backup never prints "null" as a path.
  const bare = path.join(p.mergeDir, '2026-09-26T11-00-00-000Z');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, 'receipt.json'), JSON.stringify({ root: p.root, runId: '2026-09-26T11-00-00-000Z', status: 'applying' }));
  const { out: noBackup } = await capture(() => cli.run({ flags: {}, positionals: ['status'], cwd: p.root, merge }));
  assert.match(noBackup, /2026-09-26T11-00-00-000Z/);
  assert.doesNotMatch(noBackup, /null/);
  assert.match(noBackup, /no backup was recorded/);
});
