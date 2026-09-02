// ak audit hooks — explicit, read-only configuration audit. It does not run
// hook commands, mutate trust, rewrite generated files, or edit plugin caches.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { auditHooks, BUILTIN_HOOK_AUDIT_HOSTS } from '../lib/hook-audit/orchestrator.mjs';
import { buildContextAudit, selectedContextHosts } from '../lib/context-audit.mjs';
import { collectContextEvidence } from '../lib/context-audit-sources.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { projectCensus, projectsInScope } from '../lib/project-census.mjs';
import { installedVersion } from '../lib/versions.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  project: { type: 'string', multiple: true },
  host: { type: 'string', multiple: true },
  'all-projects': { type: 'boolean', default: false },
};

export const help = `ak audit — read-only hook and startup-context evidence

The hooks audit inventories static hook definitions and remediation authority. The
context audit measures agentic-kit guidance, bounded skill/MCP metadata, model-window
facts, and static hook counts without exposing raw content or executing hooks.

Usage:
  ak audit hooks [options]
  ak audit context [options]

Options:
  --project PATH   add an explicit project (repeatable)
  --host HOST      audit codex, claude, opencode, external, or all (repeatable)
  --all-projects   include Git projects in agentic-kit's bounded project census
  --json           emit the deterministic machine-readable report

Examples:
  ak audit hooks
  ak audit hooks --host all --project ../another-repo --json
  ak audit hooks --all-projects --json
  ak audit context --host all --json`;

