// Sanitized hook observability read model. This module deliberately does not
// retain commands, source paths, hook output, error detail, or diagnostic
// prose. Dashboard transports may expose this shape without turning hook
// configuration or subprocess output into a secret-bearing side channel.

const MAX_RECEIPTS = 1_000;
const MAX_RECENT = 50;
const MAX_LABEL = 64;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024 + 1;

const OUTCOMES = new Set([
  'success', 'nonzero-exit', 'signal-exit', 'spawn-failed', 'timed-out', 'integrity-rejected',
]);

function safeLabel(value, fallback = 'unknown') {
  if (typeof value !== 'string') return fallback;
  const cleaned = [...value].filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && (code < 127 || code > 159);
  }).join('').trim();
  return cleaned ? cleaned.slice(0, MAX_LABEL) : fallback;
}

function boundedInteger(value, maximum) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), maximum);
}

function sanitizedReceipt(receipt) {
  const outcome = OUTCOMES.has(receipt?.outcome) ? receipt.outcome : 'unknown';
  return {
    host: safeLabel(receipt?.hostId),
    verb: safeLabel(receipt?.verb),
    outcome,
    timedOut: outcome === 'timed-out' || receipt?.timedOut === true,
    durationMs: boundedInteger(receipt?.durationMs, MAX_DURATION_MS),
    timeoutMs: boundedInteger(receipt?.timeoutMs, MAX_DURATION_MS),
    stdoutBytes: boundedInteger(receipt?.stdoutBytes, MAX_OUTPUT_BYTES),
    stderrBytes: boundedInteger(receipt?.stderrBytes, MAX_OUTPUT_BYTES),
    stdoutTruncated: receipt?.stdoutTruncated === true,
    stderrTruncated: receipt?.stderrTruncated === true,
  };
}

function auditFacts(audit) {
  const reports = audit?.reports && typeof audit.reports === 'object' ? audit.reports : {};
  const totals = {
    configuredHooks: 0, uniqueBehaviors: 0, configurationIssues: 0,
    diagnostics: 0, plannedActions: 0,
  };
  const actions = {
    automaticEligible: 0, approvalRequired: 0, prohibited: 0, upstreamRequired: 0,
  };
  const diagnostics = new Map();
  for (const [rawHost, report] of Object.entries(reports)) {
    const host = safeLabel(rawHost);
    totals.configuredHooks += boundedInteger(report?.summary?.hookOccurrences, Number.MAX_SAFE_INTEGER);
    totals.uniqueBehaviors += boundedInteger(report?.summary?.uniqueBehaviors, Number.MAX_SAFE_INTEGER);
    totals.configurationIssues += boundedInteger(report?.summary?.configurationIssues, Number.MAX_SAFE_INTEGER);
    const records = Array.isArray(report?.records) ? report.records : [];
    for (const record of records) {
      for (const diagnostic of Array.isArray(record?.diagnostics) ? record.diagnostics : []) {
        const item = {
          host,
          event: safeLabel(record?.event),
          code: safeLabel(diagnostic?.code),
          severity: safeLabel(diagnostic?.severity),
          category: safeLabel(diagnostic?.category),
        };
        const key = JSON.stringify(item);
        diagnostics.set(key, { ...item, count: (diagnostics.get(key)?.count ?? 0) + 1 });
        totals.diagnostics += 1;
      }
    }
    for (const action of Array.isArray(report?.plan) ? report.plan : []) {
      totals.plannedActions += 1;
      if (action?.classification === 'automatic-eligible' || action?.classification === 'automatic') actions.automaticEligible += 1;
      else if (action?.classification === 'approval-required') actions.approvalRequired += 1;
      else if (action?.classification === 'prohibited' || action?.classification === 'never-automatic') actions.prohibited += 1;
      else if (action?.classification === 'upstream-required') actions.upstreamRequired += 1;
    }
  }
  return {
    totals, actions,
    diagnostics: [...diagnostics.values()].sort((a, b) => (
      a.host.localeCompare(b.host) || a.event.localeCompare(b.event) || a.code.localeCompare(b.code)
    )),
  };
}

function runtimeFacts(receipts) {
  const input = Array.isArray(receipts) ? receipts : [];
  const selected = input.slice(-MAX_RECEIPTS).map(sanitizedReceipt);
  const hosts = new Map();
  let failures = 0;
  let timeouts = 0;
  for (const receipt of selected) {
    if (receipt.outcome !== 'success') failures += 1;
    if (receipt.timedOut) timeouts += 1;
    const row = hosts.get(receipt.host) ?? {
      host: receipt.host, executions: 0, failures: 0, timeouts: 0,
      durationMs: 0, stdoutBytes: 0, stderrBytes: 0, truncatedOutputs: 0,
    };
    row.executions += 1;
    row.failures += receipt.outcome === 'success' ? 0 : 1;
    row.timeouts += receipt.timedOut ? 1 : 0;
    row.durationMs = boundedInteger(row.durationMs + receipt.durationMs, Number.MAX_SAFE_INTEGER);
    row.stdoutBytes = boundedInteger(row.stdoutBytes + receipt.stdoutBytes, Number.MAX_SAFE_INTEGER);
    row.stderrBytes = boundedInteger(row.stderrBytes + receipt.stderrBytes, Number.MAX_SAFE_INTEGER);
    row.truncatedOutputs += receipt.stdoutTruncated || receipt.stderrTruncated ? 1 : 0;
    hosts.set(receipt.host, row);
  }
  return {
    executions: selected.length, failures, timeouts,
    model: {
      receiptsInspected: selected.length,
      receiptsTruncated: input.length > MAX_RECEIPTS,
      byHost: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host)),
      recent: selected.slice(-MAX_RECENT),
    },
  };
}

export function buildHookDashboardReadModel({ audit = null, receipts = [] } = {}) {
  const staticFacts = auditFacts(audit);
  const runtime = runtimeFacts(receipts);
  return {
    schemaVersion: 1,
    summary: {
      ...staticFacts.totals,
      executions: runtime.executions,
      failures: runtime.failures,
      timeouts: runtime.timeouts,
    },
    actions: staticFacts.actions,
    diagnostics: staticFacts.diagnostics,
    runtime: runtime.model,
  };
}
