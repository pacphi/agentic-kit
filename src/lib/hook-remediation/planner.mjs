// Pure remediation planning. Provider compilers may transform bytes in memory,
// but this module never creates directories, receipts, backups, or target files.
import fs from 'node:fs';
import path from 'node:path';

import { sha256, stableJson, stableValue } from '../hook-audit/common.mjs';
import { inspectHookTarget } from './fs-port.mjs';
import { replaceJsonNumbers } from './json-scalar-edit.mjs';

export const HOOK_HEAL_PLAN_SCHEMA = 'hook-heal-plan/v1';

function publicAction(action) {
  const result = { ...action };
  delete result.candidateBytes;
  return stableValue(result);
}

function planIdentity(plan) {
  return stableValue({
    schemaVersion: plan.schemaVersion,
    auditId: plan.auditId,
    hosts: plan.hosts,
    runtimeVersions: plan.runtimeVersions,
    actions: plan.actions.map(publicAction),
    summary: plan.summary,
  });
}

export function hookHealingPlanDigest(plan) {
  return sha256(stableJson(planIdentity(plan)));
}

function jsonPointerFor(record) {
  return record.source.jsonPointer
    ?? `/hooks/${record.event}/${record.indices.group}/hooks/${record.indices.hook}`;
}

function compileCodexJsonAction(report, records, { fsImpl = fs, platform = process.platform } = {}) {
  const first = records[0];
  const target = first.source.file;
  const source = report.sources.find((candidate) => candidate.file === target);
  if (!source || source.status !== 'valid') return null;
  if (report.hostSchema?.confidence !== 'verified' || report.observedVersion !== '0.151.0') return null;
  if (first.scope.kind !== 'global' || path.extname(target).toLowerCase() !== '.json') return null;
  let snapshot;
  try {
    snapshot = inspectHookTarget(target, path.dirname(target), { fsImpl, platform });
  } catch {
    return null;
  }
  const { bytes } = snapshot;
  if (sha256(bytes) !== first.source.digest) return null;
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  const changes = [];
  for (const record of records) {
    const hook = document?.hooks?.[record.event]?.[record.indices.group]?.hooks?.[record.indices.hook];
    if (!hook || typeof hook.timeout !== 'number') return null;
    const desired = record.timeout.maximum;
    if (!Number.isFinite(desired)) return null;
    changes.push({ pointer: jsonPointerFor(record), before: hook.timeout, after: desired });
  }
  const candidateBytes = replaceJsonNumbers(bytes, changes.map((change) => ({
    pointer: `${change.pointer}/timeout`, before: change.before, after: change.after,
  })));
  const mode = { mode: snapshot.mode, modeSupported: snapshot.modeSupported };
  const draft = {
    host: 'codex',
    recipeId: 'codex/global-json/session-end-timeout/v1',
    exactProfileId: report.hostSchema.id,
    classification: 'approval-required',
    executable: true,
    canonicalOwnership: {
      status: 'proven', ownerId: 'user', evidence: 'user-source',
    },
    observedProjection: {
      file: target, sourceKind: first.source.sourceKind,
      occurrenceIds: records.map((record) => record.occurrenceId).sort(),
      pointers: changes.map((change) => change.pointer).sort(),
    },
    canonicalTarget: { file: target, containmentRoot: path.dirname(target) },
    expectedPreimage: { sha256: first.source.digest, size: bytes.length, ...mode },
    desiredPostimage: { sha256: sha256(candidateBytes), size: candidateBytes.length, ...mode },
    behaviorImpact: 'No Codex runtime change: each requested SessionEnd timeout already clamps to 3 seconds; the stored definition is normalized to the verified bound.',
    trustImpact: 'Codex exact-definition review remains user-owned and may be required after the definition changes.',
    activation: { restart: 'session', evidence: report.hostSchema.evidence },
    rollback: 'Restore the transaction-specific exact preimage only while the current digest still equals this action postimage.',
    verification: {
      provider: 'codex', diagnosticCodes: ['session-end-timeout-clamped'],
      sourceFile: target, method: 'schema validation plus two complete read-only re-audits',
      effectiveBehavior: 'runtime clamp equivalence proven by the exact 0.151.0 profile; trust remains unobserved',
    },
    diff: [
      `--- ${target}`,
      `+++ ${target}`,
      ...changes.flatMap((change) => [
        `@@ ${change.pointer}/timeout @@`,
        `-${change.before}`,
        `+${change.after}`,
      ]),
    ].join('\n'),
    candidateBytes,
  };
  const idMaterial = publicAction(draft);
  return { ...draft, id: `hook-heal-${sha256(stableJson(idMaterial)).slice(0, 24)}` };
}

