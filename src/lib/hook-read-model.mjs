// Browser-safe hook assurance projection. It exposes bounded structural facts,
// opaque source references and allowlisted presentation copy. Raw paths,
// commands, hook output and provider prose remain server-private.
import {
  hookOwnerLabel, hookSourceLabel, presentHookFinding, upstreamConstraintIdFor,
} from './hook-presentation.mjs';

const MAX_RECEIPTS = 1_000;
const MAX_RECENT = 50;
const MAX_LABEL = 64;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024 + 1;

const OUTCOMES = new Set([
  'success', 'nonzero-exit', 'signal-exit', 'spawn-failed', 'timed-out', 'integrity-rejected',
]);

const IMPORTANCE = Object.freeze({
  critical: 0, error: 0, fail: 0, warning: 1, warn: 1, review: 2, info: 3, unknown: 4,
});

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

function sourceCount(report) {
  if (Number.isFinite(report?.summary?.sources)) return boundedInteger(report.summary.sources, Number.MAX_SAFE_INTEGER);
  const paths = new Set((report?.records ?? []).map((record) => record?.source?.file).filter(Boolean));
  return paths.size;
}

function unreadableCount(report) {
  if (Number.isFinite(report?.summary?.invalidSources)) return boundedInteger(report.summary.invalidSources, Number.MAX_SAFE_INTEGER);
  return (report?.sources ?? []).filter((source) => !['valid', 'opaque'].includes(source?.status)).length;
}

function timeoutProjection(timeout) {
  if (!timeout || typeof timeout !== 'object') return null;
  return {
    declared: Number.isFinite(timeout.declared) ? timeout.declared : null,
    effective: Number.isFinite(timeout.effective) ? timeout.effective : null,
    units: safeLabel(timeout.units, 'not established'),
    status: safeLabel(timeout.status, 'unknown'),
  };
}

function selectionState(value) {
  if (value === true) return 'selected';
  if (value === false) return 'not-selected';
  return 'not-determined';
}

function executableActions(healingPlan) {
  const byOccurrence = new Map();
  for (const action of healingPlan?.actions ?? []) {
    if (action?.executable !== true) continue;
    for (const occurrenceId of action?.observedProjection?.occurrenceIds ?? []) {
      byOccurrence.set(occurrenceId, {
        actionId: safeLabel(action.id),
        classification: safeLabel(action.classification),
        label: 'Preview repair',
        planDigest: safeLabel(healingPlan.planDigest),
      });
    }
  }
  return byOccurrence;
}

function proposalFor(report, record, diagnostic) {
  const target = diagnostic?.target ?? record?.source?.file;
  return (report?.plan ?? []).find((proposal) => (
    proposal?.diagnostic === diagnostic?.code && proposal?.target === target
  )) ?? null;
}

function publishedUpstreamAction(healingPlan, proposal, code) {
  if (proposal?.classification !== 'upstream-required' || !proposal?.upstream?.dependency) return null;
  const constraintId = upstreamConstraintIdFor(code);
  if (!constraintId) return null;
  const constraint = (healingPlan?.upstream?.constraints ?? []).find((item) => (
    item?.id === constraintId && item?.dependency === proposal.upstream.dependency
    && item?.notification?.status === 'published'
    && typeof item?.notification?.publishedUrl === 'string'
  ));
  let href = null;
  try {
    const parsed = new URL(constraint?.notification?.publishedUrl);
    if (['https:', 'http:'].includes(parsed.protocol)) href = parsed.href;
  } catch { /* invalid or relative URLs are not actionable */ }
  return constraint && href ? {
    actionId: safeLabel(constraint.id), classification: 'upstream-required',
    label: 'View upstream issue', href: href.slice(0, 512),
  } : null;
}

function dispositionFor(proposal) {
  if (!proposal) return 'No evidence-backed action';
  if (proposal.classification === 'upstream-required') return 'Owned upstream; no verified issue action';
  if (proposal.classification === 'prohibited' || proposal.classification === 'never-automatic') return 'Automation prohibited';
  if (proposal.classification === 'approval-required') return 'Review required; no executable plan';
  return 'No evidence-backed action';
}

function importanceRank(value) {
  return IMPORTANCE[String(value ?? 'unknown').toLowerCase()] ?? IMPORTANCE.unknown;
}

function findingPlacement({ record, host, occurrenceId, placement, code, presentation, proposal, action }) {
  return {
    occurrenceId,
    lifecyclePoint: safeLabel(record?.event),
    host,
    source: placement.source,
    owner: proposal?.upstream?.owner ? safeLabel(proposal.upstream.owner) : placement.owner,
    authority: placement.authority,
    selectionState: placement.selectionState,
    generatedStatus: placement.generatedStatus,
    code,
    evidence: presentation.explanation,
    disposition: action ? null : dispositionFor(proposal),
    action,
  };
}

