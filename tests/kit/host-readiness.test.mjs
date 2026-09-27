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

test('explicit setup failure outranks missing evidence on a managed host', () => {
  const result = summarizeHostReadiness({ host: 'claude', enabled: true, setup: { installation: { state: 'fail', reason: 'Install host' } } });
  assert.equal(result.status, 'attention');
  assert.deepEqual(result.management, { state: 'managed', label: 'Managed by ak' });
  assert.deepEqual(result.participation, { participating: true, hint: null });
});

// ADR-0053 amendment (2026-09-26): "not routed by ak" is a management fact, not
// a health verdict. A found host is checked like any other; its tool problems
// are information and never raise Attention, and ak's own wiring check is FYI.
test('a found, unmanaged host reports its tool checks without warning', () => {
  const hint = 'ak host pick --host claude,codex';
  const ok = summarizeHostReadiness({ host: 'codex', enabled: false, setup: { ...setup(), presence: 'found' }, hint });
  assert.equal(ok.status, 'unmanaged');
  assert.equal(ok.label, 'Found, not managed');
  assert.deepEqual(ok.management, { state: 'found', label: 'Found, not managed' });
  assert.equal(ok.localStatus, 'ok');
  assert.deepEqual(Object.keys(ok.checks).sort(), ['authentication', 'configuration', 'installation', 'integration', 'model']);
  assert.equal(ok.checks.integration.fyi, true, 'ak was never asked to wire this host');
  assert.equal(ok.canCheckConnection, false, 'the paid connection check stays managed-only');
  assert.deepEqual(ok.participation, { participating: false, hint });

  const broken = summarizeHostReadiness({ host: 'codex', enabled: false, hint,
    setup: { ...setup(), presence: 'found', authentication: { state: 'fail', reason: 'Signed out' } },
    findings: [{ host: 'codex', code: 'retired-codex-mcp' }] });
  assert.equal(broken.status, 'unmanaged', 'unmanaged-host problems are information, never Attention');
  assert.equal(broken.localStatus, 'attention', 'the tool problem is still reported');
  assert.equal(broken.checks.integration.state, 'fail');
  const wiringOnly = summarizeHostReadiness({ host: 'codex', enabled: false, hint,
    setup: { ...setup(), presence: 'found' }, findings: [{ host: 'codex', code: 'retired-codex-mcp' }] });
  assert.equal(wiringOnly.localStatus, 'ok', 'an FYI wiring finding does not decide tool health');
});

test('an absent unmanaged host reads Not installed; unestablished presence claims neither', () => {
  const absent = summarizeHostReadiness({ host: 'opencode', enabled: false,
    setup: { installation: { state: 'fail', reason: 'The host executable is not available on PATH.' }, presence: 'absent' } });
  assert.equal(absent.status, 'not-installed');
  assert.equal(absent.label, 'Not installed');
  assert.equal(absent.management.state, 'not-installed');
  const unassessed = summarizeHostReadiness({ host: 'opencode', enabled: false, setup: {} });
  assert.equal(unassessed.status, 'unmanaged');
  assert.deepEqual(unassessed.management, { state: 'unassessed', label: 'Not managed' });
});

test('reader checks every host, managed or not, and isolates failures without preserving green', async () => {
  let now = 1000, calls = 0, failed = false;
  const read = createHostReadinessReader({ cwd: '/project', now: () => now, cacheMs: 100,
    loadConfig: () => ({ integrations: { hosts: { claude: true, codex: true, opencode: false } } }),
    inspectAlignment: () => ({ findings: [] }),
    snapshot: () => ({ key: 'source', complete: true }), probe: async ({ host, cwd }) => { calls++; assert.equal(cwd, '/project'); if (failed && host === 'codex') throw Error('SECRET'); return { ...setup(), presence: 'found' }; },
  });
  const [first, same] = await Promise.all([read(), read()]);
  assert.deepEqual(same, first);
  assert.equal(calls, 3, 'found hosts are checked automatically, not only managed ones');
  assert.equal(first.hosts.opencode.status, 'unmanaged');
  assert.equal(first.hosts.opencode.localStatus, 'ok');
  assert.equal(first.hosts.opencode.canCheckConnection, false);
  assert.match(first.hosts.opencode.connectionUnavailable, /managed by ak/);
  assert.equal(first.hosts.opencode.participation.hint, 'ak host pick --host claude,codex,opencode');
  assert.equal(first.hosts.codex.participation.participating, true);
  now += 101; failed = true;
  const next = await read();
  assert.equal(next.hosts.codex.status, 'unknown');
  assert.equal(next.hosts.claude.status, 'ok');
  assert.ok(!JSON.stringify(next).includes('SECRET'));
});

test('configuration changes invalidate cache immediately and move a host out of management', async () => {
  let enabled = true, calls = 0;
  const read = createHostReadinessReader({ cwd: '/project',
    loadConfig: () => ({ integrations: { hosts: { codex: enabled } } }),
    inspectAlignment: () => ({ findings: [] }), snapshot: () => ({ key: 'source', complete: true }), probe: async () => { calls++; return { ...setup(), presence: 'found' }; },
  });
  await read(); enabled = false;
  const after = await read();
  assert.equal(after.hosts.codex.status, 'unmanaged');
  assert.equal(after.hosts.codex.participation.hint, 'ak host pick --host codex');
  assert.equal(calls, 6, 'the changed configuration re-ran every host check instead of reusing the cache');
});

test('a connection check is refused for a host ak does not manage', async () => {
  let calls = 0;
  const read = createHostReadinessReader({ cwd: '/project',
    loadConfig: () => ({ integrations: { hosts: { claude: true, codex: false } } }),
    inspectAlignment: () => ({ findings: [] }), snapshot: () => ({ key: 'source', complete: true }),
    probe: async () => ({ ...setup(), presence: 'found' }), connectionProbe: async () => { calls++; return { state: 'pass', reason: 'Provider responded' }; },
  });
  const initial = await read();
  await assert.rejects(read.checkConnection({ host: 'codex', confirm: true, evidenceKey: initial.hosts.codex.evidenceKey }), /prerequisites/);
  assert.equal(calls, 0);
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
