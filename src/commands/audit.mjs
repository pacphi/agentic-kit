// ak audit hooks — explicit, read-only configuration audit. It does not run
// hook commands, mutate trust, rewrite generated files, or edit plugin caches.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { auditHooks, BUILTIN_HOOK_AUDIT_HOSTS } from '../lib/hook-audit/orchestrator.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { projectCensus, projectsInScope } from '../lib/project-census.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  project: { type: 'string', multiple: true },
  host: { type: 'string', multiple: true },
  'all-projects': { type: 'boolean', default: false },
};

export const help = `ak audit hooks — read-only host-neutral hook inventory and remediation plan

Discovers Codex, Claude, OpenCode, and external-adapter hook definitions; normalizes
behavior; keeps compatibility separate from trust; and classifies possible
repairs. It never executes hooks, changes trust, or writes hook files.

Usage: ak audit hooks [options]

Options:
  --project PATH   add an explicit project (repeatable)
  --host HOST      audit codex, claude, opencode, external, or all (repeatable; default: codex)
  --all-projects   include Git projects in agentic-kit's bounded project census
  --json           emit the deterministic machine-readable report

Examples:
  ak audit hooks
  ak audit hooks --host all --project ../another-repo --json
  ak audit hooks --all-projects --json`;

function detectedVersion(binary, pattern = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/) {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return pattern.exec(result.stdout)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function selectedHosts(flags) {
  const hosts = flags.host?.length ? flags.host : ['codex'];
  const unknown = hosts.filter((host) => host !== 'all' && !BUILTIN_HOOK_AUDIT_HOSTS.includes(host));
  if (unknown.length) throw new TypeError(`unknown --host value(s): ${unknown.join(', ')}`);
  return hosts;
}

function includesHost(hosts, host) {
  return hosts.includes('all') || hosts.includes(host);
}

function projectRoots(flags) {
  const roots = new Set([process.cwd()]);
  for (const project of flags.project ?? []) roots.add(path.resolve(project));
  if (flags['all-projects']) {
    for (const project of projectsInScope(projectCensus(), 'gitRepos')) roots.add(project.path);
  }
  return [...roots].sort();
}

export async function run({
  flags,
  positionals,
  detectVersionFn = detectedVersion,
  loadConfigFn = loadKitConfig,
}) {
  if (positionals.length !== 1 || positionals[0] !== 'hooks') {
    console.error('ak audit requires the hooks subcommand');
    console.log(help);
    return 2;
  }
  let report;
  try {
    const hosts = selectedHosts(flags);
    report = auditHooks({
      hosts,
      projectRoots: projectRoots(flags),
      versions: {
        ...(includesHost(hosts, 'codex') ? { codex: detectVersionFn('codex') } : {}),
        ...(includesHost(hosts, 'claude') ? { claude: detectVersionFn('claude') } : {}),
        ...(includesHost(hosts, 'opencode') ? { opencode: detectVersionFn('opencode') } : {}),
      },
      config: includesHost(hosts, 'external') ? loadConfigFn() : {},
    });
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
