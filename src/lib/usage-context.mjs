// usage-context.mjs — a bounded, privacy-preserving projection over normalized
// per-session context evidence. It contains no transcript parsing and retains
// no prompt/turn bodies. It carries the same bounded, sanitized local session
// labels already exposed by the authenticated Sessions view so attention rows
// can be grouped and opened. Policy comes from the Context Budget domain so
// runtime decisions and historical projections cannot drift.
import { createHash } from 'node:crypto';
import { CONTEXT_BUDGET_POLICY } from './context-budget.mjs';
import { safeProjectKey } from './live/project-label.mjs';
import { stripUnsafeChars } from './text-safety.mjs';

export const CONTEXT_POLICY = CONTEXT_BUDGET_POLICY;

export const CONTEXT_ATTENTION_LIMIT = 20;
const HOSTS = Object.freeze(['claude', 'codex', 'opencode']);

const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const numberOrNull = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value) : null;

function evidenceOf(session) {
  const evidence = session?.contextEvidence;
  if (evidence && typeof evidence === 'object') return evidence;

  // Compatibility-only records can still report that input/window were seen,
  // but cannot claim pressure: ctxLastTokens and ctxWindow were not guaranteed
  // to come from the same snapshot before schema v17.
  const input = positive(session?.ctxLastTokens) ? Number(session.ctxLastTokens) : null;
  const window = positive(session?.ctxWindow) ? Number(session.ctxWindow) : null;
  return {
    schemaVersion: 1,
    state: input || window ? 'partial' : 'not-recorded',
    input: input ? { first: input, last: input, peak: input, samples: 1 } : null,
    window: window ? {
      first: window, last: window, min: window, max: window, samples: 1,
      provenance: 'legacy-compatibility',
    } : null,
    pressure: null,
  };
}

function nearestRank(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function distribution(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  const sorted = clean.slice().sort((a, b) => a - b);
  return {
    min: sorted[0], median: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9),
    max: sorted.at(-1),
  };
}

function coverageOf(rows) {
  let inputMeasured = 0;
  let windowMeasured = 0;
  let pressureMeasured = 0;
  for (const row of rows) {
    const evidence = evidenceOf(row);
    if (evidence.input) inputMeasured++;
    if (evidence.window) windowMeasured++;
    if (evidence.pressure) pressureMeasured++;
  }
  const sessions = rows.length;
  let state = 'not-observed';
  if (sessions && pressureMeasured === sessions) state = 'observed';
  else if (inputMeasured || windowMeasured || pressureMeasured) state = 'partial';
  else if (sessions) state = 'not-recorded';
  return {
    sessions, inputMeasured, windowMeasured, pressureMeasured,
    missingInput: sessions - inputMeasured, missingWindow: sessions - windowMeasured,
    state,
  };
}

function fold(rows) {
  const first = [];
  const last = [];
  const peak = [];
  const windows = [];
  const firstBps = [];
  const lastBps = [];
  const peakBps = [];
  const growth = [];
  let startupOverTarget = 0;
  let reserveBreaches = 0;
  let overWindow = 0;

  for (const row of rows) {
    const evidence = evidenceOf(row);
    if (evidence.input) {
      first.push(numberOrNull(evidence.input.first));
      last.push(numberOrNull(evidence.input.last));
      peak.push(numberOrNull(evidence.input.peak));
      const delta = numberOrNull(evidence.input.last) - numberOrNull(evidence.input.first);
      if (Number.isFinite(delta)) growth.push(delta);
    }
    if (evidence.window) windows.push(numberOrNull(evidence.window.last));
    if (evidence.pressure) {
      const start = numberOrNull(evidence.pressure.firstBps);
      const current = numberOrNull(evidence.pressure.lastBps);
      const high = numberOrNull(evidence.pressure.peakBps);
      firstBps.push(start); lastBps.push(current); peakBps.push(high);
      if (start > CONTEXT_POLICY.startupTargetBps) startupOverTarget++;
      if (high >= CONTEXT_POLICY.dynamicHandoffBps) reserveBreaches++;
      if (high > 10_000) overWindow++;
    }
  }

  return {
    coverage: coverageOf(rows),
    inputTokens: { first: distribution(first), last: distribution(last), peak: distribution(peak) },
    windowTokens: distribution(windows),
    pressureBps: {
      first: distribution(firstBps), last: distribution(lastBps), peak: distribution(peakBps),
    },
    growthTokens: distribution(growth),
    startupOverTarget, reserveBreaches, overWindow,
  };
}

function attentionState(evidence) {
  const peak = numberOrNull(evidence.pressure?.peakBps);
  const first = numberOrNull(evidence.pressure?.firstBps);
  if (peak > 10_000) return 'over-window';
  if (peak >= CONTEXT_POLICY.dynamicHandoffBps) return 'handoff';
  if (peak >= CONTEXT_POLICY.dynamicCompactBps) return 'compact';
  if (peak >= CONTEXT_POLICY.dynamicWarningBps) return 'warn';
  if (first > CONTEXT_POLICY.startupCriticalBps) return 'startup-critical';
  return null;
}

function attentionRow(session) {
  const evidence = evidenceOf(session);
  const state = attentionState(evidence);
  if (!state) return null;
  const project = stripUnsafeChars(session.project ?? 'unknown').normalize('NFKC')
    .trim().replace(/\s+/gu, ' ').slice(0, 128) || 'unknown';
  return {
    id: String(session.id ?? ''),
    host: HOSTS.includes(session.host) ? session.host : 'unknown',
    project,
    projectKey: safeProjectKey(session.projectKey, project),
    title: stripUnsafeChars(session.title ?? '').slice(0, 100) || '(untitled conversation)',
    sessionRef: `${HOSTS.includes(session.host) ? session.host : 'session'}-${createHash('sha256')
      .update(`${session.host ?? 'unknown'}\0${session.id ?? ''}`).digest('hex').slice(0, 12)}`,
    start: typeof session.start === 'string' ? session.start : null,
    firstInputTokens: numberOrNull(evidence.input?.first),
    lastInputTokens: numberOrNull(evidence.input?.last),
    peakInputTokens: numberOrNull(evidence.input?.peak),
    windowTokens: numberOrNull(evidence.window?.last),
    firstBps: numberOrNull(evidence.pressure?.firstBps),
    lastBps: numberOrNull(evidence.pressure?.lastBps),
    peakBps: numberOrNull(evidence.pressure?.peakBps),
    state,
  };
}

/** Build the fixed-shape Context sibling returned with the Usage aggregate. */
export function buildContextProjection(sessions, { generatedAt = null, windowDays = null } = {}) {
  const rows = Array.isArray(sessions) ? sessions.filter((row) => row && typeof row === 'object') : [];
  const byHost = Object.fromEntries(HOSTS.map((host) => [host, fold(rows.filter((row) => row.host === host))]));
  const attention = rows.map(attentionRow).filter(Boolean).sort((a, b) =>
    (b.peakBps ?? -1) - (a.peakBps ?? -1)
      || (b.firstBps ?? -1) - (a.firstBps ?? -1)
      || a.id.localeCompare(b.id)).slice(0, CONTEXT_ATTENTION_LIMIT);
  return {
    schemaVersion: 2,
    generatedAt: typeof generatedAt === 'string' ? generatedAt : null,
    windowDays: windowDays !== null && windowDays !== undefined && Number.isFinite(Number(windowDays))
      ? Number(windowDays) : null,
    policy: { ...CONTEXT_POLICY },
    summary: fold(rows),
    byHost,
    attention,
  };
}
