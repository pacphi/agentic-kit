import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import section from '../../src/commands/status/sections/project-memory.mjs';

test('memory status never treats file presence as a proven writer and checks both stores', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-status-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal((await section.collect({ cwd }))[0].level, 'info');
  fs.mkdirSync(path.join(cwd, '.swarm'));
  const native = path.join(cwd, '.swarm/agentdb-memory.db');
  const db = new DatabaseSync(native);
  db.exec('CREATE TABLE memory_entries (status TEXT); INSERT INTO memory_entries VALUES (NULL)');
  db.close();
  const single = await section.collect({ cwd });
  assert.equal(single[0].level, 'info');
  assert.match(single[0].message, /agentdb-memory\.db: 1 active entry observed.*backend.*routing unverified/);
  assert.doesNotMatch(single[0].message, /native-agentdb:/);
  fs.writeFileSync(path.join(cwd, '.swarm/memory.db'), 'corrupt');
  const dual = await section.collect({ cwd });
  assert.ok(dual.some((r) => r.level === 'warn' && /memory\.db store is unreadable/.test(r.message)));
  assert.ok(dual.some((r) => /two project memory stores/.test(r.message)));
  assert.ok(dual.some((r) => /--path/.test(r.message)));
  assert.ok(dual.some((r) => /preserve both/.test(r.message)));
  assert.ok(dual.every((r) => r.level !== 'ok' && r.fix === null));
});
