// Pure remediation planning. Provider policies may transform bytes in memory,
// but this module never creates directories, receipts, backups, or target files.
import path from 'node:path';

import { sha256, stableJson, stableValue } from '../hook-audit/common.mjs';
import {
  legacyRufloProjectHookSignature, retireLegacyRufloProjectHooks,
} from '../hook-audit/codex-legacy.mjs';
import { inspectHookTarget } from './fs-port.mjs';

export const HOOK_HEAL_PLAN_SCHEMA = 'hook-heal-plan/v1';
export const HOOK_HEAL_CLASSES = Object.freeze([
  'safe-automatic', 'approval-required', 'upstream-required', 'never-automatic',
]);

const PROVIDER_POLICIES = Object.freeze({
  codex: Object.freeze({
    sourceKind: 'global', authority: 'user-owned',
    diagnostic: 'session-end-timeout-clamped', maximum: 3,
    recipeId: 'codex/global-json/session-end-timeout/v1', activation: 'new-session',
    behaviorImpact: 'No effective runtime change: Codex already clamps each selected SessionEnd timeout to 3 seconds under the exact verified profile.',
    trustImpact: 'Codex definition review remains user-owned and may be required after the bytes change.',
  }),
  claude: Object.freeze({
    version: '2.1.258', sourceKind: 'global', authority: 'user-owned',
    diagnostic: 'sessionend-timeout-clamped', maximum: 60,
    recipeId: 'claude/global-json/session-end-timeout/v1', activation: 'new-session',
    behaviorImpact: 'No effective runtime change: Claude already clamps the selected settings-level SessionEnd timeout to 60 seconds under the exact verified profile.',
    trustImpact: 'Claude permission, managed-policy, and review state remain separate and may require user review after the bytes change.',
  }),
  opencode: Object.freeze({ version: '1.18.25', executableRecipes: false }),
  external: Object.freeze({ executableRecipes: false }),
});

function publicAction(action) {
  const result = { ...action };
  delete result.candidateBytes;
  return stableValue(result);
}

function actionIdentity(action) {
  const result = publicAction(action);
  delete result.id;
  return result;
}

function actionIdFor(action) {
  const prefix = action.executable ? 'hook-heal' : 'hook-review';
  return `${prefix}-${sha256(stableJson(actionIdentity(action))).slice(0, 24)}`;
}

function withActionId(action) {
  return { ...action, id: actionIdFor(action) };
}

function planIdentity(plan) {
  return stableValue({
    schemaVersion: plan.schemaVersion,
    auditId: plan.auditId,
    hosts: plan.hosts,
    runtimeVersions: plan.runtimeVersions,
    actions: plan.actions.map(publicAction),
    summary: plan.summary,
    upstream: plan.upstream,
  });
}

function jsonPointerFor(record) {
  return record.source.jsonPointer
    ?? `/hooks/${record.event}/${record.indices.group}/hooks/${record.indices.hook}`;
}

function recordsForPolicy(hostReport, policy) {
  if (hostReport.hostSchema?.confidence !== 'verified') return [];
  return hostReport.records.filter((record) => (
    record.source?.sourceKind === policy.sourceKind
    && record.source?.authority === policy.authority
    && record.source?.generatedStatus === 'direct'
    && record.diagnostics?.some((diagnostic) => diagnostic.code === policy.diagnostic)
    && record.timeout?.status === 'clamped'
  ));
}

function selectedRufloReplacement(hostReport) {
  const sources = (hostReport.sources ?? []).filter((source) => (
    source.status === 'valid'
    && source.kind.startsWith('plugin-cache')
    && source.pluginRef === 'ruflo-core@ruflo'
  ));
  const sourceFiles = new Set(sources.map((source) => source.file));
  const selectedRecords = (hostReport.records ?? []).filter((record) => (
    record.scope?.pluginRef === 'ruflo-core@ruflo'
    && sourceFiles.has(record.source?.file)
  ));
  if (!sources.length || !selectedRecords.length) return null;
  return {
    pluginRef: 'ruflo-core@ruflo',
    pluginVersions: [...new Set(selectedRecords.map((record) => record.scope.pluginVersion).filter(Boolean))].sort(),
    sourceDigests: [...new Set(sources.map((source) => source.digest).filter(Boolean))].sort(),
    coveredEvents: [...new Set(selectedRecords.map((record) => record.event))].sort(),
  };
}

