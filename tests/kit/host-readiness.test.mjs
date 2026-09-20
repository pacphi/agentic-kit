import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHostReadiness, createHostReadinessReader } from '../../src/lib/host-readiness.mjs';

const pass = { state: 'pass', reason: 'Checked' };
const setup = () => ({ installation: { ...pass, version: '1.2.3' }, configuration: pass, authentication: pass, model: pass });

test('configured requires positive installation, configuration and authentication evidence', () => {
  assert.equal(summarizeHostReadiness({ host: 'codex', enabled: true, setup: setup() }).status, 'ok');
  for (const key of ['installation', 'configuration', 'authentication', 'model']) {
    const partial = setup(); partial[key] = { state: 'unknown', reason: 'Not assessed' };
    assert.equal(summarizeHostReadiness({ host: 'codex', enabled: true, setup: partial }).status, 'unknown');
  }
});

test('usage diagnostics and historical responses cannot lower readiness or prove execution', () => {
  const result = summarizeHostReadiness({ host: 'codex', enabled: true, setup: setup(), sourceHealth: { status: 'degraded' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.connection.state, 'not-run');
});

test('known blockers are actionable, unsupported configuration is unassessed', () => {
  for (const code of ['retired-codex-mcp', 'misplaced-claude-companion']) {
    assert.equal(summarizeHostReadiness({ host: 'codex', enabled: true, setup: setup(), findings: [{ host: 'codex', code }] }).status, 'attention');
  }
  assert.equal(summarizeHostReadiness({ host: 'codex', enabled: true, setup: setup(), findings: [{ host: 'codex', code: 'config-unassessed' }] }).status, 'unknown');
  assert.equal(summarizeHostReadiness({ host: 'claude', enabled: true, setup: setup(), findings: [{ host: 'codex', code: 'retired-codex-mcp' }] }).status, 'ok');
});

test('explicit setup failure outranks missing evidence; disabled hosts are neutral', () => {
  assert.equal(summarizeHostReadiness({ host: 'claude', enabled: true, setup: { installation: { state: 'fail', reason: 'Install host' } } }).status, 'attention');
  assert.equal(summarizeHostReadiness({ host: 'claude', enabled: false, setup: setup() }).status, 'disabled');
});

test('reader skips disabled hosts, isolates failures, and expires observations without preserving green', async () => {
  let now = 1000, calls = 0, failed = false;
  const read = createHostReadinessReader({ cwd: '/project', now: () => now, cacheMs: 100,
    loadConfig: () => ({ integrations: { hosts: { claude: true, codex: true, opencode: false } } }),
    inspectAlignment: () => ({ findings: [] }),
    snapshot: () => ({ key: 'source', complete: true }), probe: async ({ host, cwd }) => { calls++; assert.equal(cwd, '/project'); if (failed && host === 'codex') throw Error('SECRET'); return setup(); },
  });
  const [first, same] = await Promise.all([read(), read()]);
  assert.deepEqual(same, first);
  assert.equal(calls, 2);
  assert.equal(first.hosts.opencode.status, 'disabled');
  now += 101; failed = true;
  const next = await read();
  assert.equal(next.hosts.codex.status, 'unknown');
  assert.equal(next.hosts.claude.status, 'ok');
  assert.ok(!JSON.stringify(next).includes('SECRET'));
});

test('configuration changes invalidate cache immediately', async () => {
  let enabled = true, calls = 0;
  const read = createHostReadinessReader({ cwd: '/project',
    loadConfig: () => ({ integrations: { hosts: { codex: enabled } } }),
    inspectAlignment: () => ({ findings: [] }), snapshot: () => ({ key: 'source', complete: true }), probe: async () => { calls++; return setup(); },
  });
  await read(); enabled = false;
  assert.equal((await read()).hosts.codex.status, 'disabled');
  assert.equal(calls, 1);
});

test('connected checks require deliberate confirmation and the exact fresh local evidence', async () => {
  let calls = 0;
  const read = createHostReadinessReader({ cwd: '/project',
    loadConfig: () => ({ integrations: { hosts: { codex: true } } }),
    inspectAlignment: () => ({ findings: [] }), snapshot: () => ({ key: 'source', complete: true }),
    probe: async () => setup(), connectionProbe: async () => { calls++; return { state: 'pass', reason: 'Provider responded' }; },
  });
  const initial = await read();
  assert.equal(calls, 0);
  await assert.rejects(read.checkConnection({ host: 'codex', evidenceKey: initial.hosts.codex.evidenceKey }), /confirmation/);
  await assert.rejects(read.checkConnection({ host: 'codex', confirm: true, evidenceKey: 'stale' }), /stale/);
  const checked = await read.checkConnection({ host: 'codex', confirm: true, evidenceKey: initial.hosts.codex.evidenceKey });
  assert.equal(calls, 1);
  assert.equal(checked.hosts.codex.status, 'ok');
  assert.equal(checked.hosts.codex.level, 'connected');
  assert.equal(checked.hosts.codex.connection.state, 'pass');
});

test('source changes and expiration invalidate connection results without claiming the host broke', async () => {
  let source = 'one', now = 1000;
  const read = createHostReadinessReader({ cwd: '/project', now: () => now, connectionMaxAgeMs: 100,
    loadConfig: () => ({ integrations: { hosts: { codex: true } } }), inspectAlignment: () => ({ findings: [] }),
    snapshot: () => ({ key: source, complete: true }), probe: async () => setup(),
    connectionProbe: async () => ({ state: 'pass', reason: 'Provider responded' }),
  });
  const initial = await read();
  await read.checkConnection({ host: 'codex', confirm: true, evidenceKey: initial.hosts.codex.evidenceKey });
  now += 101;
  const expired = await read();
  assert.equal(expired.hosts.codex.level, 'local');
  assert.equal(expired.hosts.codex.connection.state, 'expired');
  source = 'two';
  const changed = await read();
  assert.equal(changed.hosts.codex.level, 'local');
  assert.notEqual(changed.hosts.codex.evidenceKey, initial.hosts.codex.evidenceKey);
});

test('one connection request consumes its evidence and concurrent duplicate requests never spend twice', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const read = createHostReadinessReader({ cwd: '/project',
    loadConfig: () => ({ integrations: { hosts: { codex: true } } }), inspectAlignment: () => ({ findings: [] }),
    snapshot: () => ({ key: 'source', complete: true }), probe: async () => setup(),
    connectionProbe: async () => { calls++; await gate; return { state: 'pass', reason: 'Provider responded' }; },
  });
  const initial = await read();
  const request = { host: 'codex', confirm: true, evidenceKey: initial.hosts.codex.evidenceKey };
  const first = read.checkConnection(request);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(read.checkConnection(request), /running|stale/);
  release();
  await first;
  await assert.rejects(read.checkConnection(request), /stale/);
  assert.equal(calls, 1);
});

test('changes during a connection check discard its success and errors never leak native output', async () => {
  let source = 'one';
  const read = createHostReadinessReader({ cwd: '/project',
    loadConfig: () => ({ integrations: { hosts: { codex: true } } }), inspectAlignment: () => ({ findings: [] }),
    snapshot: () => ({ key: source, complete: true }), probe: async () => setup(),
    connectionProbe: async () => { source = 'two'; return { state: 'pass', reason: 'Provider responded' }; },
  });
  const initial = await read();
  await assert.rejects(read.checkConnection({ host: 'codex', confirm: true, evidenceKey: initial.hosts.codex.evidenceKey }), /changed/);
  assert.equal((await read()).hosts.codex.level, 'local');
});
