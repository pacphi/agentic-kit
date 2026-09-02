import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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

test('Usage rail and tabpanels expose Score, Limits, Findings, Prompts, Context, Hooks, Models, Sessions, Transcript', () => {
  const order = [...PAGE.matchAll(/data-view="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(order.slice(0, 9), [
    'score', 'limits', 'findings', 'prompts', 'context', 'hooks', 'models', 'sessions', 'transcript',
  ]);
  assert.match(PAGE, /id="usage-tab-score"[^>]*>Score<\/button>/);
  for (const view of ['context', 'hooks']) {
    assert.match(PAGE, new RegExp(`id="usage-tab-${view}"[^>]*aria-controls="v-${view}"`));
    assert.match(PAGE, new RegExp(`id="v-${view}"[^>]*role="tabpanel"[^>]*aria-labelledby="usage-tab-${view}"`));
  }
  assert.match(PAGE, /Runtime-observed transcript snapshots/,
    'Context visibly labels the evidence it can and cannot claim');
  assert.match(PAGE, /Read-only configuration audit/,
    'Hooks visibly labels its read-only evidence boundary');
  assert.match(PAGE, /Stop configuration/);
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
    assert.equal(payload.summary.configuredHooks, 2);
    assert.equal(payload.summary.executions, 1);
    assert.equal(payload.summary.failures, 1);
    assert.equal(payload.actions.upstreamRequired, 1);
    assert.equal(payload.diagnostics[0].event, 'Stop');
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