function hasAmbiguousLegacyHelper(document) {
  for (const [event, groups] of Object.entries(document?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      const matcher = Object.hasOwn(group, 'matcher') ? group.matcher : undefined;
      for (const hook of group.hooks) {
        if (typeof hook?.command !== 'string' || !hook.command.includes('.claude/helpers/hook-handler.cjs')) continue;
        if (!legacyRufloProjectHookSignature(event, matcher, hook)) return true;
      }
    }
  }
  return false;
}

function compileLegacyRufloRetirementAction(hostReport, records, options) {
  if (options.platform === 'win32') return null;
  const replacementEvidence = selectedRufloReplacement(hostReport);
  if (!replacementEvidence) return null;
  const first = records[0];
  const target = path.resolve(first.source.file);
  const source = hostReport.sources.find((candidate) => path.resolve(candidate.file) === target);
  if (!source || source.status !== 'valid' || source.kind !== 'project'
      || path.extname(target).toLowerCase() !== '.json') return null;
  if (!records.every((record) => record.source.digest === first.source.digest)) return null;
  const containmentRoot = path.resolve(first.scope?.projectPath ?? first.source.baseDir);
  let snapshot;
  try { snapshot = inspectHookTarget(target, containmentRoot, options); } catch { return null; }
  if (snapshot.sha256 !== first.source.digest) return null;
  let document;
  try { document = JSON.parse(snapshot.bytes.toString('utf8')); } catch { return null; }
  if (hasAmbiguousLegacyHelper(document)) return null;
  const retirement = retireLegacyRufloProjectHooks(document);
  if (!retirement.removed.length || retirement.removed.length !== records.length) return null;
  const expectedPointers = records.map(jsonPointerFor).sort();
  const removedPointers = retirement.removed.map((item) => item.pointer).sort();
  if (stableJson(expectedPointers) !== stableJson(removedPointers)) return null;
  const candidateBytes = Buffer.from(`${JSON.stringify(retirement.document, null, 2)}\n`);
  const canonicalPreimage = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  if (!snapshot.bytes.equals(canonicalPreimage) || snapshot.sha256 === sha256(candidateBytes)) return null;
  const ownershipProven = snapshot.specialMode === 0
    && (typeof process.getuid !== 'function' || snapshot.uid === process.getuid());
  if (!ownershipProven) return null;
  const providerActions = (hostReport.plan ?? []).filter((proposal) => (
    path.resolve(proposal.target) === target
    && ['legacy-ruflo-project-hook', 'session-end-timeout-clamped'].includes(proposal.diagnostic)
  )).map((proposal) => proposal.id).sort();
  const diagnostic = 'legacy-ruflo-project-hook';
  return withActionId({
    host: 'codex',
    recipeId: 'codex/project-json/legacy-ruflo-claude-projection-retirement/v1',
    exactProfileId: hostReport.hostSchema.id,
    hostVersion: hostReport.observedVersion,
    classification: 'approval-required',
    executable: true,
    canonicalOwnership: {
      status: 'proven',
      ownerId: 'current-user-project',
      evidence: 'direct-project-source-and-filesystem-owner; generator provenance remains unresolved',
    },
    replacementEvidence,
    consumedProviderActionIds: providerActions,
    observedProjection: {
      file: target,
      sourceKind: first.source.sourceKind,
      occurrenceIds: records.map((record) => record.occurrenceId ?? record.rawFingerprint).sort(),
      pointers: expectedPointers,
    },
    canonicalTarget: { file: target, containmentRoot },
    expectedPreimage: {
      sha256: snapshot.sha256, size: snapshot.size,
      mode: snapshot.mode, modeSupported: snapshot.modeSupported,
      uid: snapshot.uid, gid: snapshot.gid, specialMode: snapshot.specialMode,
      parent: snapshot.parent,
    },
    desiredPostimage: {
      sha256: sha256(candidateBytes), size: candidateBytes.length,
      mode: snapshot.mode, modeSupported: snapshot.modeSupported,
    },
    behaviorImpact: `Retire ${retirement.removed.length} recognized incompatible legacy Ruflo project hook occurrence(s); preserve AutoMemory, unrelated hook groups, and top-level project data. The selected Ruflo plugin covers only ${replacementEvidence.coveredEvents.join(', ')}; removed SessionStart, prompt-routing, and subagent side effects are not asserted to have feature-for-feature replacements.`,
    trustImpact: 'Codex definition review remains user-owned. Changed bytes and shifted handler indexes may require re-review; agentic-kit does not change trust state.',
    activation: { restart: 'new-session', evidence: hostReport.hostSchema.evidence },
    rollback: 'Restore the transaction-specific exact project preimage only while the current digest still equals this action postimage.',
    verification: {
      provider: 'codex', diagnosticCodes: [diagnostic], sourceFile: target,
      findingKeys: records.map((record) => sha256(stableJson({
        host: 'codex', diagnostic, target, pointer: jsonPointerFor(record),
      }))).sort(),
      method: 'exact-profile re-audit, second-plan no-op, then byte/mtime-stable repeat',
      trustState: 'not-mutated-by-agentic-kit; resulting host trust state is unobserved',
    },
    diff: [
      `--- ${target}`, `+++ ${target}`,
      ...retirement.removed.flatMap((item) => [
        `@@ ${item.pointer} @@`, `-recognized legacy Ruflo Claude helper (${item.action})`,
      ]),
    ].join('\n'),
    candidateBytes,
  });
}