export function detectedVersion(binary, pattern = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/) {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return pattern.exec(result.stdout)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function selectedHosts(flags) {
  const hosts = flags.host?.length ? flags.host : ['codex'];
  const unknown = hosts.filter((host) => host !== 'all' && !BUILTIN_HOOK_AUDIT_HOSTS.includes(host));
  if (unknown.length) throw new TypeError(`unknown --host value(s): ${unknown.join(', ')}`);
  return hosts;
}

function includesHost(hosts, host) {
  return hosts.includes('all') || hosts.includes(host);
}

export function projectRoots(flags) {
  const roots = new Set([process.cwd()]);
  for (const project of flags.project ?? []) roots.add(path.resolve(project));
  if (flags['all-projects']) {
    for (const project of projectsInScope(projectCensus(), 'gitRepos')) roots.add(project.path);
  }
  return [...roots].sort();
}

export function collectHookAudit({
  flags,
  detectVersionFn = detectedVersion,
  loadConfigFn = loadKitConfig,
  dependencyVersionFn = installedVersion,
}) {
  const hosts = selectedHosts(flags);
  return auditHooks({
    hosts,
    projectRoots: projectRoots(flags),
    versions: {
      ...(includesHost(hosts, 'codex') ? { codex: detectVersionFn('codex') } : {}),
      ...(includesHost(hosts, 'claude') ? { claude: detectVersionFn('claude') } : {}),
      ...(includesHost(hosts, 'opencode') ? { opencode: detectVersionFn('opencode') } : {}),
    },
    config: includesHost(hosts, 'external') ? loadConfigFn() : {},
    upstream: { observedVersions: Object.fromEntries([
      ['ruflo', 'ruflo'], ['agentic-qe', 'agentic-qe'], ['ruvnet-brain', 'ruvnet-brain'],
      ['ruvector', 'ruvector'], ['agentic-flow', 'agentic-flow'],
    ].map(([dependency, pkg]) => [dependency, dependencyVersionFn(pkg) ?? 'unknown'])) },
  });
}

export async function collectContextAudit({
  flags,
  pkgRoot,
  cwd = process.cwd(),
  loadConfigFn = loadKitConfig,
  hookCollectorFn = collectHookAudit,
  evidenceCollectorFn = collectContextEvidence,
}) {
  const hosts = selectedContextHosts(flags.host);
  const cfg = loadConfigFn();
  const hookAudit = hookCollectorFn({
    flags: { ...flags, host: hosts },
    loadConfigFn: () => cfg,
  });
  const evidence = await evidenceCollectorFn({ hosts, cfg, pkgRoot, cwd, hookAudit });
  return buildContextAudit({ hosts, evidence });
}

function contextExitCode(report) {
  return Object.values(report.reports).some((host) =>
    host.guidance.withinBudget === false
    || host.guidance.installations.some((entry) =>
      entry.state === 'duplicate-managed' || entry.state === 'stale-managed'
      || entry.upstreamOwned.some((upstream) => upstream.state !== 'single-managed'))) ? 1 : 0;
}

function tokenValue(fact) {
  return fact?.tokens ?? 'unknown';
}

function renderContextText(report) {
  console.log(`ak audit context (read-only: ${report.hosts.join(', ')})`);
  for (const host of report.hosts) {
    const item = report.reports[host];
    const guidanceBytes = item.guidance.bytes ?? 'unknown';
    const guidanceTokens = item.guidance.estimatedTokens?.tokens ?? 'unknown';
    console.log(`  ${host}: guidance ${guidanceBytes} B · ~${guidanceTokens} estimated tokens · ${item.guidance.status}`);
    console.log(`    window advertised ${tokenValue(item.modelWindow.advertised)} · host ${tokenValue(item.modelWindow.host)} · effective ${tokenValue(item.modelWindow.effective)} · compact ${tokenValue(item.modelWindow.autoCompact)}`);
    console.log(`    startup ${item.startup.state}${item.startup.startup?.level ? ` (${item.startup.startup.level})` : ''}`);
    console.log(`    skills ${item.skills.count ?? 'unknown'} · metadata bytes ${item.skills.metadataBytes ?? 'unknown'} · ${item.skills.status}`);
    console.log(`    MCP ${item.mcp.registrations ?? 'unknown'} registration(s) · config ${item.mcp.configBytes ?? 'unknown'} B · schemas ${item.mcp.schemaBytes ?? 'unknown'} B`);
    console.log(`    hooks ${item.hooks.occurrences ?? 'unknown'} occurrence(s), ${item.hooks.stopOccurrences ?? 'unknown'} Stop`);
    for (const installation of item.guidance.installations) {
      console.log(`    guidance ${installation.scope}: ${installation.state}`);
      for (const upstream of installation.upstreamOwned) {
        console.log(`      upstream ${upstream.owner}: ${upstream.blocks} block(s) · ${upstream.bytes ?? 'unknown'} B · ~${upstream.estimatedTokens?.tokens ?? 'unknown'} estimated tokens · ${upstream.state}`);
      }
    }
    console.log(`    source health: ${item.sourceHealth.overall}`);
  }
}

export async function run({
  flags, positionals, pkgRoot,
  detectVersionFn = detectedVersion,
  loadConfigFn = loadKitConfig,
  contextCollectorFn = collectContextAudit,
}) {
  if (positionals.length !== 1 || !['hooks', 'context'].includes(positionals[0])) {
    console.error('ak audit requires the hooks or context subcommand');
    console.log(help);
    return 2;
  }
  if (positionals[0] === 'context') {
    let report;
    try {
      report = await contextCollectorFn({ flags, pkgRoot, loadConfigFn });
    } catch (error) {
      console.error(`context audit failed: ${error.message}`);
      return 2;
    }
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else renderContextText(report);
    return contextExitCode(report);
  }
  let report;
  try {
    report = collectHookAudit({ flags, detectVersionFn, loadConfigFn });
  } catch (error) {
    console.error(`hook audit failed: ${error.message}`);
    return 2;
  }
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.summary.invalidSources || report.summary.configurationIssues ? 1 : 0;
  }

  const { summary } = report;
  console.log(`ak audit hooks (read-only: ${report.hosts.join(', ')})`);
  console.log(`  sources: ${summary.sources} (${summary.invalidSources} invalid)`);
  console.log(`  configuration issues: ${summary.configurationIssues}`);
  console.log(`  hooks: ${summary.hookOccurrences} occurrences / ${summary.uniqueBehaviors} behaviors`);
  console.log(`  remediation: ${summary.automaticActions} automatic, ${summary.approvalRequiredActions} approval-required, ${summary.neverAutomaticActions} never-automatic`);
  console.log('  trust: unchanged; every host permission/review decision remains separate');
  for (const host of report.hosts) {
    const hostReport = report.reports[host];
    console.log(`  ${host}: ${hostReport.summary.hookOccurrences} occurrence(s), ${hostReport.coverage.status} coverage`);
    for (const action of hostReport.plan) console.log(`    - [${action.classification}] ${action.target}: ${action.reason}`);
    for (const issue of hostReport.issues ?? []) console.log(`    - [configuration] ${issue}`);
  }
  return summary.invalidSources || summary.configurationIssues ? 1 : 0;
}
