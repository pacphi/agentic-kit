import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHookDashboardReadModel } from '../../src/lib/hook-read-model.mjs';

test('hook read model aggregates audit and runtime receipts without exposing commands, paths, or output', () => {
  const model = buildHookDashboardReadModel({
    audit: {
      reports: {
        claude: {
          records: [{
            event: 'Stop',
            source: { file: '/private/secret/project/.claude/settings.json' },
            command: { normalized: 'TOKEN=super-secret node hook.cjs' },
            diagnostics: [{
              code: 'aqe-npx-hot-path-fallback', severity: 'warning', category: 'reliability',
              message: 'contains implementation detail',
            }],
          }],
          plan: [{ classification: 'upstream-required', diagnostic: 'aqe-npx-hot-path-fallback' }],
          summary: { hookOccurrences: 1, uniqueBehaviors: 1, configurationIssues: 0 },
        },
      },
    },
    receipts: [{
      hostId: 'hermes\u001b[31m', verb: 'session-end', outcome: 'timed-out', timedOut: true,
      durationMs: 205, timeoutMs: 200, stdoutBytes: 101, stderrBytes: 23,
      stdoutTruncated: true, stderrTruncated: false,
      stdout: 'super-secret hook payload', stderrText: 'Bearer private-token',
      detail: '/private/secret/project failed',
    }],
  });

  assert.deepEqual(model.summary, {
    configuredHooks: 1, uniqueBehaviors: 1, configurationIssues: 0,
    diagnostics: 1, plannedActions: 1,
    executions: 1, failures: 1, timeouts: 1,
  });
  assert.deepEqual(model.actions, {
    automaticEligible: 0, approvalRequired: 0, prohibited: 0, upstreamRequired: 1,
  });
  assert.equal(model.runtime.byHost[0].host, 'hermes[31m');
  assert.equal(model.runtime.byHost[0].durationMs, 205);
  assert.equal(model.runtime.recent[0].outcome, 'timed-out');
  assert.equal(model.runtime.recent[0].stdoutBytes, 101);
  assert.equal(model.runtime.recent[0].stdoutTruncated, true);
  assert.deepEqual(model.diagnostics, [{
    host: 'claude', event: 'Stop', code: 'aqe-npx-hot-path-fallback',
    severity: 'warning', category: 'reliability', count: 1,
  }]);
  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized, /super-secret|private-token|\/private\/secret|Bearer|hook payload/);
});

test('hook read model bounds hostile receipt values and uses stable outcome vocabulary', () => {
  const receipts = Array.from({ length: 1_100 }, (_, index) => ({
    hostId: `external-${index}`,
    verb: `verb-${'x'.repeat(200)}`,
    outcome: index === 1_099 ? 'invented-secret-outcome' : 'success',
    timedOut: false,
    durationMs: Number.POSITIVE_INFINITY,
    timeoutMs: Number.MAX_SAFE_INTEGER,
    stdoutBytes: Number.MAX_SAFE_INTEGER,
    stderrBytes: -10,
    stdoutTruncated: false,
    stderrTruncated: false,
  }));
  const model = buildHookDashboardReadModel({ receipts });

  assert.equal(model.runtime.receiptsInspected, 1_000);
  assert.equal(model.runtime.receiptsTruncated, true);
  assert.equal(model.runtime.recent.at(-1).outcome, 'unknown');
  assert.equal(model.runtime.recent.at(-1).durationMs, 0);
  assert.equal(model.runtime.recent.at(-1).timeoutMs, 86_400_000);
  assert.equal(model.runtime.recent.at(-1).stdoutBytes, 262_145);
  assert.equal(model.runtime.recent.at(-1).stderrBytes, 0);
  assert.ok(model.runtime.recent.at(-1).verb.length <= 64);
});