function compileLegacyRufloActions(hostReport, options) {
  if (hostReport.hostSchema?.confidence !== 'verified') return [];
  const eligible = (hostReport.records ?? []).filter((record) => (
    record.source?.sourceKind === 'project'
    && record.diagnostics?.some((diagnostic) => diagnostic.code === 'legacy-ruflo-project-hook')
  ));
  const groups = new Map();
  for (const record of eligible) {
    groups.set(record.source.file, [...(groups.get(record.source.file) ?? []), record]);
  }
  return [...groups.values()]
    .map((group) => compileLegacyRufloRetirementAction(hostReport, group, options))
    .filter(Boolean);
}

function compileJsonTimeoutAction(host, hostReport, records, policy, options) {
  if (options.platform === 'win32') return null;
  const first = records[0];
  const target = path.resolve(first.source.file);
  const source = hostReport.sources.find((candidate) => path.resolve(candidate.file) === target);
  if (!source || source.status !== 'valid' || path.extname(target).toLowerCase() !== '.json') return null;
  if (!records.every((record) => record.source.digest === first.source.digest)) return null;
  const containmentRoot = path.resolve(first.source.baseDir ?? source.baseDir ?? path.dirname(target));
  let snapshot;
  try { snapshot = inspectHookTarget(target, containmentRoot, options); } catch { return null; }
  if (snapshot.sha256 !== first.source.digest) return null;
  let document;
  try { document = JSON.parse(snapshot.bytes.toString('utf8')); } catch { return null; }
  const changes = [];
  for (const record of records) {
    const hook = document?.hooks?.[record.event]?.[record.indices.group]?.hooks?.[record.indices.hook];
    if (!hook || typeof hook.timeout !== 'number' || record.timeout.maximum !== policy.maximum) return null;
    changes.push({ pointer: jsonPointerFor(record), before: hook.timeout, after: policy.maximum });
    hook.timeout = policy.maximum;
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const canonicalPreimage = Buffer.from(`${JSON.stringify(JSON.parse(snapshot.bytes.toString('utf8')), null, 2)}\n`);
  if (!snapshot.bytes.equals(canonicalPreimage)) return null;
  if (snapshot.sha256 === sha256(candidateBytes)) return null;
  const providerActions = hostReport.plan.filter((proposal) => (
    path.resolve(proposal.target) === target && proposal.diagnostic === policy.diagnostic
  )).map((proposal) => proposal.id).sort();
  const ownershipProven = snapshot.specialMode === 0
    && (typeof process.getuid !== 'function' || snapshot.uid === process.getuid());
  if (!ownershipProven) return null;
  const findingKeys = records.map((record) => sha256(stableJson({
    host, diagnostic: policy.diagnostic, target, pointer: jsonPointerFor(record),
  }))).sort();
  return withActionId({
    host,
    recipeId: policy.recipeId,
    exactProfileId: hostReport.hostSchema.id,
    hostVersion: hostReport.observedVersion,
    classification: 'approval-required',
    executable: true,
    canonicalOwnership: {
      status: 'proven',
      ownerId: 'current-user', evidence: 'direct-user-source-and-filesystem-owner',
    },
    consumedProviderActionIds: providerActions,
    observedProjection: {
      file: target, sourceKind: first.source.sourceKind,
      occurrenceIds: records.map((record) => record.occurrenceId ?? record.rawFingerprint).sort(),
      pointers: changes.map((change) => change.pointer).sort(),
    },
    canonicalTarget: { file: target, containmentRoot },
    expectedPreimage: {
      sha256: snapshot.sha256, size: snapshot.size,
      mode: snapshot.mode, modeSupported: snapshot.modeSupported,
      uid: snapshot.uid, gid: snapshot.gid, specialMode: snapshot.specialMode,
      parent: snapshot.parent,
    },
    desiredPostimage: {
      sha256: sha256(candidateBytes), size: candidateBytes.length,
      mode: snapshot.mode, modeSupported: snapshot.modeSupported,
    },
    behaviorImpact: policy.behaviorImpact,
    trustImpact: policy.trustImpact,
    activation: { restart: policy.activation, evidence: hostReport.hostSchema.evidence },
    rollback: 'Restore the transaction-specific exact preimage only while the current digest still equals this action postimage.',
    verification: {
      provider: host, diagnosticCodes: [policy.diagnostic], sourceFile: target,
      findingKeys,
      method: 'exact-profile re-audit, second-plan no-op, then byte/mtime-stable repeat',
      trustState: 'not-mutated-by-agentic-kit; resulting host trust state is unobserved',
    },
    diff: [
      `--- ${target}`, `+++ ${target}`,
      ...changes.flatMap((change) => [
        `@@ ${change.pointer}/timeout @@`, `-${change.before}`, `+${change.after}`,
      ]),
    ].join('\n'),
    candidateBytes,
  });
}

function compileProvider(host, hostReport, options) {
  const policy = PROVIDER_POLICIES[host];
  if (!policy || policy.executableRecipes === false) return [];
  const eligible = recordsForPolicy(hostReport, policy);
  const groups = new Map();
  for (const record of eligible) {
    const key = record.source.file;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const timeoutActions = [...groups.values()]
    .map((records) => compileJsonTimeoutAction(host, hostReport, records, policy, options))
    .filter(Boolean);
  return host === 'codex'
    ? [...timeoutActions, ...compileLegacyRufloActions(hostReport, options)]
    : timeoutActions;
}

function healingClassification(classification) {
  if (['automatic', 'automatic-eligible', 'safe-automatic'].includes(classification)) return 'safe-automatic';
  if (classification === 'approval-required') return 'approval-required';
  if (classification === 'upstream-required') return 'upstream-required';
  return 'never-automatic';
}

function fallbackActions(report, compiled) {
  const consumed = new Set(compiled.flatMap((action) => action.consumedProviderActionIds ?? []));
  const actions = [];
  for (const [host, hostReport] of Object.entries(report.reports ?? {})) {
    for (const proposal of hostReport.plan ?? []) {
      if (consumed.has(proposal.id)) continue;
      const draft = {
        host,
        hostVersion: hostReport.observedVersion ?? 'unknown',
        providerActionId: proposal.id,
        classification: healingClassification(proposal.classification),
        executable: false,
        target: proposal.target,
        exactProfileId: hostReport.hostSchema?.confidence === 'verified' ? hostReport.hostSchema.id : null,
        schemaConfidence: hostReport.hostSchema?.confidence ?? 'unknown',
        canonicalOwnership: { status: 'unproven' },
        findingKey: sha256(stableJson({
          host, diagnostic: proposal.diagnostic ?? 'unknown',
          target: proposal.target, providerActionId: proposal.id,
        })),
        reason: proposal.reason,
        behaviorImpact: proposal.behaviorImpact ?? 'unknown; no bounded mutation recipe was compiled',
        trustImpact: proposal.trustImpact ?? 'unknown; no trust state is inferred or changed',
        rollback: null,
        diff: null,
      };
      actions.push(withActionId(draft));
    }
  }
  return actions;
}

function summarize(actions) {
  const count = (classification) => actions.filter((action) => action.classification === classification).length;
  return {
    total: actions.length,
    executable: actions.filter((action) => action.executable).length,
    safeAutomatic: count('safe-automatic'),
    approvalRequired: count('approval-required'),
    upstreamRequired: count('upstream-required'),
    neverAutomatic: count('never-automatic'),
  };
}

function publicUpstream(upstream = {}) {
  return stableValue({
    status: upstream.status ?? 'absent',
    registryStatus: upstream.registryStatus ?? null,
    evidenceStatus: upstream.evidenceStatus ?? null,
    lastVerifiedAt: upstream.lastVerifiedAt ?? null,
    recheckPolicy: upstream.recheckPolicy ?? null,
    dependencyPolicies: upstream.dependencyPolicies ?? [],
    constraints: upstream.constraints ?? [],
    errors: upstream.errors ?? [],
    issuePublication: 'payload-preparation-only; explicit user approval is required before opening or updating an issue',
  });
}

export function recomputeHookHealingPlanDigest(plan) {
  return sha256(stableJson(planIdentity(plan)));
}

export function assertHookHealingPlanIntegrity(plan) {
  if (!plan || plan.schemaVersion !== HOOK_HEAL_PLAN_SCHEMA) throw new Error('unsupported hook healing plan schema');
  if (!Array.isArray(plan.actions) || !Array.isArray(plan.hosts)) throw new Error('hook healing plan shape is invalid');
  const ids = new Set();
  for (const action of plan.actions) {
    if (!HOOK_HEAL_CLASSES.includes(action.classification)) throw new Error(`invalid action classification: ${action.classification}`);
    if (action.id !== actionIdFor(action) || ids.has(action.id)) throw new Error(`action identity is invalid: ${action.id}`);
    ids.add(action.id);
    if (action.executable) {
      if (!Buffer.isBuffer(action.candidateBytes)) throw new Error(`executable action has no private candidate bytes: ${action.id}`);
      if (sha256(action.candidateBytes) !== action.desiredPostimage?.sha256) throw new Error(`candidate digest mismatch: ${action.id}`);
      if (!path.isAbsolute(action.canonicalTarget?.file ?? '')
          || !path.isAbsolute(action.canonicalTarget?.containmentRoot ?? '')) {
        throw new Error(`executable action paths are invalid: ${action.id}`);
      }
      if (action.canonicalOwnership?.status !== 'proven'
          || !action.exactProfileId || !action.hostVersion
          || !action.expectedPreimage?.sha256 || !action.desiredPostimage?.sha256) {
        throw new Error(`executable action evidence is incomplete: ${action.id}`);
      }
    }
  }
  const expected = recomputeHookHealingPlanDigest(plan);
  if (plan.planDigest !== expected) throw new Error('hook healing plan digest is invalid');
  return true;
}

export function buildHookHealingPlan({ report, fsImpl, platform = process.platform } = /** @type {any} */ ({})) {
  if (!report || report.mode !== 'read-only') throw new TypeError('a read-only hook audit report is required');
  const options = { fsImpl, platform };
  const compiled = Object.entries(report.reports ?? {}).flatMap(([host, hostReport]) => (
    compileProvider(host, hostReport, options)
  ));
  const actions = [...compiled, ...fallbackActions(report, compiled)].sort((a, b) => a.id.localeCompare(b.id));
  const plan = {
    schemaVersion: HOOK_HEAL_PLAN_SCHEMA,
    auditId: report.auditId ?? sha256(stableJson({ hosts: report.hosts, reports: report.reports })),
    hosts: [...report.hosts],
    runtimeVersions: stableValue(report.runtimeVersions ?? {}),
    actions,
    summary: summarize(actions),
    upstream: publicUpstream(report.upstream),
  };
  plan.planDigest = recomputeHookHealingPlanDigest(plan);
  return plan;
}

export function publicHookHealingPlan(plan) {
  assertHookHealingPlanIntegrity(plan);
  return stableValue({
    schemaVersion: plan.schemaVersion,
    auditId: plan.auditId,
    planDigest: plan.planDigest,
    hosts: plan.hosts,
    runtimeVersions: plan.runtimeVersions,
    actions: plan.actions.map(publicAction),
    summary: plan.summary,
    upstream: plan.upstream,
  });
}
