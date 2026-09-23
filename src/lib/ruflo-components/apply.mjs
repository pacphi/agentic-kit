// ADR-0058: applies the ak-managed ruflo components — the typesafe agent-picker package,
// ruflo's promotional funnel, the MCP governance policy file, and the Claude env
// projection — then returns a classified snapshot built from fresh (or cached) evidence.
// Every mutation is receipt-gated under cfg.integrations.ownership.rufloComponents so a
// later reconcile (or `ak sync --undo`) only ever touches what agentic-kit itself set.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../exec.mjs';
import * as paths from '../paths.mjs';
import { installedVersion } from '../versions.mjs';
import { globalInstallArgs } from '../npm-global-install.mjs';
import { reconcileClaudeComponentEnv, CLAUDE_RC_RECEIPT, MEMORY_PIN_RECEIPT } from '../claude-env-projection.mjs';
import { managedIntent } from './config.mjs';
import { componentById } from './catalogue.mjs';
import { supports } from './env.mjs';
import { reconcilePolicy, readPolicy } from './policy.mjs';
import {
  moduleVersionFromRuflo, parseFunnel, collectEvidence, OUTRANKS_USER, readEvidenceCache, writeEvidenceCache, EVIDENCE_TTL_MS,
} from './evidence.mjs';
import { componentSnapshot, claudeKeyStates } from './snapshot.mjs';

const TYPESAFE = '@ruvector/typesafe';

const owned = (cfg) => {
  cfg.integrations ??= {};
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.rufloComponents ??= {};
  return cfg.integrations.ownership.rufloComponents;
};

/** Evidence cache location, beside `maintenanceControlDir()` in the same state base
 *  (`<stateBase>/agentic-kit/ruflo-components-evidence.json`). */
export const rufloComponentsEvidenceFile = () =>
  path.join(path.dirname(paths.maintenanceControlDir()), 'ruflo-components-evidence.json');

/** Controller ruling: a ruflo PROJECT is not merely "any ancestor .git" — ADR-0058
 *  defines it as a git repository root that ALSO has a `.claude-flow/` directory.
 *  `paths.repoRoot` alone would let a dotfiles repo (or any unrelated repo) at or
 *  above $HOME receive project-scope writes (a `.harness/mcp-policy.json`) when
 *  a caller reconciles from a non-project cwd such as `paths.home`. Returns null
 *  when there is no repo, or the repo has no `.claude-flow/` yet. */
