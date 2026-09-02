// Pure, fail-closed planning for one user-owned Codex plugin setting. This
// module transforms bytes in memory only; the transaction engine owns writes.
import path from 'node:path';

import { sha256, stableJson } from '../hook-audit/common.mjs';
import { inspectCodexTomlStructure, isTomlTableLine } from '../codex-toml-safety.mjs';
import { inspectHookTarget } from './fs-port.mjs';

const COMPANION_REF = 'codex@openai-codex';
const DIAGNOSTIC = 'claude-companion-enabled-in-codex';
const VERIFIED_PLUGIN_VERSION = '1.0.6';
const VERIFIED_POLICY_DATE = '2026-09-02';
const VERIFIED_POLICY_REVISION = 'db52e28f4d9ded852ab3942cea316258ae4ef346';

function targetTable(header) {
  return /^[\t ]*\[[\t ]*plugins[\t ]*\.[\t ]*(?:"codex@openai-codex"|'codex@openai-codex')[\t ]*\][\t ]*(?:#[^\r\n]*)?(?:\r?\n|$)$/.test(header);
}

/** Replace only one canonical `enabled = true` scalar in the exact plugin table. */
export function disableClaudeCompanionInCodexToml(source) {
  const structure = inspectCodexTomlStructure(source);
  if (!structure.valid) return null;
  const headers = structure.lines.filter((line) => line.live && isTomlTableLine(line.text));
  const selected = headers
    .map((header, index) => ({
      header,
      bodyStart: header.end,
      bodyEnd: headers[index + 1]?.start ?? source.length,
    }))
    .filter(({ header }) => targetTable(header.text));
  if (selected.length !== 1) return null;

  const [{ bodyStart, bodyEnd }] = selected;
  const bodyLines = structure.lines.filter((line) => line.live
    && line.start >= bodyStart && line.start < bodyEnd);
  const assignments = bodyLines.filter((line) => /^[\t ]*(?:enabled|"enabled"|'enabled')[\t ]*=/.test(line.text));
  const enabled = bodyLines.map((line) => ({
    line,
    match: /^([\t ]*enabled[\t ]*=[\t ]*)true([\t ]*(?:#[^\r\n]*)?)$/.exec(line.text),
  })).filter(({ match }) => match);
  if (assignments.length !== 1 || enabled.length !== 1) return null;

  const [{ line, match }] = enabled;
  const start = line.start + match[1].length;
  const end = start + 'true'.length;
  return {
    candidate: `${source.slice(0, start)}false${source.slice(end)}`,
    pointer: `/plugins/${COMPANION_REF.replaceAll('~', '~0').replaceAll('/', '~1')}/enabled`,
  };
}

function placementEvidence(hostReport, proposal) {
  const configuration = hostReport.pluginConfiguration;
  const findings = (hostReport.pluginFindings ?? []).filter((finding) => (
    finding.code === DIAGNOSTIC && finding.ref === COMPANION_REF
  ));
  if (configuration?.present !== true || configuration.status !== 'valid') return null;
  if (configuration.viaSymlink === true) return null;
  if (typeof configuration.file !== 'string' || !Array.isArray(configuration.enabled)) return null;
  if (!configuration.enabled.includes(COMPANION_REF) || findings.length !== 1) return null;
  const [finding] = findings;
  if (proposal.policyId !== finding.policyId || proposal.evidence !== finding.evidence) return null;
  if (proposal.policyVersion !== VERIFIED_PLUGIN_VERSION
      || proposal.pluginVersion !== VERIFIED_PLUGIN_VERSION
      || finding.policyVersion !== VERIFIED_PLUGIN_VERSION
      || finding.pluginVersion !== VERIFIED_PLUGIN_VERSION) return null;
  if (proposal.policyVerifiedAt !== VERIFIED_POLICY_DATE
      || finding.policyVerifiedAt !== VERIFIED_POLICY_DATE) return null;
  if (proposal.policyRevision !== VERIFIED_POLICY_REVISION
      || finding.policyRevision !== VERIFIED_POLICY_REVISION) return null;
  if (proposal.sourceDigest !== configuration.digest) return null;
  if (path.resolve(proposal.target) !== path.resolve(configuration.file)) return null;
  return { configuration, finding };
}

/** Compile the misplaced Claude companion finding into an exact, private action draft. */
export function compileCodexPluginActions(hostReport, options = {}) {
  if (options.platform === 'win32' || hostReport.hostSchema?.confidence !== 'verified') return [];
  const proposals = (hostReport.plan ?? []).filter((proposal) => (
    proposal.diagnostic === DIAGNOSTIC && proposal.pluginRef === COMPANION_REF
  ));
  if (proposals.length !== 1) return [];
  const proposal = proposals[0];
  if (!placementEvidence(hostReport, proposal)) return [];
  const target = path.resolve(proposal.target);
  if (path.basename(target) !== 'config.toml') return [];
  const containmentRoot = path.dirname(target);
  let snapshot;
  try { snapshot = inspectHookTarget(target, containmentRoot, options); } catch { return []; }
  if (snapshot.sha256 !== proposal.sourceDigest) return [];
  const source = snapshot.bytes.toString('utf8');
  if (!snapshot.bytes.equals(Buffer.from(source))) return [];
  const patch = disableClaudeCompanionInCodexToml(source);
  if (!patch) return [];
  const candidateBytes = Buffer.from(patch.candidate);
  if (snapshot.sha256 === sha256(candidateBytes)) return [];
  const ownershipProven = snapshot.specialMode === 0
    && (typeof process.getuid !== 'function' || snapshot.uid === process.getuid());
  if (!ownershipProven) return [];

  return [{
    host: 'codex',
    recipeId: 'codex/user-toml/claude-companion-disable/v1',
    exactProfileId: hostReport.hostSchema.id,
    hostVersion: hostReport.observedVersion,
    classification: 'approval-required',
    executable: true,
    canonicalOwnership: {
      status: 'proven', ownerId: 'current-user',
      evidence: 'direct-user-source-and-filesystem-owner',
    },
    consumedProviderActionIds: [proposal.id],
    observedProjection: {
      file: target, sourceKind: 'codex-user-plugin-config',
      pluginRef: COMPANION_REF, pointers: [patch.pointer],
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
    behaviorImpact: `Disable ${COMPANION_REF} only in Codex. Preserve its installation, plugin cache, and separate Claude Code enablement; a new Codex session is required.`,
    trustImpact: 'Codex plugin configuration remains user-owned; agentic-kit does not mutate hook trust or approval state.',
    activation: { restart: 'new-session', evidence: proposal.evidence },
    rollback: 'Restore the transaction-specific exact config.toml preimage only while the current digest still equals this action postimage.',
    verification: {
      kind: 'codex-plugin-placement', provider: 'codex',
      diagnosticCodes: [DIAGNOSTIC], pluginRef: COMPANION_REF, sourceFile: target,
      findingKeys: [sha256(stableJson({
        host: 'codex', diagnostic: DIAGNOSTIC, target, pluginRef: COMPANION_REF,
      }))],
      method: 'exact-profile re-audit, plugin-placement finding removal, second-plan no-op, then byte/mtime-stable repeat',
      trustState: 'not-mutated-by-agentic-kit; resulting host trust state is unobserved',
    },
    diff: [
      `--- ${target}`, `+++ ${target}`, `@@ ${patch.pointer} @@`, '-true', '+false',
    ].join('\n'),
    candidateBytes,
  }];
}
