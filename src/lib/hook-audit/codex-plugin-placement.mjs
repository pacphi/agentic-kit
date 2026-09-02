import { sha256, stableJson } from './common.mjs';

/** Convert structured plugin-placement findings into read-only provider proposals. */
export function pluginPlacementPlan(plugins) {
  return (plugins.pluginFindings ?? []).map((finding) => ({
    id: `codex-plugin-placement-${sha256(stableJson({
      code: finding.code, ref: finding.ref, target: finding.configFile,
      sourceDigest: finding.configDigest, pluginVersion: finding.pluginVersion,
      policyRevision: finding.policyRevision,
    })).slice(0, 24)}`,
    diagnostic: finding.code,
    pluginRef: finding.ref,
    target: finding.configFile,
    sourceDigest: finding.configDigest,
    evidence: finding.evidence,
    policyId: finding.policyId,
    policyVersion: finding.policyVersion,
    policyRevision: finding.policyRevision,
    policyVerifiedAt: finding.policyVerifiedAt,
    pluginVersion: finding.pluginVersion,
    classification: 'approval-required',
    reason: 'the plugin is a Claude Code companion for invoking Codex, not a Codex-host plugin; user-owned plugin enablement requires explicit approval',
    behaviorImpact: 'Disable this plugin only in Codex while preserving its installation, cache, and separate Claude Code enablement.',
    trustImpact: 'Codex plugin configuration and hook trust remain user-owned; agentic-kit does not approve hook definitions.',
  }));
}

export function pluginAuditFacts(plugins) {
  const pluginIssues = [
    ...(plugins.configIssues ?? []),
    ...(plugins.placementIssues ?? []),
    ...(plugins.hookIssues ?? plugins.issues ?? []),
  ];
  return {
    pluginIssues,
    pluginFindings: plugins.pluginFindings ?? [],
    pluginConfiguration: {
      file: plugins.configFile,
      present: plugins.configPresent,
      status: plugins.configStatus,
      digest: plugins.configDigest,
      viaSymlink: plugins.configViaSymlink === true,
      enabled: plugins.enabled,
    },
  };
}