export function rufloProjectRoot(cwd) {
  const root = paths.repoRoot(cwd);
  if (!root) return null;
  try {
    return fs.statSync(path.join(root, '.claude-flow')).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** Install `@ruvector/typesafe` globally under the shared reviewed-lifecycle-scripts
 *  policy, and record a receipt only once it resolves from ruflo's own module tree —
 *  an npm exit 0 is not viability evidence (see npm-global-install.mjs). Skipped
 *  entirely when the component is not managed or the installed ruflo predates the
 *  version that can use it.
 *  @param {{runner?: typeof run, rufloVersion?: (string|null), resolveVersion?: () => (string|null), preinstalled?: boolean}} [options] */
export async function ensureTypesafePackage(cfg, options = {}) {
  const {
    runner = run, rufloVersion = installedVersion('ruflo'),
    resolveVersion = () => moduleVersionFromRuflo(TYPESAFE), preinstalled,
  } = options;
  if (!managedIntent(cfg, 'typesafePicker') || !supports(rufloVersion, componentById('typesafePicker').minRuflo)) {
    return { ok: true, changed: false, detail: 'not required' };
  }
  if (preinstalled ?? resolveVersion() !== null) return { ok: true, changed: false, detail: `${TYPESAFE} present` };
  const r = await runner('npm', globalInstallArgs(TYPESAFE), { timeout: 600_000 });
  if (r.code !== 0) return { ok: false, changed: false, detail: `npm install failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}` };
  const version = resolveVersion();
  if (!version) return { ok: false, changed: true, detail: `${TYPESAFE} installed but does not resolve from ruflo's module tree` };
  owned(cfg).typesafePackage = { owner: 'agentic-kit', package: TYPESAFE, version };
  return { ok: true, changed: true, detail: `installed ${TYPESAFE}@${version}` };
}

/** Uninstall `@ruvector/typesafe`, but only when agentic-kit's own receipt says it
 *  installed it — a package the user brought in themselves is left alone. */
export async function removeTypesafePackage(cfg, { runner = run } = {}) {
  const receipt = cfg?.integrations?.ownership?.rufloComponents?.typesafePackage;
  if (receipt?.owner !== 'agentic-kit') return { ok: true, detail: `${TYPESAFE} not installed by agentic-kit; kept` };
  const r = await runner('npm', ['uninstall', '-g', TYPESAFE], { timeout: 300_000 });
  if (r.code !== 0) return { ok: false, detail: `npm uninstall failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}` };
  delete owned(cfg).typesafePackage;
  return { ok: true, detail: `removed ${TYPESAFE}` };
}

// JSON-first status read (ruling: `ruflo funnel status --json` + parseFunnel), which still
// falls back to the older text form inside parseFunnel for a stale/unpatched ruflo.
async function funnelStatus(runner) {
  const r = await runner('ruflo', ['funnel', 'status', '--json'], { timeout: 60_000 });
  return r.code === 0 ? parseFunnel(r.stdout) : null;
}

/** Disable ruflo's funnel (promotional tips/enrollment/statusline content) when
 *  agentic-kit manages it (`managedIntent(cfg, 'funnel') === 'off'`) and it is not
 *  already off. `ruflo funnel disable` is grounded as IRREVERSIBLE beyond the toggle
 *  itself: per ruflo/v3/@claude-flow/cli/src/commands/funnel.ts it also deletes
 *  ruflo's local funnel ID and its queued events — `releaseFunnel` below can only
 *  flip the flag back on, never restore that deleted state. */
export async function ensureFunnel(cfg, { runner = run } = {}) {
  if (managedIntent(cfg, 'funnel') !== 'off') return { ok: true, changed: false, detail: 'funnel not managed' };
  const before = await funnelStatus(runner);
  // ADR-0058 §1 "detected, not assumed": a ruflo without a readable `funnel status` has
  // no funnel for ak to turn off, which is not a failure to repeat on every sync.
  if (!before) return { ok: true, changed: false, detail: 'ruflo has no readable funnel status; nothing to disable' };
  if (!before.enabled) return { ok: true, changed: false, detail: `funnel already disabled (${before.decidedBy})` };
  // A higher-precedence source (ADR-305: env, enterprise-policy) outranks the user tier
  // `disable` writes, so running it would only delete ruflo's funnel ID again for nothing.
  if (OUTRANKS_USER.test(before.decidedBy)) {
    return { ok: true, changed: false, detail: `funnel enabled by ${before.decidedBy}, which outranks ruflo funnel disable; left alone` };
  }
  const r = await runner('ruflo', ['funnel', 'disable'], { timeout: 60_000 });
  const after = await funnelStatus(runner);
  if (r.code !== 0 || after?.enabled !== false) return { ok: false, changed: false, detail: 'ruflo funnel disable did not take effect' };
  owned(cfg).funnelDisabled = true;
  return { ok: true, changed: true, detail: 'funnel disabled' };
}

/** Re-enable the funnel, but only the part agentic-kit itself disabled (the receipt
 *  gate). This CANNOT undo the funnel ID + event-queue deletion `ruflo funnel disable`
 *  performed — see the comment on `ensureFunnel` above; that data is gone for good. */
export async function releaseFunnel(cfg, { runner = run } = {}) {
  if (!cfg?.integrations?.ownership?.rufloComponents?.funnelDisabled) return { ok: true, detail: 'funnel not changed by agentic-kit' };
  const status = await funnelStatus(runner);
  if (status && !status.enabled && /user/i.test(status.decidedBy)) await runner('ruflo', ['funnel', 'enable'], { timeout: 60_000 });
  delete owned(cfg).funnelDisabled;
  return { ok: true, detail: 'funnel returned to ruflo\'s default' };
}

/** Remember a project that holds ak's Claude env or memory-pin receipt, so `ak uninstall`
 *  (and governance turned off) can release it from any cwd, not only from inside it. */
export function recordProjectReceipts(cfg, root) {
  const local = paths.projectSettingsLocal(root);
  if (![CLAUDE_RC_RECEIPT, MEMORY_PIN_RECEIPT].some((suffix) => fs.existsSync(`${local}${suffix}`))) return;
  (owned(cfg).projects ??= {})[path.resolve(root)] = true;
}

/** Every project root ak holds a receipt for: policy files, project env and memory pins. */
export function receiptedProjectRoots(cfg) {
  const rc = cfg?.integrations?.ownership?.rufloComponents ?? {};
  return [...new Set([...Object.keys(rc.policies ?? {}), ...Object.keys(rc.projects ?? {})])];
}

/** Governance turned off releases ak's policy file and project env in EVERY receipted
 *  project, not only the one sync happens to run in. */
function releaseGovernanceEverywhere(cfg, { skip, rufloVersion }) {
  const results = [];
  for (const root of receiptedProjectRoots(cfg)) {
    if (root === skip || !fs.existsSync(root)) continue;
    try {
      const p = reconcilePolicy(root, false, owned(cfg).policies ??= {});
      const env = reconcileClaudeComponentEnv(cfg, { projectRoot: root, rufloVersion, userScope: false });
      results.push({ id: 'mcpGovernance', ok: env.ok, changed: p.changed || env.changed, detail: `${root}: policy ${p.status}` });
    } catch (error) {
      results.push({ id: 'mcpGovernance', ok: false, changed: false, detail: `${root}: ${(error?.message || String(error)).slice(0, 160)}` });
    }
  }
  return results;
}

async function applyMachine(cfg, { runner, rufloVersion }, results, blocked) {
  const pkg = await ensureTypesafePackage(cfg, { runner, rufloVersion });
  results.push({ id: 'typesafePicker', ...pkg });
  if (!pkg.ok) blocked.typesafePicker = pkg.detail;
  if (managedIntent(cfg, 'funnel') === 'off') {
    const fun = await ensureFunnel(cfg, { runner });
    results.push({ id: 'funnel', ...fun });
    if (!fun.ok) blocked.funnel = fun.detail;
  } else if (cfg?.integrations?.ownership?.rufloComponents?.funnelDisabled) {
    // funnel handed back to ruflo: undo the disable ak itself ran (ADR-0058 §1 "off really is off").
    const rel = await releaseFunnel(cfg, { runner });
    results.push({ id: 'funnel', ok: rel.ok, changed: true, detail: rel.detail });
  }
}

function applyPolicy(cfg, projectRoot, dryRun, results, blocked) {
  try {
    // Dry run must never create cfg.integrations.ownership.rufloComponents.policies (or
    // any parent of it) — reconcilePolicy only reads/writes its receipts argument, so a
    // throwaway copy keeps dry-run side-effect-free while still detecting drift correctly.
    const receipts = dryRun
      ? { ...(cfg?.integrations?.ownership?.rufloComponents?.policies ?? {}) }
      : (owned(cfg).policies ??= {});
    const p = reconcilePolicy(projectRoot, managedIntent(cfg, 'mcpGovernance'), receipts, { dryRun });
    results.push({ id: 'mcpGovernance', ok: true, changed: p.changed, detail: `policy ${p.status}` });
  } catch (error) {
    const detail = (error?.message || String(error)).slice(0, 160);
    blocked.mcpGovernance = detail;
    results.push({ id: 'mcpGovernance', ok: false, changed: false, detail });
  }
  return readPolicy(projectRoot).state;
}

/** Evidence (refreshed after a change) plus the on-disk projection, classified. */
async function classify(cfg, o) {
  const cached = readEvidenceCache(o.evidenceFile);
  const fresh = cached && cached.rufloVersion === o.rufloVersion && o.now - Date.parse(cached.capturedAt) < EVIDENCE_TTL_MS;
  let evidence = cached;
  if (o.refresh && !o.dryRun && (!fresh || o.changed)) {
    evidence = await collectEvidence({
      projectRoot: o.projectRoot, cfg, rufloVersion: o.rufloVersion, runner: o.runner, now: o.now, cwd: o.cwd,
    });
    writeEvidenceCache(o.evidenceFile, evidence);
  }
  // Classify against what is on disk NOW: after a real write, re-plan (read-only) so the
  // snapshot shows the converged projection rather than the plan that was just applied.
  const settled = o.dryRun ? o.claude : reconcileClaudeComponentEnv(cfg, {
    projectRoot: o.projectRoot, rufloVersion: o.rufloVersion, userSettingsFile: o.userSettingsFile, dryRun: true,
  });
  // Codex hooks integration cannot currently be verified from here (2026-09-23 spike);
  // recorded as a missing host so a component that projects to it, such as the MiniLM
  // agent picker, is classified `partial` rather than claimed `active` for Codex.
  const missingHosts = cfg?.integrations?.hosts?.codex ? ['Codex hooks'] : [];
  return componentSnapshot({
    cfg,
    rufloVersion: o.rufloVersion,
    evidence,
    now: o.now,
    projection: {
      claude: { keys: claudeKeyStates(settled), changed: o.claude.changed }, missingHosts, policy: o.policy, blocked: o.blocked,
    },
  });
}

/** Apply every ak-managed ruflo component, project Claude's env, and return a
 *  classified snapshot. `dryRun` skips every mutation (package install/removal,
 *  funnel toggle, policy write, env write) but still reports what WOULD change.
 *  @param {{cwd?: string, dryRun?: boolean, runner?: typeof run, userSettingsFile?: string, evidenceFile?: string, refresh?: boolean, now?: number, rufloVersion?: (string|null), projectRoot?: (string|null)}} [options] */
export async function reconcileRufloComponents(cfg, options = {}) {
  const {
    cwd = process.cwd(), dryRun = false, runner = run, userSettingsFile,
    evidenceFile = rufloComponentsEvidenceFile(), refresh = true, now = Date.now(),
    rufloVersion = installedVersion('ruflo'),
    // Controller ruling: `undefined` (the default — option not passed at all) resolves the
    // project from `cwd` via `rufloProjectRoot`; an EXPLICIT `null` forces machine-scope only
    // (no project targets are ever touched), which is how `run_machine` calls this so a
    // dotfiles repo or any unrelated repo at/above the machine-scope cwd is never mistaken
    // for a ruflo project.
    projectRoot: projectRootOption,
  } = options;
  const projectRoot = projectRootOption === undefined ? rufloProjectRoot(cwd) : projectRootOption;
  const results = [];
  const blocked = {};
  if (!dryRun) await applyMachine(cfg, { runner, rufloVersion }, results, blocked);
  let policy = null;
  if (projectRoot && supports(rufloVersion, componentById('mcpGovernance').minRuflo)) {
    policy = applyPolicy(cfg, projectRoot, dryRun, results, blocked);
  }
  const claude = reconcileClaudeComponentEnv(cfg, {
    projectRoot, rufloVersion, userSettingsFile, dryRun,
  });
  results.push({
    id: 'claude-env', ok: claude.ok, changed: claude.changed,
    detail: claude.findings.map((f) => `${f.file}: ${f.status}${f.reason ? ` (${f.reason})` : ''}`
      + (f.conflicts?.length ? ` (preserved: ${f.conflicts.map((c) => c.key).join(', ')})` : '')).join('; '),
  });
  if (!dryRun) {
    if (projectRoot) recordProjectReceipts(cfg, projectRoot);
    if (!managedIntent(cfg, 'mcpGovernance')) {
      results.push(...releaseGovernanceEverywhere(cfg, { skip: projectRoot && path.resolve(projectRoot), rufloVersion }));
    }
  }
  const snapshot = await classify(cfg, {
    projectRoot, rufloVersion, userSettingsFile, dryRun, claude, runner, now, cwd, evidenceFile, refresh, policy, blocked,
    changed: results.some((r) => r.changed),
  });
  return {
    ok: results.every((r) => r.ok),
    changed: results.some((r) => r.changed),
    results,
    snapshot,
  };
}
