import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import {
  buildContextProjection, CONTEXT_ATTENTION_LIMIT, CONTEXT_POLICY,
} from '../../src/lib/usage-context.mjs';
import { blankSession, noteContextSample } from '../../src/lib/usage-parsers.mjs';

const observed = ({ first, last, peak, window, firstBps, lastBps, peakBps }) => ({
  schemaVersion: 1,
  state: 'observed',
  input: { first, last, peak, samples: 2 },
  window: {
    first: window, last: window, min: window, max: window,
    samples: 2, provenance: 'runtime-observed',
  },
  pressure: {
    firstBps, lastBps, peakBps, samples: 2,
    hist: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
  },
});

test('buildContextProjection folds evidence and publishes bounded local navigation labels', () => {
  const sessions = [
    {
      id: 'cx', host: 'codex', project: 'agentic-kit', start: '2026-09-01T00:00:00.000Z',
      title: 'Context audit\u202e conversation',
      contextEvidence: observed({
        first: 10_000, last: 80_000, peak: 90_000, window: 100_000,
        firstBps: 1_000, lastBps: 8_000, peakBps: 9_000,
      }),
    },
    {
      id: 'cl', host: 'claude', project: 'agentic-kit', start: '2026-09-01T01:00:00.000Z',
      contextEvidence: {
        schemaVersion: 1, state: 'partial',
        input: { first: 20_000, last: 30_000, peak: 30_000, samples: 2 },
        window: null, pressure: null,
      },
    },
    {
      id: 'oc', host: 'opencode', project: 'other', start: '2026-09-01T02:00:00.000Z',
      contextEvidence: {
        schemaVersion: 1, state: 'not-recorded', input: null, window: null, pressure: null,
      },
    },
  ];

  const projection = buildContextProjection(sessions, {
    generatedAt: '2026-09-02T00:00:00.000Z', windowDays: 7,
  });

  assert.equal(projection.schemaVersion, 2);
  assert.equal(projection.generatedAt, '2026-09-02T00:00:00.000Z');
  assert.equal(projection.windowDays, 7);
  assert.deepEqual(projection.policy, CONTEXT_POLICY);
  assert.deepEqual(projection.summary.coverage, {
    sessions: 3, inputMeasured: 2, windowMeasured: 1, pressureMeasured: 1,
    missingInput: 1, missingWindow: 2, state: 'partial',
  });
  assert.deepEqual(projection.summary.inputTokens.first, {
    min: 10_000, median: 10_000, p90: 20_000, max: 20_000,
  });
  assert.deepEqual(projection.summary.growthTokens, {
    min: 10_000, median: 10_000, p90: 70_000, max: 70_000,
  });
  assert.equal(projection.summary.startupOverTarget, 1);
  assert.equal(projection.summary.reserveBreaches, 1);
  assert.equal(projection.summary.overWindow, 0);
  assert.equal(projection.byHost.codex.coverage.state, 'observed');
  assert.equal(projection.byHost.claude.coverage.state, 'partial');
  assert.equal(projection.byHost.opencode.coverage.state, 'not-recorded');

  assert.equal(projection.attention.length, 1);
  assert.deepEqual(Object.keys(projection.attention[0]).sort(), [
    'firstBps', 'firstInputTokens', 'host', 'id', 'lastBps', 'lastInputTokens',
    'peakBps', 'peakInputTokens', 'project', 'projectKey', 'sessionRef', 'start', 'state', 'title',
    'windowTokens',
  ]);
  assert.equal(projection.attention[0].title, 'Context audit conversation',
    'display labels strip unsafe controls before reaching the dashboard');
  assert.match(projection.attention[0].sessionRef, /^codex-[0-9a-f]{12}$/);
  assert.equal(projection.attention[0].sessionRef.includes('cx'), false,
    'the visible reference is deterministic and does not expose the raw route id');
  assert.equal(JSON.stringify(projection).includes('prompt text'), false,
    'the projection adds bounded session labels, never prompt bodies or transcript turns');
});

test('Context attention assigns normalized opaque project identity independent of conversation title', () => {
  const make = (id, project, title) => ({
    id, host: 'codex', project, title,
    contextEvidence: observed({
      first: 10_000, last: 80_000, peak: 90_000, window: 100_000,
      firstBps: 1_000, lastBps: 8_000, peakBps: 9_000,
    }),
  });
  const projection = buildContextProjection([
    make('one', ' proj ', 'Context audit'),
    make('two', 'PROJ', 'Performance review'),
    make('three', '\uff30\uff32\uff2f\uff2a', 'Release review'),
    make('unknown', '\u0000\u0008', 'Unknown project'),
  ]);
  const [first, second, third] = projection.attention.filter((row) => row.project !== 'unknown');
  assert.equal(first.projectKey, second.projectKey);
  assert.equal(second.projectKey, third.projectKey,
    'case, surrounding space, and compatibility-equivalent Unicode do not split one project');
  assert.notEqual(first.title, second.title, 'conversation labels do not participate in project identity');
  assert.equal(projection.attention.find((row) => row.id === 'unknown').project, 'unknown');
  assert.match(first.projectKey, /^project:[a-f0-9]{16}$/);
});

test('Context attention is deterministic, severity-sorted, and hard bounded', () => {
  const sessions = Array.from({ length: CONTEXT_ATTENTION_LIMIT + 7 }, (_, i) => ({
    id: `s-${String(i).padStart(2, '0')}`,
    host: i % 2 ? 'codex' : 'claude', project: 'p', start: '2026-09-01T00:00:00.000Z',
    contextEvidence: observed({
      first: 10_000, last: 80_000 + i, peak: 90_000 + i,
      window: 100_000, firstBps: 1_000, lastBps: 8_000 + i, peakBps: 9_000 + i,
    }),
  }));

  const projection = buildContextProjection(sessions);
  assert.equal(projection.attention.length, CONTEXT_ATTENTION_LIMIT);
  assert.equal(projection.attention[0].id, `s-${CONTEXT_ATTENTION_LIMIT + 6}`);
  assert.equal(projection.attention.at(-1).id, 's-07');
  assert.deepEqual(projection, buildContextProjection([...sessions].reverse()),
    'input order cannot change the projection or its bounded attention list');
});

test('aggregate exposes Context and projects immutable per-session evidence', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');
  const rec = blankSession('cx-aggregate', 'codex');
  Object.assign(rec, {
    project: 'agentic-kit', title: 't', start: now - 60_000, end: now,
    responses: 1, models: ['gpt-5.6'], active: [[now - 60_000, now]],
    usage: [{
      day: '2026-09-02', model: 'gpt-5.6', input: 1, output: 1,
      cacheRead: 0, cacheWrite: 0, responses: 1,
    }],
  });
  delete rec.stamps;
  noteContextSample(rec, 25_000, 100_000);
  const deps = {
    pricesAsOf: null, costOf: () => 0,
    classify: () => ({ category: 'Build', confidence: 1, basis: 'test' }),
    detectInsights: () => [],
  };

  const projection = aggregate([rec], {
    days: 7, now, cutoff: now - 7 * 86_400_000, deps,
  });
  assert.equal(projection.context.byHost.codex.coverage.state, 'observed');
  assert.equal(projection.sessions[0].contextEvidence.pressure.firstBps, 2_500);
  projection.sessions[0].contextEvidence.input.first = 999;
  assert.equal(rec.contextEvidence.input.first, 25_000,
    'aggregate session rows never expose a mutable alias to cached parse records');
});
