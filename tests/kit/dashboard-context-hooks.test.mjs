import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { JS } from '../../src/lib/dashboard/client.mjs';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';

const PAGE = renderPage({ name: 'agentic-kit', version: 'test' });

function get(url, token) {
  return new Promise((resolve, reject) => {
    const options = token ? { headers: { 'x-dash-token': token } } : {};
    http.get(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('Usage rail exposes navigable views and Transcript only as a current-session indicator', () => {
  const order = [...PAGE.matchAll(/data-view="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(order.slice(0, 8), [
    'score', 'limits', 'findings', 'prompts', 'context', 'hooks', 'models', 'sessions',
  ]);
  assert.doesNotMatch(PAGE, /data-view="transcript"|usage-tab-transcript/);
  assert.match(PAGE, /id="usage-transcript-indicator"[^>]*aria-current="page"[^>]*hidden/);
  assert.match(PAGE, /id="v-transcript"[^>]*role="region"[^>]*aria-labelledby="usage-transcript-indicator"/);
  assert.match(PAGE, /id="usage-tab-score"[^>]*>Score<\/button>/);
  for (const view of ['context', 'hooks']) {
    assert.match(PAGE, new RegExp(`id="usage-tab-${view}"[^>]*aria-controls="v-${view}"`));
    assert.match(PAGE, new RegExp(`id="v-${view}"[^>]*role="tabpanel"[^>]*aria-labelledby="usage-tab-${view}"`));
  }
  assert.match(PAGE, /Runtime-observed transcript snapshots/,
    'Context visibly labels the evidence it can and cannot claim');
  assert.match(PAGE, /Read-only configuration audit/,
    'Hooks visibly labels its read-only evidence boundary');
  assert.match(PAGE, /Hook definitions/);
  assert.match(PAGE, /Runtime outcomes/);
});

test('Context and Hooks ship lazy renderers, explicit unknown meters, and responsive bounded panels', () => {
  assert.match(JS, /function renderContext\(/);
  assert.match(JS, /function loadHooks\(/);
  assert.match(JS, /function renderHooks\(/);
  assert.match(JS, /fetch\("\/api\/hooks\?host=all",\{cache:"no-store",headers:authHeaders\(\)\}\)/,
    'Hooks uses its authenticated lazy endpoint instead of riding the Usage poll');
  assert.match(JS, /role="meter"/);
  assert.match(JS, /aria-valuenow/);
  assert.match(JS, /known\?[^:]+aria-valuenow/,
    'aria-valuenow is conditional so unknown is never announced as zero');
  assert.match(JS, /Not recorded|not-recorded/);
  assert.match(JS, /Partial evidence|partial/);
  assert.match(CSS, /\.ctx-grid/);
  assert.match(CSS, /\.hook-grid/);
  assert.match(CSS, /@media\(max-width:720px\)[^{]*\{[^}]*\.ctx-grid/s);
});

test('Hooks uses semantic tables, visible definitions, and evidence-gated actions', () => {
  for (const heading of ['Lifecycle point', 'Definition', 'Host', 'Configured in', 'Placements', 'Findings']) {
    assert.match(JS, new RegExp(`<th scope="col">${heading}<\\/th>`));
  }
  for (const heading of ['Lifecycle point', 'Host', 'Configured in', 'Evidence', 'Action']) {
    assert.match(JS, new RegExp(`<th scope="col">${heading}<\\/th>`));
  }
  assert.match(JS, /<details class="hook-finding-group"/);
  assert.match(JS, /<span>Importance<\/span><span>Finding<\/span><span>Affected definitions<\/span>/);
  assert.match(JS, /data-hook-importance="all"[^>]*aria-pressed="true"/);
  assert.match(JS, /role="status" aria-live="polite"/);
  assert.match(PAGE, /What is configured/);
  assert.match(PAGE, /Hook definitions/);
  assert.match(PAGE, /Findings needing attention/);
  assert.doesNotMatch(PAGE, /<h2>Evidence limits<\/h2>/,
    'generic evidence limits belong beside the affected measurement, not in a filler panel');
  assert.match(JS, /Preview repair/);
  assert.match(JS, /var action=placement\.action/,
    'actions remain joined to exact affected placements, never promoted to an entire finding');
  assert.doesNotMatch(JS, /host\|\|"unknown"\)\+' × '/,
    'host × count is not meaningful occurrence language');
  assert.match(CSS, /\.hook-table-wrap[^}]*overflow-x:auto/);
  assert.match(CSS, /\.hook-definition-wrap\{[^}]*max-height:256px;[^}]*overflow:auto/);
  assert.match(CSS, /\.hook-definition-wrap \.hook-table thead th\{[^}]*position:sticky/);
  assert.match(JS, /error\.code==="HOOK_SOURCE_NOT_FOUND"/);
  assert.match(JS, /loadHooks\(true\).*requestHookSource\(ref\)/s,
    'an expired source reference gets one evidence refresh and retry');
});

test('Context attention uses grouped semantic tables, actionable policy labels, and direct session links', () => {
  assert.match(PAGE, /<h2 id="u-ctx-attention-title">Sessions needing attention<\/h2>/);
  assert.match(PAGE, /id="u-ctx-attention"[^>]*role="region"[^>]*aria-labelledby="u-ctx-attention-title"[^>]*tabindex="0"/);
  assert.match(JS, /<details class="ctx-att-group"/);
  assert.match(JS, /<summary/);
  assert.match(JS, /chev ctx-att-chevron" aria-hidden="true">&rsaquo;/);
  for (const heading of [
    'Conversation', 'Session', 'Host', 'Recommended action', 'Peak pressure', 'Peak input', 'Context window', 'Started',
  ]) assert.match(JS, new RegExp(`<th scope="col">${heading}<\\/th>`));
  assert.match(JS, /href="#usage\//);
  assert.match(JS, /encodeURIComponent\(id\)/);
  assert.match(JS, /Start a new session/);
  assert.doesNotMatch(JS, /ctx-att-state[^\n]+esc\(row\.state/,
    'raw policy codes such as handoff are not presented as events that happened');
  assert.match(CSS, /\.ctx-att-group summary:focus-visible/);
  assert.match(CSS, /\.ctx-att-group\[open\]>summary \.ctx-att-chevron[^}]*rotate\(90deg\)/);
  assert.match(CSS, /\.ctx-att-table-wrap[^}]*overflow-x:auto/);
  assert.match(JS, /class="ctx-att-table-wrap" role="region" tabindex="0" aria-label="Sessions needing attention for project/);
  assert.match(JS, /row\.projectKey/);
  assert.doesNotMatch(JS, /sessions? shown|highest\.toFixed/);
});

test('/api/hooks is authenticated, lazy, sanitized, cached, single-flight, and host-bounded', async () => {
  let calls = 0;
  const secret = '/Users/private/project/.claude/settings.json::TOKEN=secret';
  const hooks = async ({ host }) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      audit: {
        reports: {
          codex: {
            summary: { hookOccurrences: 2, uniqueBehaviors: 1, configurationIssues: 1 },
            records: [{
              event: 'Stop', sourcePath: secret, command: secret,
              diagnostics: [{
                code: 'AQE_STOP_UNSUPPORTED_FLAG', severity: 'warning', category: 'upstream',
                message: secret,
              }],
            }],
            plan: [{ classification: 'upstream-required', target: 'agentic-qe', reason: secret }],
          },
        },
      },
      receipts: [{
        hostId: 'codex', verb: 'Stop', outcome: 'nonzero-exit', durationMs: 42,
        command: secret, stderr: secret, stdout: secret,
      }],
      host,
    };
  };
  const context = {
    schemaVersion: 1,
    policy: { startupTargetBps: 500, dynamicHandoffBps: 7500, reserveBps: 2500 },
    summary: { coverage: { sessions: 1, state: 'observed' } },
    byHost: {}, attention: [],
  };
  const usage = {
    readIndex: async () => ({ context, sessions: [], projectTree: [], totals: {} }),
    readProviderAnalytics: async () => ({ openrouter: null }),
  };
  const server = await startDashboard({
    port: 0, fetchStatus: async () => ({ rows: [] }), hooks, usage,
  });
  try {
    const denied = await get(`${server.url}api/hooks?host=all`);
    assert.equal(denied.status, 401);
    assert.equal(calls, 0, 'authentication runs before a hook audit can touch the machine');

    const invalid = await get(`${server.url}api/hooks?host=unknown-host`, server.token);
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0, 'host validation runs before the collector');

    const [first, second] = await Promise.all([
      get(`${server.url}api/hooks?host=all`, server.token),
      get(`${server.url}api/hooks?host=all`, server.token),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(calls, 1, 'concurrent reads share one audit');
    assert.deepEqual(JSON.parse(first.body), JSON.parse(second.body));

    const payload = JSON.parse(first.body);
    assert.equal(payload.schemaVersion, 3);
    assert.equal(payload.summary.configuredEntries, 1);
    assert.equal(payload.summary.distinctBehaviors, 1);
    assert.equal(payload.summary.executions, 1);
    assert.equal(payload.summary.failures, 1);
    assert.equal(payload.findings[0].placements[0].lifecyclePoint, 'Stop');
    assert.equal(payload.findings[0].placements[0].action, null,
      'a provider proposal is not presented as an action without an executable healing plan');
    assert.equal(payload.runtime.recent[0].verb, 'Stop');
    assert.equal(first.body.includes(secret), false, 'paths, commands, output, and diagnostic prose stay server-side');

    const cached = await get(`${server.url}api/hooks?host=all`, server.token);
    assert.equal(cached.status, 200);
    assert.equal(calls, 1, 'a sequential read reuses the bounded server cache');

    const usageResponse = await get(`${server.url}api/usage?days=14`, server.token);
    assert.deepEqual(JSON.parse(usageResponse.body).context, context,
      'Context rides the existing Usage aggregate; it does not need another endpoint or collector');
  } finally {
    await server.close();
  }
});

test('/api/hooks/source resolves only audited opaque refs, masks definitions, and rejects drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-source-'));
  const file = path.join(root, 'settings.json');
  const document = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'TOKEN=super-secret node stop.cjs', timeout: 5 }] }] } };
  fs.writeFileSync(file, JSON.stringify(document));
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const record = {
    occurrenceId: 'source-occurrence', behaviorFingerprint: 'source-behavior', host: 'claude',
    event: 'Stop', matcher: '', type: 'command', indices: { group: 0, hook: 0 }, handler: {},
    command: { normalized: 'TOKEN=<redacted> node stop.cjs', redacted: true },
    timeout: { declared: 5, effective: 5, units: 'seconds', status: 'valid-or-default' },
    source: { file, baseDir: root, digest, sourceKind: 'global', authority: 'user-owned', generatedStatus: 'direct', owner: 'user' },
    diagnostics: [], sideEffects: [], selected: true,
  };
  const hooks = async () => ({ audit: {
    auditId: 'audit-source', mode: 'read-only', hosts: ['claude'], runtimeVersions: { claude: 'test' },
    reports: { claude: {
      hostSchema: { confidence: 'syntax-only' }, sources: [{ file, status: 'valid', digest }], records: [record], plan: [],
      summary: { sources: 1, invalidSources: 0, hookOccurrences: 1, uniqueBehaviors: 1 },
      coverage: { status: 'partial', gaps: [] },
    } },
  }, receipts: [] });
  const usage = {
    readIndex: async () => ({ context: null, sessions: [], projectTree: [], totals: {} }),
    readProviderAnalytics: async () => ({ openrouter: null }),
    maskSecrets: (value) => String(value).replace(/super-secret/g, '…redacted'),
  };
  const server = await startDashboard({ port: 0, fetchStatus: async () => ({ rows: [] }), hooks, usage });
  try {
    const summary = await get(`${server.url}api/hooks?host=all`, server.token);
    const ref = JSON.parse(summary.body).definitionGroups[0].placements[0].source.ref;
    assert.match(ref, /^[a-f0-9]{32}$/);
    assert.equal(summary.body.includes(file), false, 'the summary does not expose the physical path');

    const denied = await get(`${server.url}api/hooks/source/${ref}`);
    assert.equal(denied.status, 401);
    const arbitrary = await get(`${server.url}api/hooks/source/${ref}?path=/etc/passwd`, server.token);
    assert.equal(arbitrary.status, 400);
    const missing = await get(`${server.url}api/hooks/source/${'a'.repeat(32)}`, server.token);
    assert.equal(missing.status, 404);

    const detail = await get(`${server.url}api/hooks/source/${ref}`, server.token);
    assert.equal(detail.status, 200);
    const payload = JSON.parse(detail.body);
    assert.equal(payload.location.absolutePath, file);
    assert.equal(payload.location.selector, '/hooks/Stop/0/hooks/0');
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.definition.status, 'available');
    assert.equal(payload.definition.value.command.includes('super-secret'), false);
    assert.equal(payload.format, 'json');
    assert.match(payload.explanation, /Stop hook definition selected.*JSON source/);
    assert.equal(payload.redacted, true);

    fs.writeFileSync(file, JSON.stringify({ changed: true }));
    const drift = await get(`${server.url}api/hooks/source/${ref}`, server.token);
    assert.equal(drift.status, 409);
    assert.equal(JSON.parse(drift.body).code, 'HOOK_SOURCE_CHANGED');
    assert.match(JSON.parse(drift.body).recovery, /refreshed/);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/api/hooks/source reports expiry and remints the same unchanged audited reference after refresh', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-expiry-'));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } }));
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const record = {
    occurrenceId: 'expiry-occurrence', behaviorFingerprint: 'expiry-behavior', host: 'codex',
    event: 'Stop', matcher: '', type: 'command', indices: { group: 0, hook: 0 }, handler: {},
    source: { file, baseDir: root, digest, sourceKind: 'project', owner: 'project-owner' },
    diagnostics: [], sideEffects: [], selected: true,
  };
  const hooks = async () => ({ audit: {
    auditId: 'expiry-audit', reports: { codex: {
      sources: [{ file, status: 'valid', digest }], records: [record], plan: [],
      summary: { sources: 1, hookOccurrences: 1, uniqueBehaviors: 1 },
      coverage: { status: 'partial', gaps: [] },
    } },
  }, receipts: [] });
  const usage = {
    readIndex: async () => ({ context: null, sessions: [], projectTree: [], totals: {} }),
    readProviderAnalytics: async () => ({ openrouter: null }), maskSecrets: String,
  };
  const server = await startDashboard({
    port: 0, fetchStatus: async () => ({ rows: [] }), hooks, usage, hookCacheMs: 1_000,
  });
  try {
    const summary = JSON.parse((await get(`${server.url}api/hooks?host=all`, server.token)).body);
    const ref = summary.definitionGroups[0].placements[0].source.ref;
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const expired = await get(`${server.url}api/hooks/source/${ref}`, server.token);
    assert.equal(expired.status, 404);
    assert.equal(JSON.parse(expired.body).code, 'HOOK_SOURCE_NOT_FOUND');
    const refreshed = JSON.parse((await get(`${server.url}api/hooks?host=all`, server.token)).body);
    assert.equal(refreshed.definitionGroups[0].placements[0].source.ref, ref,
      'unchanged audited content remints the same opaque reference');
    assert.equal((await get(`${server.url}api/hooks/source/${ref}`, server.token)).status, 200);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