function addRecordDiagnostics({
  record, report, host, occurrenceId, group, placement, findingGroups, observationGroups,
  actions, healingPlan,
}) {
  for (const diagnostic of Array.isArray(record?.diagnostics) ? record.diagnostics : []) {
    const code = safeLabel(diagnostic?.code);
    const proposal = proposalFor(report, record, diagnostic);
    const presentation = presentHookFinding(code);
    const findingId = safeLabel(presentation.groupId, code);
    const severity = safeLabel(diagnostic?.severity);
    const action = actions.get(record?.occurrenceId)
      ?? publishedUpstreamAction(healingPlan, proposal, code) ?? null;
    const observationsOnly = ['info', 'unknown'].includes(severity.toLowerCase()) && !proposal && !action;
    const target = observationsOnly ? observationGroups : findingGroups;
    let finding = target.get(findingId);
    if (!finding) {
      finding = {
        findingId, code, codes: [], title: presentation.title, explanation: presentation.explanation,
        severity, categories: [], affectedOccurrenceIds: [], affectedDefinitions: 0,
        placements: [],
      };
      target.set(findingId, finding);
    }
    if (importanceRank(severity) < importanceRank(finding.severity)) finding.severity = severity;
    if (!finding.codes.includes(code)) finding.codes.push(code);
    const category = safeLabel(diagnostic?.category);
    if (!finding.categories.includes(category)) finding.categories.push(category);
    if (!finding.affectedOccurrenceIds.includes(occurrenceId)) {
      finding.affectedOccurrenceIds.push(occurrenceId);
      finding.placements.push(findingPlacement({
        record, host, occurrenceId, placement, code, presentation, proposal, action,
      }));
      finding.affectedDefinitions = finding.affectedOccurrenceIds.length;
    }
    const placementIds = observationsOnly ? placement.observationIds : placement.findingIds;
    const groupIds = observationsOnly ? group.observationIds : group.findingIds;
    placementIds.push(findingId);
    if (!groupIds.includes(findingId)) groupIds.push(findingId);
  }
}

