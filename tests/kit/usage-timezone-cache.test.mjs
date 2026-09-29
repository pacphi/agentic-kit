import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { tempDir } from './helpers/temp-dir.mjs';
import { selectOpencodeSource } from '../../src/lib/usage-opencode-source.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const indexUrl = new URL('../../src/lib/usage-index.mjs', import.meta.url).href;
const zones = ['America/Los_Angeles', 'Asia/Tokyo'];
// Local midnight, spring DST gap, and autumn repeated hour. Also spans a
// synthetic dated price boundary, preserving the existing local-row-day basis.
const stamps = ['2026-03-08T07:59:00Z', '2026-03-08T08:01:00Z',
  '2026-03-08T09:59:00Z', '2026-03-08T10:01:00Z',
  '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z'];
function fixture(t) {
  const dir = tempDir('ak-timezone');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claude = path.join(dir, 'claude', 'project');
  const codex = path.join(dir, 'codex');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(path.join(codex, '2026', '03', '08'), { recursive: true });
  const rows = stamps.map((timestamp, i) => ({ type: 'assistant', timestamp,
    message: { id: `message-${i}`, role: 'assistant', model: 'claude-opus-5',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10 }, content: [] } }));
  fs.writeFileSync(path.join(claude, 'fixture.jsonl'), rows.map(JSON.stringify).join('\n'));
  const cx = [{ type: 'session_meta', timestamp: stamps[0], payload: { id: 'codex-fixture', model_provider: 'openai' } },
    { type: 'turn_context', timestamp: stamps[0], payload: { model: 'gpt-5.6', effort: 'high' } },
    ...stamps.map((timestamp, i) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: (i + 1) * 100, cached_input_tokens: (i + 1) * 50, output_tokens: (i + 1) * 20 },
    } } }))];
  fs.writeFileSync(path.join(codex, '2026', '03', '08', 'rollout-fixture.jsonl'), cx.map(JSON.stringify).join('\n'));
  return dir;
}
function openCodeFixture(dir) {
  const db = new DatabaseSync(path.join(dir, 'broken.db'));
  db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (message_id TEXT, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?)').run('oc-native', '/fixture', 'fixture', Date.parse(stamps[0]), Date.parse(stamps.at(-1)));
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  stamps.forEach((timestamp, i) => {
    const at = Date.parse(timestamp);
    insert.run(`a${i}`, 'oc-native', at, at, JSON.stringify({ role: 'assistant',
      modelID: 'gpt-5.6', providerID: 'openai', cost: 0.25,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } },
      time: { created: at, completed: at + 1000 }, finish: 'stop' }));
  });
  db.close();
}
function run(dir, zone, extra = '', days = 240) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { buildIndex, readIndex } from ${JSON.stringify(indexUrl)};
    const dir = process.argv[1];
    const cachePath = path.join(dir, 'cache.json');
    const options = { roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex'),
      opencode: path.join(dir, 'broken.db') }, cachePath,
      now: Date.parse('2026-11-02T12:00:00Z'), days: ${days}, lookbackDays: 240, previous: true,
      deps: { costOf: (u) => (u.input + u.output + u.cacheRead + u.cacheWrite) / 1000
        * (u.day < '2026-03-08' ? 2 : 1),
        classify: () => ({category:'Build', confidence:1, basis:'fixture'}), detectInsights: () => [] } };
    // Filesystem provenance uses Date.now independently of the query clock.
    Date.now = () => options.now;
    const first = await readIndex(options);
    ${extra}
    const agg = ${extra ? 'await readIndex(options)' : 'first'};
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const {sourceHealth, ...stable} = agg;
    console.log(JSON.stringify({ stable, sourceHealth, entries: Object.values(cache.entries) }));
  `;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], {
    env: spawnEnv(path.join(dir, 'home'), { TZ: zone }), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}
function poisonContext(dir, context) {
  const file = path.join(dir, 'cache.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of Object.values(cache.entries)) {
    if (context === undefined) delete entry.localTimeContext;
    else entry.localTimeContext = context;
    entry.session.usage.forEach((row) => { row.day = '1900-01-01'; });
  }
  fs.writeFileSync(file, JSON.stringify(cache));
}

test('cold and warm indexes agree after timezone changes, including DST and dated pricing', (t) => {
  const dir = fixture(t);
  openCodeFixture(dir);
  const la = run(dir, zones[0]);
  assert.equal(la.stable.sessions.length, 3);
  const warm = run(dir, zones[0]);
  assert.deepEqual(warm.stable, la.stable);
  assert.ok(warm.sourceHealth.codex.diagnostics.cachedFiles > 0);
  const changed = run(dir, zones[1]);
  fs.unlinkSync(path.join(dir, 'cache.json'));
  const cold = run(dir, zones[1]);
  assert.deepEqual(changed.stable, cold.stable);
  assert.deepEqual(changed.entries, cold.entries);
  assert.equal(changed.sourceHealth.codex.diagnostics.cachedFiles, 0);
  assert.notDeepEqual(la.stable.byDay, cold.stable.byDay);
  assert.equal(la.stable.totals.tokens, cold.stable.totals.tokens);
  assert.notEqual(la.stable.totals.cost, cold.stable.totals.cost,
    'existing local day pricing intentionally changes at a dated rate boundary');
  const back = run(dir, zones[0]);
  assert.deepEqual(back.stable, la.stable);
});

for (const context of [undefined, null, 'Invalid/Zone', {}, { zone: 'UTC' }]) {
  test(`missing or invalid cached timezone reparses: ${JSON.stringify(context)}`, (t) => {
    const dir = fixture(t);
    const expected = run(dir, zones[0]);
    poisonContext(dir, context);
    const actual = run(dir, zones[0]);
    assert.deepEqual(actual.stable, expected.stable);
    assert.equal(actual.sourceHealth.codex.diagnostics.cachedFiles, 0);
  });
}

test('in-process memo observes a child-only TZ change', (t) => {
  const dir = fixture(t);
  const changed = run(dir, zones[0], `process.env.TZ = ${JSON.stringify(zones[1])};`);
  fs.unlinkSync(path.join(dir, 'cache.json'));
  assert.deepEqual(changed.stable, run(dir, zones[1]).stable);
});

test('unknown runtime timezone declines persistent cache reuse', (t) => {
  const dir = fixture(t);
  run(dir, 'Invalid/Zone');
  assert.equal(run(dir, 'Invalid/Zone').sourceHealth.codex.diagnostics.cachedFiles, 0);
});

test('degraded OpenCode retains old timezone evidence without contributing stale buckets', (t) => {
  const dir = fixture(t);
  const initial = run(dir, zones[0]);
  const file = path.join(dir, 'cache.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = structuredClone(initial.entries[0]);
  entry.session.id = 'oc-fixture';
  entry.session.host = entry.session.provider = 'opencode';
  entry.parseSemantics = 'cost-trust-v2-observations-v1';
  entry.dbFile = path.join(dir, 'broken.db');
  cache.entries['opencode://oc-fixture'] = entry;
  fs.writeFileSync(entry.dbFile, 'not a database');
  entry.sourceIdentity = selectOpencodeSource({ roots: { opencode: entry.dbFile } }).sourceIdentity;
  fs.writeFileSync(file, JSON.stringify(cache));
  const same = run(dir, zones[0]);
  assert.ok(same.stable.sessions.some((s) => s.id === 'oc-fixture'));
  const changed = run(dir, zones[1]);
  assert.equal(changed.sourceHealth.opencode.status, 'degraded');
  assert.equal(changed.sourceHealth.opencode.timezoneCacheEntriesExcluded, 1);
  assert.ok(!changed.stable.sessions.some((s) => s.id === 'oc-fixture'));
  assert.deepEqual(changed.entries.find((e) => e.session.id === 'oc-fixture').localTimeContext,
    entry.localTimeContext, 'carry forward must not relabel the old evidence');
  assert.ok(run(dir, zones[0]).stable.sessions.some((s) => s.id === 'oc-fixture'));
});

for (const days of [1, 120]) {
  test(`timezone refresh preserves current and previous ${days}-day windows`, (t) => {
    const dir = fixture(t);
    openCodeFixture(dir);
    run(dir, zones[0], '', days);
    const changed = run(dir, zones[1], '', days);
    fs.unlinkSync(path.join(dir, 'cache.json'));
    assert.deepEqual(changed.stable, run(dir, zones[1], '', days).stable);
  });
}

test('unset TZ uses the resolved machine zone and remains incremental', (t) => {
  const dir = fixture(t);
  run(dir, undefined);
  assert.equal(run(dir, undefined).sourceHealth.codex.diagnostics.cachedFiles, 1);
});
