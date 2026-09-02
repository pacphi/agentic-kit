import { auditCodexHooks } from './index.mjs';
import { auditClaudeHooks } from './providers/claude.mjs';
import { auditOpenCodeHooks } from './providers/opencode.mjs';
import { auditExternalHooks } from './providers/external.mjs';
import { loadUpstreamConstraints } from './upstream.mjs';

export const BUILTIN_HOOK_AUDIT_HOSTS = Object.freeze(['codex', 'claude', 'opencode', 'external']);

function requestedHosts(hosts) {
  const values = Array.isArray(hosts) && hosts.length ? hosts : ['codex'];
  const expanded = values.includes('all') ? BUILTIN_HOOK_AUDIT_HOSTS : values;
  const unique = [...new Set(expanded)];
  const unknown = unique.filter((host) => !BUILTIN_HOOK_AUDIT_HOSTS.includes(host));
  if (unknown.length) throw new TypeError(`unknown hook audit host(s): ${unknown.join(', ')}`);
  return BUILTIN_HOOK_AUDIT_HOSTS.filter((host) => unique.includes(host));
}

function codexReport(options) {
  const report = auditCodexHooks(options);
  const plan = report.plan.map((action) => ({
    ...action,
    legacyClassification: action.classification,
    classification: action.classification === 'never-automatic'
      ? 'prohibited'
      : action.classification === 'automatic' ? 'automatic-eligible' : action.classification,
  }));
  const gaps = [
    'Runtime trust hashes and project trust are intentionally not inferred',
    'Managed and inline TOML layers are reported by the Codex provider only when statically parseable',
  ];
  return {
    ...report, host: 'codex', schemaVersion: 2, plan,
    coverage: report.coverage ?? { status: 'partial', gaps },
    summary: { ...report.summary, coverage: report.coverage?.status ?? 'partial' },
    issues: report.issues ?? report.pluginIssues ?? [],
  };
}

/** Run deterministic host providers. This function never executes hook code. */
/**
 * @param {{hosts?:string[],projectRoots?:string[],versions?:Record<string,string>,config?:any,
 * codex?:any,claude?:any,opencode?:any,external?:any,upstream?:any}} options
 */
export function auditHooks({
  hosts, projectRoots = [process.cwd()], versions = {}, config = {},
  codex = {}, claude = {}, opencode = {}, external = {}, upstream = {},
} = /** @type {any} */ ({})) {
  const selected = requestedHosts(hosts);
  const reports = {};
  if (selected.includes('codex')) reports.codex = codexReport({ ...codex, projectRoots, codexVersion: versions.codex ?? codex.codexVersion ?? 'unknown' });
  if (selected.includes('claude')) reports.claude = auditClaudeHooks({ ...claude, projectRoots, claudeVersion: versions.claude ?? claude.claudeVersion ?? 'unknown' });
  if (selected.includes('opencode')) reports.opencode = auditOpenCodeHooks({
    ...opencode, projectRoots, opencodeVersion: versions.opencode ?? opencode.opencodeVersion ?? 'unknown',
    ownership: opencode.ownership ?? config?.integrations?.ownership?.opencode ?? null,
  });
  if (selected.includes('external')) reports.external = auditExternalHooks({ ...external, config });
  const constraints = loadUpstreamConstraints(upstream);
  const totals = Object.values(reports).reduce((summary, report) => ({
    sources: summary.sources + report.summary.sources,
    invalidSources: summary.invalidSources + report.summary.invalidSources,
    configurationIssues: summary.configurationIssues + report.summary.configurationIssues,
    hookOccurrences: summary.hookOccurrences + report.summary.hookOccurrences,
    uniqueBehaviors: summary.uniqueBehaviors + report.summary.uniqueBehaviors,
    automaticActions: summary.automaticActions + report.summary.automaticActions,
    approvalRequiredActions: summary.approvalRequiredActions + report.summary.approvalRequiredActions,
    neverAutomaticActions: summary.neverAutomaticActions + report.summary.neverAutomaticActions,
    upstreamRequiredActions: summary.upstreamRequiredActions + (/** @type {any} */ (report.summary).upstreamRequiredActions ?? 0),
  }), {
    sources: 0, invalidSources: 0, configurationIssues: 0, hookOccurrences: 0,
    uniqueBehaviors: 0, automaticActions: 0, approvalRequiredActions: 0,
    neverAutomaticActions: 0, upstreamRequiredActions: 0,
  });
  return {
    schemaVersion: 2, mode: 'read-only', hosts: selected, reports,
    upstream: constraints,
    maintenance: {
      schemaStrategy: 'exact-version evidence profiles; unknown versions receive syntax-only validation and no automatic healing',
      releaseStrategy: 're-audit on host or dependency release, weekly for open constraints, and before every managed upgrade',
      notificationStrategy: 'open or refresh upstream issues with minimal reproductions; retain bounded workarounds until a released artifact passes conformance',
    },
    summary: totals,
  };
}