function staticFacts(audit, options = {}) {
  const healingPlan = /** @type {any} */ (options).healingPlan;
  const sourceRef = /** @type {any} */ (options).sourceRef;
  const reports = audit?.reports && typeof audit.reports === 'object' ? audit.reports : {};
  const groups = new Map();
  const findingGroups = new Map();
  const observationGroups = new Map();
  const actions = executableActions(healingPlan);
  let sourcesInspected = 0;
  let unreadableSources = 0;
  const coverageByHost = [];

  for (const [reportHost, report] of Object.entries(reports)) {
    sourcesInspected += sourceCount(report);
    unreadableSources += unreadableCount(report);
    coverageByHost.push({
      host: safeLabel(reportHost), status: safeLabel(report?.coverage?.status, 'unknown'),
      gaps: boundedInteger(report?.coverage?.gaps?.length, Number.MAX_SAFE_INTEGER),
    });
    for (const record of Array.isArray(report?.records) ? report.records : []) {
      const host = safeLabel(record?.host, safeLabel(reportHost));
      const behaviorId = safeLabel(record?.behaviorFingerprint ?? record?.occurrenceId, 'unknown');
      let group = groups.get(behaviorId);
      if (!group) {
        group = {
          behaviorId, host, lifecyclePoint: safeLabel(record?.event),
          handlerKind: safeLabel(record?.type), appliesWhen: safeLabel(record?.matcher, 'all matching events'),
          definition: {
            timeout: timeoutProjection(record?.timeout),
            async: record?.handler?.async === true,
            sideEffectSignals: (Array.isArray(record?.sideEffects) ? record.sideEffects : []).slice(0, 8).map((item) => safeLabel(item)),
          },
          placements: [], findingIds: [], observationIds: [],
        };
        groups.set(behaviorId, group);
      }
      const occurrenceId = safeLabel(record?.occurrenceId, `${behaviorId}-${group.placements.length + 1}`);
      const rawRef = typeof sourceRef === 'function' ? sourceRef(record) : null;
      const ref = typeof rawRef === 'string' && rawRef.trim() ? safeLabel(rawRef) : null;
      const placement = {
        occurrenceId,
        source: { ref, label: hookSourceLabel(record?.source), kind: safeLabel(record?.source?.sourceKind) },
        owner: hookOwnerLabel(record?.source), authority: safeLabel(record?.source?.authority, 'not established'),
        generatedStatus: safeLabel(record?.source?.generatedStatus, 'unknown'),
        selectionState: selectionState(record?.selected), findingIds: [], observationIds: [],
      };
      addRecordDiagnostics({
        record, report, host, occurrenceId, group, placement, findingGroups, observationGroups,
        actions, healingPlan,
      });
      group.placements.push(placement);
    }
  }

  const definitionGroups = [...groups.values()].sort((a, b) => (
    a.host.localeCompare(b.host) || a.lifecyclePoint.localeCompare(b.lifecyclePoint) || a.behaviorId.localeCompare(b.behaviorId)
  ));
  const finalizeFinding = (finding) => ({
    ...finding,
    codes: [...finding.codes].sort(),
    categories: [...finding.categories].sort(),
    affectedOccurrenceIds: [...finding.affectedOccurrenceIds].sort(),
    placements: [...finding.placements].sort((a, b) => (
      a.host.localeCompare(b.host)
      || a.lifecyclePoint.localeCompare(b.lifecyclePoint)
      || a.occurrenceId.localeCompare(b.occurrenceId)
    )),
  });
  const sortFindings = (a, b) => (
    importanceRank(a.severity) - importanceRank(b.severity)
    || b.affectedDefinitions - a.affectedDefinitions
    || a.title.localeCompare(b.title)
    || a.findingId.localeCompare(b.findingId)
  );
  const findings = [...findingGroups.values()].map(finalizeFinding).sort(sortFindings);
  const observations = [...observationGroups.values()].map(finalizeFinding).sort(sortFindings);
  const configuredEntries = definitionGroups.reduce((count, group) => count + group.placements.length, 0);
  const evidenceLimits = [{
    code: 'static-not-runtime',
    text: 'Static configuration evidence does not establish execution success, host trust, consent, grants, or effective selection.',
  }];
  return {
    summary: {
      sourcesInspected, unreadableSources, configuredEntries,
      distinctBehaviors: definitionGroups.length,
      repeatedPlacements: Math.max(0, configuredEntries - definitionGroups.length),
      findingsNeedingAttention: findings.length, observations: observations.length,
      evidenceLimits: evidenceLimits.length,
    },
    definitionGroups, findings, observations, coverageByHost, evidenceLimits,
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
    const key = `${receipt.host}\0${receipt.verb}`;
    const row = hosts.get(key) ?? {
      host: receipt.host, lifecyclePoint: receipt.verb, executions: 0, successes: 0,
      failures: 0, timeouts: 0, durationMs: 0, stdoutBytes: 0, stderrBytes: 0, truncatedOutputs: 0,
    };
    row.executions += 1;
    row.successes += receipt.outcome === 'success' ? 1 : 0;
    row.failures += receipt.outcome === 'success' ? 0 : 1;
    row.timeouts += receipt.timedOut ? 1 : 0;
    row.durationMs = boundedInteger(row.durationMs + receipt.durationMs, Number.MAX_SAFE_INTEGER);
    row.stdoutBytes = boundedInteger(row.stdoutBytes + receipt.stdoutBytes, Number.MAX_SAFE_INTEGER);
    row.stderrBytes = boundedInteger(row.stderrBytes + receipt.stderrBytes, Number.MAX_SAFE_INTEGER);
    row.truncatedOutputs += receipt.stdoutTruncated || receipt.stderrTruncated ? 1 : 0;
    hosts.set(key, row);
  }
  return {
    executions: selected.length, failures, timeouts,
    model: {
      state: selected.length ? 'observed' : 'not-recorded',
      receiptsInspected: selected.length, receiptsTruncated: input.length > MAX_RECEIPTS,
      byHost: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host) || a.lifecyclePoint.localeCompare(b.lifecyclePoint)),
      recent: selected.slice(-MAX_RECENT),
    },
  };
}

export function buildHookDashboardReadModel({
  audit = null, receipts = [], healingPlan = null, sourceRef = null,
} = {}) {
  const facts = staticFacts(audit, { healingPlan, sourceRef });
  const runtime = runtimeFacts(receipts);
  return {
    schemaVersion: 3,
    summary: {
      ...facts.summary, executions: runtime.executions, failures: runtime.failures, timeouts: runtime.timeouts,
    },
    definitionGroups: facts.definitionGroups, findings: facts.findings, observations: facts.observations,
    coverageByHost: facts.coverageByHost, evidenceLimits: facts.evidenceLimits,
    runtime: runtime.model,
  };
}
