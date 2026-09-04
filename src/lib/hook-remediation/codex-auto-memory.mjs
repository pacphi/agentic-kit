import path from 'node:path';

import { sha256, stableJson } from '../hook-audit/common.mjs';
import {
  codexAutoMemoryHookSignature, hasAmbiguousCodexAutoMemoryHook,
  retireCodexAutoMemoryHooks,
} from '../hook-audit/codex-auto-memory.mjs';
import { inspectHookTarget } from './fs-port.mjs';

const DIAGNOSTIC = 'ruflo-auto-memory-import-not-idempotent';
const DIAGNOSTIC_CODES = Object.freeze([
  DIAGNOSTIC, 'ruflo-codex-stop-output-not-json',
]);

function jsonPointerFor(record) {
  return record.source.jsonPointer
    ?? `/hooks/${record.event}/${record.indices.group}/hooks/${record.indices.hook}`;
}

function diagnosticEvidence(record) {
  return record.diagnostics.find((diagnostic) => diagnostic.code === DIAGNOSTIC)?.evidence;
}

function verifiedEvidence(records) {
  if (records.length !== 2) return null;
  const evidence = records.map(diagnosticEvidence);
  const actions = evidence.map((item) => item?.action).sort();
  if (stableJson(actions) !== stableJson(['import', 'sync'])) return null;
  if (evidence.some((item) => !item?.signatureVerified || item.generatorVersion !== '3.38.21')
      || new Set(evidence.map((item) => item.helperDigest)).size !== 1
      || new Set(evidence.map((item) => item.manifestDigest)).size !== 1) return null;
  return evidence;
}

function inspectTarget(hostReport, records, options) {
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
  return { containmentRoot, document, first, snapshot, target };
}

function exactRetirement(records, document) {
  if (hasAmbiguousCodexAutoMemoryHook(document)) return null;
  for (const record of records) {
    const group = document?.hooks?.[record.event]?.[record.indices.group];
    const hook = group?.hooks?.[record.indices.hook];
    const matcher = group && Object.hasOwn(group, 'matcher') ? group.matcher : undefined;
    if (!codexAutoMemoryHookSignature(record.event, matcher, hook)) return null;
  }
  const retirement = retireCodexAutoMemoryHooks(document);
  if (retirement.removed.length !== 2) return null;
  const expectedPointers = records.map(jsonPointerFor).sort();
  const removedPointers = retirement.removed.map((item) => item.pointer).sort();
  if (stableJson(expectedPointers) !== stableJson(removedPointers)) return null;
  const candidateBytes = Buffer.from(`${JSON.stringify(retirement.document, null, 2)}\n`);
  const canonicalPreimage = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  return { candidateBytes, canonicalPreimage, expectedPointers, retirement };
}

function compileAction(hostReport, records, options) {
  if (options.platform === 'win32') return null;
  const evidence = verifiedEvidence(records);
  if (!evidence) return null;
  const targetState = inspectTarget(hostReport, records, options);
  if (!targetState) return null;
  const { containmentRoot, document, first, snapshot, target } = targetState;
  const exact = exactRetirement(records, document);
  if (!exact) return null;
  const { candidateBytes, canonicalPreimage, expectedPointers, retirement } = exact;
  if (!snapshot.bytes.equals(canonicalPreimage) || snapshot.sha256 === sha256(candidateBytes)) return null;
  const ownershipProven = snapshot.specialMode === 0
    && (typeof process.getuid !== 'function' || snapshot.uid === process.getuid());
  if (!ownershipProven) return null;
  const providerActions = (hostReport.plan ?? []).filter((proposal) => (
    path.resolve(proposal.target) === target && DIAGNOSTIC_CODES.includes(proposal.diagnostic)
  )).map((proposal) => proposal.id).sort();
  return {
    host: 'codex',
    recipeId: 'codex/project-json/ruflo-auto-memory-quarantine/v1',
    exactProfileId: hostReport.hostSchema.id,
    hostVersion: hostReport.observedVersion,
    classification: 'approval-required',
    executable: true,
    canonicalOwnership: {
      status: 'proven', ownerId: 'current-user-project',
      evidence: 'exact paired project projection; signed Ruflo 3.38.21 helper; current filesystem owner',
    },
    consumedProviderActionIds: providerActions,
    observedProjection: {
      file: target, sourceKind: first.source.sourceKind,
      occurrenceIds: records.map((record) => record.occurrenceId ?? record.rawFingerprint).sort(),
      pointers: expectedPointers,
      helperDigest: evidence[0].helperDigest,
      manifestDigest: evidence[0].manifestDigest,
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
    behaviorImpact: 'Quarantine the exact Codex-only Ruflo AutoMemory import and sync pair. This stops duplicate .claude-flow JSON bridge growth and removes a Stop handler with invalid output; Claude hooks, the signed helper, and native .swarm/agentdb-memory.db remain unchanged.',
    trustImpact: 'Codex definition review remains user-owned. Changed project hook bytes may require re-review on the next session.',
    activation: { restart: 'new-session', evidence: hostReport.hostSchema.evidence },
    rollback: 'Restore the transaction-specific exact project preimage only while the current digest still equals this action postimage.',
    verification: {
      provider: 'codex', diagnosticCodes: DIAGNOSTIC_CODES, sourceFile: target,
      findingKeys: records.map((record) => sha256(stableJson({
        host: 'codex', diagnostic: DIAGNOSTIC, target, pointer: jsonPointerFor(record),
      }))).sort(),
      method: 'exact-profile re-audit, second-plan no-op, then byte/mtime-stable repeat',
      trustState: 'not-mutated-by-agentic-kit; resulting host trust state is unobserved',
    },
    diff: [
      `--- ${target}`, `+++ ${target}`,
      ...retirement.removed.flatMap((item) => [
        `@@ ${item.pointer} @@`, `-signed Ruflo AutoMemory ${item.action} hook`,
      ]),
    ].join('\n'),
    candidateBytes,
  };
}

export function compileCodexAutoMemoryActions(hostReport, options) {
  if (hostReport.hostSchema?.confidence !== 'verified') return [];
  const eligible = (hostReport.records ?? []).filter((record) => (
    record.source?.sourceKind === 'project'
    && record.diagnostics?.some((diagnostic) => diagnostic.code === DIAGNOSTIC)
  ));
  const groups = new Map();
  for (const record of eligible) {
    groups.set(record.source.file, [...(groups.get(record.source.file) ?? []), record]);
  }
  return [...groups.values()]
    .map((group) => compileAction(hostReport, group, options))
    .filter(Boolean);
}
