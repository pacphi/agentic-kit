// Scaffold-agents drift — ADR-128 Phase 2 deleted 9 agents from ruflo init's
// template (each plugin is canonical since); any project scaffolded before
// ruflo 3.38.x carries the gap silently, and no upstream code revisits an
// existing scaffold. Detection here mirrors upstream's
// migrate-agent-detection.ts semantics exactly (basename anywhere under
// .claude/agents + owning-plugin coverage via ~/.claude/plugins/
// installed_plugins.json), spawn-free so status and the nudge can call it.
//
// The FIX is deliberately not ours: when the installed CLI ships
// `ruflo migrate fix --agents` (ruflo#2985 → PR #2986), sync delegates to it —
// upstream restores from canonical plugin content with namespace rewrite and
// provenance. Until that ships, the status row is advisory-only (no fix
// string, so it never enters sync's plan): a kit-side restore would fork
// content ADR-128 made plugin-canonical.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { run } from './exec.mjs';

/** Mirror of upstream REMOVED_AGENTS (src/commands/migrate.ts) — basename in
 *  the pre-ADR-128 init template, and the marketplace plugin that owns it now. */
export const REMOVED_AGENTS = [
  { basename: 'coder.md', plugin: 'ruflo-core' },
  { basename: 'researcher.md', plugin: 'ruflo-core' },
  { basename: 'reviewer.md', plugin: 'ruflo-core' },
  { basename: 'tester.md', plugin: 'ruflo-testgen' },
  { basename: 'memory-specialist.md', plugin: 'ruflo-rag-memory' },
  { basename: 'security-auditor.md', plugin: 'ruflo-security-audit' },
  { basename: 'sparc-orchestrator.md', plugin: 'ruflo-sparc' },
  { basename: 'goal-planner.md', plugin: 'ruflo-goals' },
  { basename: 'adr-architect.md', plugin: 'ruflo-adr' },
];

// Same shallow-tree depth guard as upstream's findBasename.
const MAX_AGENT_DIR_DEPTH = 6;

function hasBasename(dir, basename, depth = 0) {
  if (depth > MAX_AGENT_DIR_DEPTH) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasBasename(path.join(dir, entry.name), basename, depth + 1)) return true;
    } else if (entry.isFile() && entry.name === basename) {
      return true;
    }
  }
  return false;
}

function installedPluginsRegistry(homeDir) {
  try {
    const raw = fs.readFileSync(
      path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
  } catch {
    return {};
  }
}

// Upstream semantics: a "user"-scoped (or unscoped) install covers every
// project; a "project"-scoped install covers only its own projectPath.
function pluginCovers(registry, plugin, cwd) {
  const resolved = path.resolve(cwd);
  for (const [key, entries] of Object.entries(registry)) {
    if (!key.startsWith(`${plugin}@`) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry?.scope === 'project') {
        if (entry.projectPath && path.resolve(entry.projectPath) === resolved) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

/**
 * Spawn-free gap probe. `relevant: false` when the project has no
 * .claude/agents tree at all (not a ruflo-scaffolded project — no row).
 * @returns {{ relevant: boolean, gaps: Array<{basename: string, plugin: string}> }}
 */
export function removedAgentGaps(cwd, { homeDir = paths.home } = {}) {
  const agentsDir = path.join(cwd, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) return { relevant: false, gaps: [] };
  const registry = installedPluginsRegistry(homeDir);
  const gaps = REMOVED_AGENTS.filter(
    ({ basename, plugin }) =>
      !hasBasename(agentsDir, basename) && !pluginCovers(registry, plugin, cwd)
  );
  return { relevant: true, gaps };
}

/**
 * Does the installed CLI ship `migrate fix --agents`? Probed the same way
 * mcp.mjs derives tool families — from what actually sits in the installed
 * dist (the restore module lands with ruflo#2986) — never from a version
 * string, so a backport or a fork build is detected identically.
 */
export function upstreamFixAvailable({ cliDist = paths.rufloCliDist() } = {}) {
  return fs.existsSync(path.join(cliDist, 'commands', 'migrate-agent-restore.js'));
}

/** Delegate the restore to upstream. Only called by sync when
 *  upstreamFixAvailable() held at collect time. */
export async function runScaffoldAgentsFix(cwd, { runner = run, homeDir = paths.home } = {}) {
  const r = await runner('ruflo', ['migrate', 'fix', '--agents'], { cwd, timeout: 120_000 });
  if (r.code !== 0) {
    return { ok: false, detail: `ruflo migrate fix --agents failed: ${(r.stderr || r.stdout || '').slice(0, 200)}` };
  }
  const after = removedAgentGaps(cwd, { homeDir });
  return after.gaps.length === 0
    ? { ok: true, detail: 'delegated to `ruflo migrate fix --agents` — all removed agents restored' }
    : { ok: false, detail: `ran \`ruflo migrate fix --agents\` but ${after.gaps.length} gap(s) remain — see \`ruflo migrate status\`` };
}