function compileCodex(report, options) {
  const eligible = report.records.filter((record) => (
    record.timeout?.status === 'clamped'
    && record.source?.sourceKind === 'global'
  ));
  const byFile = new Map();
  for (const record of eligible) {
    const records = byFile.get(record.source.file) ?? [];
    records.push(record);
    byFile.set(record.source.file, records);
  }
  return [...byFile.values()].map((records) => compileCodexJsonAction(report, records, options)).filter(Boolean);
}

function fallbackActions(report, compiled) {
  const compiledTargets = new Set(compiled.map((action) => `${action.host}\0${action.canonicalTarget.file}`));
  const actions = [];
  for (const [host, hostReport] of Object.entries(report.reports ?? {})) {
    for (const proposal of hostReport.plan ?? []) {
      if (compiledTargets.has(`${host}\0${proposal.target}`)) continue;
      const classification = proposal.classification ?? 'prohibited';
      const draft = {
        host,
        providerActionId: proposal.id,
        classification,
        executable: false,
        target: proposal.target,
        exactProfileId: hostReport.hostSchema?.confidence === 'verified' ? hostReport.hostSchema.id : null,
        canonicalOwnership: { status: 'unknown' },
        reason: proposal.reason,
        behaviorImpact: proposal.behaviorImpact ?? 'unknown; no mutation recipe was compiled',
        trustImpact: proposal.trustImpact ?? 'unknown',
        rollback: null,
        diff: null,
      };
      actions.push({ ...draft, id: `hook-review-${sha256(stableJson(draft)).slice(0, 24)}` });
    }
  }
  return actions;
}

function summarize(actions) {
  const count = (classification) => actions.filter((action) => action.classification === classification).length;
  return {
    total: actions.length,
    executable: actions.filter((action) => action.executable).length,
    safe: count('automatic-eligible'),
    approvalRequired: count('approval-required'),
    upstreamRequired: count('upstream-required'),
    prohibited: count('prohibited'),
  };
}

/** @param {any} options */
export function buildHookHealingPlan({ report, fsImpl = fs, platform = process.platform } = {}) {
  if (!report || report.mode !== 'read-only') throw new TypeError('a read-only hook audit report is required');
  const compiled = report.reports?.codex ? compileCodex(report.reports.codex, { fsImpl, platform }) : [];
  const actions = [...compiled, ...fallbackActions(report, compiled)].sort((a, b) => a.id.localeCompare(b.id));
  const plan = {
    schemaVersion: HOOK_HEAL_PLAN_SCHEMA,
    auditId: report.auditId,
    hosts: [...report.hosts],
    runtimeVersions: report.runtimeVersions ?? {},
    actions,
    summary: summarize(actions),
  };
  plan.planDigest = hookHealingPlanDigest(plan);
  return plan;
}

export function publicHookHealingPlan(plan) {
  return stableValue({
    schemaVersion: plan.schemaVersion,
    auditId: plan.auditId,
    planDigest: plan.planDigest,
    hosts: plan.hosts,
    runtimeVersions: plan.runtimeVersions,
    actions: plan.actions.map(publicAction),
    summary: plan.summary,
  });
}
