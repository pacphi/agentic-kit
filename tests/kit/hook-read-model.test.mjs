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
            source: {
              file: '/private/secret/project/.claude/settings.json', sourceKind: 'project',
              authority: 'project-owned', owner: 'project-owner',
            },
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

  assert.equal(model.schemaVersion, 2);
  assert.deepEqual(model.summary, {
    sourcesInspected: 1, unreadableSources: 0,
    configuredEntries: 1, distinctBehaviors: 1, repeatedPlacements: 0,
    findingsNeedingAttention: 1, evidenceLimits: 1,
    executions: 1, failures: 1, timeouts: 1,
  });
  assert.equal(model.runtime.byHost[0].host, 'hermes[31m');
  assert.equal(model.runtime.byHost[0].durationMs, 205);
  assert.equal(model.runtime.recent[0].outcome, 'timed-out');
  assert.equal(model.runtime.recent[0].stdoutBytes, 101);
  assert.equal(model.runtime.recent[0].stdoutTruncated, true);
  assert.equal(model.runtime.state, 'observed');
  assert.equal(model.definitionGroups.length, 1);
  assert.equal(model.definitionGroups[0].lifecyclePoint, 'Stop');
  assert.equal(model.definitionGroups[0].placements[0].source.label, 'Project configuration');
  assert.equal(model.findings[0].title, 'Hook may resolve a package when it runs');
  assert.equal(model.findings[0].affectedDefinitions, 1);
  assert.equal(model.findings[0].action, null,
    'an upstream-required proposal without a verified published issue is not a CTA');
  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized, /super-secret|private-token|\/private\/secret|Bearer|hook payload/);
});

test('hook read model groups repeated placements and only exposes proven executable actions', () => {
  const record = (file, occurrenceId) => ({
    occurrenceId, behaviorFingerprint: 'behavior-a', host: 'claude', event: 'Stop', type: 'command',
    matcher: '', command: { normalized: 'node hook.cjs', redacted: false },
    handler: { async: false }, timeout: { declared: 5, effective: 5, units: 'seconds', status: 'valid-or-default' },
    sideEffects: ['state-write-possible'], selected: null,
    source: {
      file, digest: `digest-${occurrenceId}`, sourceKind: 'project', authority: 'project-owned',
      generatedStatus: 'direct', owner: 'project-owner', baseDir: '/workspace/project',
    },
    diagnostics: [{ code: 'dynamic-shell', severity: 'review', category: 'security' }],
  });
  const model = buildHookDashboardReadModel({
    audit: { reports: { claude: {
      sources: [{ file: '/workspace/project/.claude/settings.json', status: 'valid' }],
      records: [record('/workspace/project/.claude/settings.json', 'one'), record('/workspace/project/.claude/other.json', 'two')],
      plan: [], summary: { sources: 1, invalidSources: 0, hookOccurrences: 2, uniqueBehaviors: 1, configurationIssues: 0 },
      coverage: { status: 'partial', gaps: ['runtime trust is not observed'] },
    } } },
    healingPlan: { planDigest: 'plan-123', actions: [{
      id: 'heal-1', host: 'claude', executable: true, classification: 'approval-required',
      observedProjection: { occurrenceIds: ['one'] },
    }] },
    sourceRef: ({ occurrenceId }) => `ref-${occurrenceId}`,
  });

  assert.equal(model.summary.repeatedPlacements, 1);
  assert.equal(model.definitionGroups.length, 1);
  assert.equal(model.definitionGroups[0].placements.length, 2);
  assert.equal(model.definitionGroups[0].placements[0].source.ref, 'ref-one');
  assert.equal(model.findings[0].action.label, 'Preview repair');
  assert.equal(model.findings[0].action.planDigest, 'plan-123');
});

test('adapter records retain their concrete host identity and unknown runtime stays unknown', () => {
  const model = buildHookDashboardReadModel({ audit: { reports: { external: {
    sources: [], plan: [], summary: { sources: 0, invalidSources: 0, hookOccurrences: 1, uniqueBehaviors: 1 },
    coverage: { status: 'partial', gaps: [] }, records: [{
      occurrenceId: 'hermes-1', behaviorFingerprint: 'hermes-b', host: 'hermes',
      event: 'lifecycle.stop', type: 'argv-subprocess', matcher: '', handler: {}, command: {},
      timeout: null, sideEffects: [], selected: null,
      source: { file: '/adapter/hermes.json', sourceKind: 'external-adapter-manifest', owner: 'hermes' },
      diagnostics: [],
    }],
  } } } });

  assert.equal(model.definitionGroups[0].host, 'hermes');
  assert.equal(model.runtime.state, 'not-recorded');
  assert.equal(model.summary.executions, 0);
});

test('upstream findings get a link only from the exact published constraint', () => {
  const file = '/workspace/project/.claude/settings.json';
  const model = buildHookDashboardReadModel({
    audit: { reports: { claude: { sources: [], summary: {}, coverage: { status: 'partial', gaps: [] },
      records: [{
        occurrenceId: 'aqe-1', behaviorFingerprint: 'aqe-b', host: 'claude', event: 'Stop', type: 'command',
        matcher: '', handler: {}, command: {}, timeout: null, sideEffects: [], selected: null,
        source: { file, sourceKind: 'project', owner: 'project-owner' },
        diagnostics: [{ code: 'aqe-npx-hot-path-fallback', severity: 'warning', category: 'reliability' }],
      }],
      plan: [{ diagnostic: 'aqe-npx-hot-path-fallback', target: file, classification: 'upstream-required',
        upstream: { dependency: 'agentic-qe', owner: 'proffesor-for-testing/agentic-qe' } }],
    } } },
    healingPlan: { upstream: { constraints: [{
      id: 'agentic-qe-3.14.0-stop-hook-generator', dependency: 'agentic-qe',
      notification: { status: 'published', publishedUrl: 'https://github.com/proffesor-for-testing/agentic-qe/issues/654' },
    }] } },
  });

  assert.equal(model.findings[0].owner, 'proffesor-for-testing/agentic-qe');
  assert.deepEqual(model.findings[0].action, {
    actionId: 'agentic-qe-3.14.0-stop-hook-generator', classification: 'upstream-required',
    label: 'View upstream issue', href: 'https://github.com/proffesor-for-testing/agentic-qe/issues/654',
  });
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
