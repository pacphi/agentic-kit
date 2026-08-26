// ak status — read-only dashboard. Each row: subsystem, level, message,
// and (for drift) what `sync` would do. --json emits the raw rows; --hint
// (set by bare invocation) appends exactly one suggested next action.
import fs from 'node:fs';
import path from 'node:path';
import { glyph, dim, bold, warn } from '../lib/output.mjs';
import { loadRing, detectRegression } from '../lib/health-history.mjs';
import * as paths from '../lib/paths.mjs';
import { nativesStatus, rufloRuntimeNatives, dbPathPinStatus, aidefencePresent, securityPresent } from '../lib/natives.mjs';
import { scanNpxStale } from '../lib/npx.mjs';
import { registrationStatus, codexMcpStatus, codexMcpTopology, rufloCodexMcpStatus, ruvectorRegistered } from '../lib/mcp.mjs';
import {
  opencodeMcpStatus, catalogSource, createOpencodeLifecycleAdapter,
  opencodeArtifactReceiptState,
} from '../lib/opencode.mjs';
import { listDaemons, staleDaemons } from '../lib/daemons.mjs';
import { scanRvf } from '../lib/rvf.mjs';
import { registry, syncBlocks, blocksForTarget, retiredForTarget, guidanceTargets } from '../lib/blocks.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { driftReport, selfDrift, installedVersion, cmpVersions } from '../lib/versions.mjs';
import { upstreamCveCounterFabricated, fixStatusline, helperStampStale } from '../lib/statusline.mjs';
import { drift as ruvnetBrainDrift, nightlyAgentPresent as rbNightlyPresent, NIGHTLY_LABEL as RB_NIGHTLY_LABEL } from '../lib/ruvnet-brain.mjs';
import { coherence as adbCoherence } from '../lib/agentdb.mjs';
import { readJson } from '../lib/settings.mjs';
import { have } from '../lib/exec.mjs';
import { HOSTS, settingsTarget, isDefault, managedEnv, MANAGED_ENV_KEYS, hostInstallState, hostAuthState, bothHostsEnabled, aqeRouterFile, aqeSupportsAgentOverrides, credentialGaps, collectIntegrationFacts, MIN_RUFLO_PERSISTED_PROVIDER_VERSION } from '../lib/providers.mjs';
import { hostsWithLifecycle, isBuiltinHost, lifecycleExecutionEnabled } from '../lib/adapters/lifecycle-registry.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { PROVIDER_REGISTRY } from '../lib/adapters/index.mjs';
import { configuredPolicyToAgentOverrides, agentOverridesDrift, routingSummary, divergedRoutes } from '../lib/routing.mjs';
import { qeCourtShipped, readQeCourtConfig, validateCourtConfig, qeCourtReadiness } from '../lib/qeCourt.mjs';
import { drift as ruvectorDrift } from '../lib/ruvector.mjs';
import { statuslineDrift } from '../lib/codex-statusline.mjs';
import { inspectCodexPlugins } from '../lib/codex-plugins.mjs';
import { projectMemoryStatus } from '../lib/project-memory.mjs';
import { removedAgentGaps, upstreamFixAvailable } from '../lib/scaffold.mjs';
import { latestSnapshot, readModelStore, summarizeModelHealth } from '../lib/model-inventory/index.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  deep: { type: 'boolean', default: false },
  hint: { type: 'boolean', default: false },
};

export const help = `ak status — read-only dashboard of what's true and what's drifted

Prints one row per subsystem (versions, natives, security, learning, providers,
…). Read-only: it never changes anything. A bare \`ak\` runs this plus one
suggested next action.

Usage: ak status [options]

Options:
  --deep    run the slower probes (spawns CLIs) for a fuller picture
  --json    emit the raw rows as JSON (suppresses the drift nudge)

Examples:
  ak status           quick dashboard
  ak status --deep    thorough check
  ak status --json    machine-readable rows`;

const row = (subsystem, level, message, fix = null) => ({ subsystem, level, message, fix });
const DEJA_HOSTS = Object.freeze(['claude', 'codex', 'opencode']);
const SAFE_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function hasDejaVuOwnership(cfg) {
  const ownership = cfg?.integrations?.ownership?.dejaVu;
  return !!ownership?.install
    || (!!ownership?.targets && typeof ownership.targets === 'object'
      && Object.keys(ownership.targets).length > 0);
}

function safeDejaCode(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value)
    ? value : 'unavailable';
}

function safeDejaVersion(value) {
  return typeof value === 'string' && SAFE_VERSION.test(value) ? value : 'unknown';
}

/**
 * Render the managed companion from its bounded lifecycle facts. No upstream
 * path, command output, signature, transcript metadata, or plugin payload is
 * copied into a row. A fix is attached only when the same adapter plan contains
 * an operation that can perform it.
 * @param {{cfg?:any,adapter?:any,planOptions?:Record<string,any>}} [options]
 */
export async function collectDejaVuRows(options = {}) {
  const {
    cfg,
    adapter = companionLifecycleFor('deja-vu'),
    planOptions = {},
  } = options;
  const desired = cfg?.integrations?.tools?.dejaVu;
  const enabled = desired?.enabled === true;
  const owned = hasDejaVuOwnership(cfg);
  if (!enabled && !owned) {
    return [row('deja-vu', 'info',
      'deja-vu disabled — package, host wiring, and history remain unprobed')];
  }
  if (!adapter) {
    return [row('deja-vu', 'warn', 'deja-vu lifecycle adapter unavailable')];
  }

  try {
    const facts = await adapter.detect({ cfg });
    const plan = await adapter.plan({ cfg, facts, options: planOptions });
    const operations = Array.isArray(plan?.operations) ? plan.operations : [];
    const actionable = !facts?.error && !plan?.error;
    const hasOperation = (kind, host = null) => actionable && operations.some((operation) =>
      operation?.kind === kind && (host === null || operation.host === host));
    const rows = [];

    if (facts?.error || plan?.error) {
      const code = safeDejaCode(facts?.error ?? plan?.error);
      const external = code === 'deja-external-version-unsupported'
        || code === 'deja-external-install-unusable';
      rows.push(row('deja-vu', external ? 'warn' : 'fail', external
        ? `external deja-vu installation is not safely manageable (${code}); preserved`
        : `deja-vu health contract failed closed (${code})`));
    }

    const install = facts?.install ?? {};
    if (install.binaryPresent === false) {
      if (enabled && hasOperation('package-install')) {
        rows.push(row('deja-vu', 'warn', 'deja-vu package missing',
          'sync installs the managed npm companion'));
      } else if (install.ownership === 'external') {
        rows.push(row('deja-vu', 'warn', 'external deja-vu package is unavailable; preserved'));
      } else {
        rows.push(row('deja-vu', 'info', 'deja-vu package absent'));
      }
    } else if (install.binaryPresent === true) {
      const version = safeDejaVersion(install.version);
      if (hasOperation('package-upgrade')) {
        rows.push(row('deja-vu', 'warn',
          `managed deja-vu ${version} has an available package upgrade`,
          'sync upgrades the owned npm companion'));
      } else if (install.receiptState === 'drifted' || install.receiptState === 'malformed') {
        rows.push(row('deja-vu', 'warn',
          `deja-vu ${version} package ownership receipt drifted; current installation preserved`));
      } else if (install.ownership === 'agentic-kit') {
        rows.push(row('deja-vu', install.supported === false ? 'warn' : 'ok',
          `managed deja-vu ${version} package${install.supported === false ? ' is below v0.19.0' : ' is present'}`));
      } else {
        rows.push(row('deja-vu', 'info',
          `external deja-vu ${version} package detected; installation remains user-owned`));
      }
    }

    if (facts?.doctor?.state === 'ok') {
      rows.push(row('deja-vu', 'ok', 'deja-vu doctor schema v2 accepted'));
    }

    for (const host of DEJA_HOSTS) {
      const target = facts?.targets?.[host];
      const receipt = cfg?.integrations?.ownership?.dejaVu?.targets?.[host];
      const receiptPresent = !!receipt;
      if (!target || (!target.selected && !receiptPresent)) continue;
      const hasTargetOperation = hasOperation('target-remove', host)
        || hasOperation('target-install', host);
      const managedTransition = hasTargetOperation && receipt?.mode
        && receipt.mode !== facts?.desired?.mode;
      if (target.receiptState === 'drifted') {
        rows.push(row('deja-vu', 'warn',
          `${host}: managed target ownership drifted; current wiring preserved`));
      } else if (target.conflict === 'external-auto-active' && !managedTransition) {
        rows.push(row('deja-vu', 'warn',
          `${host}: external automatic recall conflicts with MCP-only intent; external state preserved`));
      } else if (target.satisfied) {
        rows.push(row('deja-vu', target.ownership === 'agentic-kit' ? 'ok' : 'info',
          `${host}: ${target.desiredTarget ?? 'deja-vu'} target active`
          + (target.ownership === 'agentic-kit' ? ' and receipt-owned' : ' via external wiring')));
      } else if (hasTargetOperation) {
        rows.push(row('deja-vu', 'warn',
          `${host}: managed deja-vu target requires convergence`,
          `sync converges the exact ${host} target`));
      } else if (target.hostPresent === false) {
        rows.push(row('deja-vu', 'warn',
          `${host}: selected host is unavailable; companion wiring skipped`));
      } else {
        rows.push(row('deja-vu', 'warn',
          `${host}: desired deja-vu target is not proven; external state preserved`));
      }
    }

    if (enabled && facts?.desired?.indexOnSetup) {
      if (facts?.index?.state === 'ok') {
        rows.push(row('deja-vu', 'ok', 'deja-vu derived index is healthy'));
      } else if (hasOperation('index')) {
        rows.push(row('deja-vu', 'warn',
          `deja-vu derived index is ${['missing', 'stale'].includes(facts?.index?.state)
            ? facts.index.state : 'not ready'}`,
          'sync runs one bounded deja index after target convergence'));
      } else if (facts?.index?.state !== undefined) {
        rows.push(row('deja-vu', 'info', 'deja-vu derived index health is unknown'));
      }
    }

    return rows.length ? rows : [row('deja-vu', 'info', 'deja-vu state is unobserved')];
  } catch {
    return [row('deja-vu', 'warn', 'deja-vu status unavailable')];
  }
}

// Per-host status DETAIL rows — beyond the generic install/auth rows the
// `hosts` loop in collect() already renders from facts for every host alike.
// A detail renderer owns everything specific to how ONE host proves itself
// wired (config files, lifecycle bridges, converted artifacts, …); the
// opencode-specific PROBES/MESSAGES live in the renderer below and in
// lib/opencode.mjs, never in the dispatch loop itself. Adding a fourth host
// means adding (or not adding) a table entry here — the loop that walks this
// table never changes.
// The loop also passes `hostId`; this renderer doesn't need it (it IS the
// opencode renderer) but the signature admits it so the dispatch call site
// typechecks for every renderer uniformly.
async function opencodeDetailRows({ cfg, pkgRoot, facts, hostId: _hostId = 'opencode' } = /** @type {any} */ ({})) {
  const rows = [];
  try {
    if (!facts.hosts?.opencode?.present) {
      rows.push(row('opencode', 'warn', 'enabled but opencode CLI not installed', 'sync installs opencode-ai (hosts step)'));
    } else {
      const source = catalogSource({ override: cfg.integrations?.ownership?.opencode?.catalogDir });
      const st = opencodeMcpStatus(cfg);
      const lifecycle = await createOpencodeLifecycleAdapter({ pkgRoot }).detect({ cfg });
      const conv = st.parseError ? null : lifecycle.convergence;
      if (st.parseError) {
        rows.push(row('opencode', 'warn',
          'opencode.json is not plain JSON (JSONC comments?) — ak refuses to touch it',
          'merge the ak wiring manually'));
      } else if (!st.exists || !st.claudeFlow) {
        rows.push(row('opencode', 'warn',
          `opencode.json wiring incomplete (${[!st.exists ? 'no config file' : null, !st.claudeFlow ? 'claude-flow MCP missing' : null].filter(Boolean).join(', ')})`,
          'sync writes the opencode wiring'));
      } else if (!conv?.converged) {
        rows.push(row('opencode', 'warn',
          `opencode.json wiring drifted (${(conv?.reasons ?? []).slice(0, 3).join('; ')}${(conv?.reasons?.length ?? 0) > 3 ? '…' : ''})`,
          'sync re-applies the opencode wiring'));
      } else {
        rows.push(row('opencode', 'ok',
          `opencode.json converged (claude-flow${st.aqe ? ' + agentic-qe' : ''}${st.brain ? ' + ruvnet-brain' : ''} MCP, ${st.paths?.length ?? 0} skills path(s))${st.owned ? '' : ' — pre-existing (not ak-managed)'}`));
      }
      const receiptState = opencodeArtifactReceiptState(cfg.integrations?.ownership?.opencode?.managed);
      if (receiptState.adoptionBlocked) {
        rows.push(row('opencode', 'warn',
          'artifact receipt ledger is malformed — ownership adoption blocked; artifacts left untouched',
          'repair integrations.ownership.opencode.managed.artifacts in kit.json or restore it from backup'));
      }
      const plug = lifecycle.plugin;
      if (!receiptState.adoptionBlocked && plug.adoptable) {
        rows.push(row('opencode', 'warn',
          'lifecycle plugin is exact and marker-bearing but lacks an ownership receipt',
          'sync adopts it into the receipt ledger without rewriting it'));
      } else if (!receiptState.adoptionBlocked && plug.foreign) {
        rows.push(row('opencode', 'info', 'lifecycle plugin slot occupied by a user-owned ruflo-hooks.js — ak leaves it alone'));
      } else if (!receiptState.adoptionBlocked && !plug.present) {
        rows.push(row('opencode', 'warn', 'lifecycle plugin (ruflo-hooks.js) not deployed', 'sync deploys it'));
      } else if (!receiptState.adoptionBlocked && !plug.current) {
        rows.push(row('opencode', 'warn', 'lifecycle plugin out of date', 'sync rewrites it'));
      }
      const gateway = lifecycle.gateway;
      if (!receiptState.adoptionBlocked && gateway.adoptable) {
        rows.push(row('opencode', 'warn',
          'lazy rUv gateway is exact and marker-bearing but lacks an ownership receipt',
          'sync adopts it into the receipt ledger without rewriting it'));
      } else if (!receiptState.adoptionBlocked && gateway.foreign) {
        rows.push(row('opencode', 'info',
          'lazy rUv gateway slot is user-owned — direct MCP exposure is preserved'));
      } else if (!receiptState.adoptionBlocked && gateway.required && !gateway.present) {
        rows.push(row('opencode', 'warn', 'lazy rUv gateway not deployed', 'sync deploys it'));
      } else if (!receiptState.adoptionBlocked && gateway.required && !gateway.current) {
        rows.push(row('opencode', 'warn', 'lazy rUv gateway out of date', 'sync rewrites it'));
      } else if (!receiptState.adoptionBlocked && !gateway.required && gateway.present) {
        rows.push(row('opencode', 'warn', 'lazy rUv gateway is no longer required', 'sync retires it'));
      } else if (!receiptState.adoptionBlocked && gateway.required && gateway.current) {
        rows.push(row('opencode', 'ok',
          'Ruflo and Agentic QE connected; compact ak_* gateway projection active'));
      }
      const ag = lifecycle.agents;
      const lazyAgents = gateway.required && gateway.current && ag.count === 1;
      if (!receiptState.adoptionBlocked && ag.adoptable) {
        rows.push(row('opencode', 'warn',
          `${ag.count} exact marker-bearing agent projection or stamp lacks ownership receipts`,
          'sync adopts them into the receipt ledger without rewriting them'));
      } else if (!receiptState.adoptionBlocked && ag.count === 0 && !source) {
        rows.push(row('opencode', 'warn', 'no ruflo catalog source (marketplace clone or @claude-flow/cli)', 'install ruflo (or claude marketplace) for the agent catalog'));
      } else if (!receiptState.adoptionBlocked && ag.count === 0) {
        rows.push(row('opencode', 'warn', 'no Agentic Kit specialist projection', 'sync deploys the specialist dispatcher'));
      } else if (!receiptState.adoptionBlocked && ag.modified) {
        rows.push(row('opencode', 'info',
          `${ag.count} agent projection files include user edits — ak leaves those files alone`));
      } else if (!receiptState.adoptionBlocked && ag.stale) {
        rows.push(row('opencode', 'warn',
          `${ag.count} agent projection files from ${ag.stampedId ?? 'unknown source'}, current source is ${ag.currentId ?? 'none'}`,
          'sync refreshes the agent projection'));
      } else if (!receiptState.adoptionBlocked) {
        rows.push(row('opencode', 'ok', lazyAgents
          ? `lazy specialist dispatcher current (${ag.currentId})`
          : `${ag.count} converted agents (${ag.currentId})`));
      }
      const sk = lifecycle.skill;
      if (!receiptState.adoptionBlocked && sk.adoptable) {
        rows.push(row('opencode', 'warn',
          'platform skill is exact and marker-bearing but lacks an ownership receipt',
          'sync adopts it into the receipt ledger without rewriting it'));
      } else if (!receiptState.adoptionBlocked && sk.foreign) {
        rows.push(row('opencode', 'info', 'skills/ruflo/SKILL.md is user-owned — ak leaves it alone'));
      } else if (!receiptState.adoptionBlocked && source?.hasPlatformSkill && !sk.present) {
        rows.push(row('opencode', 'warn', 'platform skill (skills/ruflo/SKILL.md) not deployed', 'sync deploys it'));
      } else if (!receiptState.adoptionBlocked && source?.hasPlatformSkill && !sk.current) {
        rows.push(row('opencode', 'warn', 'platform skill out of date', 'sync re-deploys it'));
      }
    }
  } catch (e) {
    rows.push(row('opencode', 'warn', `opencode check unavailable: ${e.message}`));
  }
  return rows;
}

// Dispatch table: host id → detail renderer. CONTRACT: a renderer must catch
// its own errors and degrade to a warn row — the dispatch loop deliberately
// has no catch, so an uncaught throw would take down ALL of collect(), not
// just this host. A host absent from this table
// gets no detail rows here (its install/auth state still comes from the
// `hosts` loop, which is already host-neutral). This is the ONLY place a new
// host's status detail wiring gets registered.
const HOST_DETAIL_RENDERERS = { opencode: opencodeDetailRows };

/** Host-neutral dispatch loop: walks `renderers` (defaults to the table
 *  above) and, for each host enabled in cfg, calls its renderer with the
 *  shared facts snapshot. Exported (not just used internally) so a test can
 *  prove a synthetic host renders through this exact loop — with no host-id
 *  branching anywhere in the loop body — by injecting its own renderers map
 *  instead of reaching into module internals. */
export async function renderHostDetailRows({ cfg, pkgRoot, facts, renderers = HOST_DETAIL_RENDERERS }) {
  const rows = [];
  for (const [hostId, renderer] of Object.entries(renderers)) {
    if (!cfg.integrations?.hosts?.[hostId]) continue;
    rows.push(...(await renderer({ cfg, pkgRoot, facts, hostId })));
  }
  return rows;
}

/** Sync reachability gap (ADR-0031 P3 known limitation): setup.mjs and
 *  uninstall.mjs's admitted-host lifecycle loops (ADR-0031 P3) already iterate
 *  hostsWithLifecycle() and run for real; sync.mjs's twin loop is gated on
 *  BOTH lifecycleExecutionEnabled(hostId, cfg) AND `subsystems.has(hostId)`,
 *  where subsystems is `new Set(plan.map(p => p.subsystem))` derived straight
 *  from THIS collector's rows (sync.mjs). An admitted host with no
 *  HOST_DETAIL_RENDERERS entry (only opencode has one) produced no row at
 *  all, so its subsystem could never appear in the plan and sync's branch was
 *  unreachable for a real admitted host — even fully enabled, flag on, CLI
 *  present. This closes that gap: any admitted (never built-in) lifecycle
 *  host that lifecycleExecutionEnabled() actually gates IN for this run gets
 *  exactly one subsystem-tagged row, `subsystem === hostId` — deliberately
 *  the same identity opencode's own renderer uses (subsystem 'opencode' ===
 *  HOST_DETAIL_RENDERERS key 'opencode'), so sync's `subsystems.has(hostId)`
 *  finds it.
 *
 *  Deliberately lean, not a per-surface renderer like opencodeDetailRows: an
 *  arbitrary admitted host's only introspection surface is its own declared
 *  detect/verify hooks (a subprocess spawn), which this read-only, cheap
 *  collector does not invoke — so the row cannot report real drift and always
 *  carries a `fix` while the gate holds. Convergence is left to the adapter's
 *  own apply, which lifecycle.mjs's contract requires to be idempotent.
 *  Excludes built-in hosts (opencode already has a bespoke renderer above;
 *  a future built-in lifecycle host with no renderer is a gap for its own
 *  renderer to close, not this fallback) and any host already present in
 *  `renderers` (never double-reports one host under two mechanisms). Isolated
 *  per host, mirroring the per-renderer try/catch contract above — one
 *  admitted host's failure must not take down collect() or any other host's
 *  row. */
function admittedLifecycleFallbackRows(cfg, renderers = HOST_DETAIL_RENDERERS) {
  const rows = [];
  for (const hostId of hostsWithLifecycle()) {
    if (isBuiltinHost(hostId) || hostId in renderers) continue;
    try {
      if (!lifecycleExecutionEnabled(hostId, cfg)) continue;
      rows.push(row(hostId, 'warn',
        `${hostId}: external lifecycle host, enabled — sync will converge its hooks`,
        `sync applies the ${hostId} lifecycle adapter`));
    } catch (e) {
      rows.push(row(hostId, 'warn', `${hostId} lifecycle status unavailable: ${e.message}`));
    }
  }
  return rows;
}

export async function collect({
  pkgRoot,
  cwd = process.cwd(),
  dejaVuAdapter = companionLifecycleFor('deja-vu'),
  dejaVuPlanOptions = {},
}) {
  const rows = [];
  const cfg = loadKitConfig();
  const integrationFacts = await collectIntegrationFacts({ cwd, cfg });

  // Cache-only model lifecycle summary. Discovery and network access belong
  // exclusively to `ak models refresh`.
  try {
    const snapshot = latestSnapshot(readModelStore());
    if (!snapshot) rows.push(row('models', 'info', 'no local model inventory yet; run `ak models refresh` explicitly'));
    else {
      const health = summarizeModelHealth(snapshot);
      rows.push(row('models', health.level, health.message, health.fix));
    }
  } catch (error) {
    rows.push(row('models', 'warn', `model inventory unavailable: ${error.message}; run \`ak models refresh\` explicitly`));
  }

  // versions
  try {
    for (const r of await driftReport()) {
      if (!r.installed) {
        rows.push(row('versions', r.pkg === 'ruflo' ? 'fail' : 'warn',
          `${r.pkg} not installed globally`, 'setup installs it'));
      } else if (r.outdated) {
        rows.push(row('versions', 'warn',
          `${r.pkg} ${r.installed} installed, ${r.latest} available`, 'sync upgrades + re-heals'));
      } else {
        rows.push(row('versions', 'ok', `${r.pkg} ${r.installed}${r.latest ? ' (latest)' : ''}`));
      }
    }
  } catch (e) {
    rows.push(row('versions', 'warn', `version check unavailable: ${e.message}`));
  }

  // ruvnet-brain (offline KB + search_ruvnet MCP; not an npm package — detected
  // on disk, drift via GitHub releases, TTL-cached like `self`)
  if (cfg.ruvnetBrain) {
    try {
      const b = await ruvnetBrainDrift();
      if (!b.present) {
        rows.push(row('ruvnet-brain', 'warn', 'RuvNet Brain not installed', 'setup installs it (or `ak sync`)'));
      } else if (b.outdated) {
        const have = b.installedRelease ? `release v${b.installedRelease}` : 'present (unversioned install)';
        rows.push(row('ruvnet-brain', 'warn',
          `ruvnet-brain ${have}, release v${b.latest} available`, 'sync refreshes the KB'));
      } else {
        const shown = b.installedRelease ? `release v${b.installedRelease}${b.latest ? ' (latest)' : ''}` : 'present';
        rows.push(row('ruvnet-brain', 'ok', `ruvnet-brain ${shown}`));
      }
    } catch (e) {
      rows.push(row('ruvnet-brain', 'warn', `ruvnet-brain check unavailable: ${e.message}`));
    }
    // The installer's own nightly self-updater (macOS LaunchAgent, 03:47) bypasses
    // ak-managed updates: it rewrites the KB outside ak's release stamp, so status
    // and the statusline drift from disk. Own subsystem so sync's fix is "disable
    // the agent", never a needless force-reinstall of the brain itself.
    if (rbNightlyPresent()) {
      rows.push(row('ruvnet-brain-nightly', 'warn',
        `ruvnet-brain nightly self-updater active (${RB_NIGHTLY_LABEL}) — bypasses ak-managed updates`,
        'sync disables it (re-enable deliberately: `npx ruvnet-brain --enable-nightly`)'));
    }
  }

  // ruvector — a global CLI users register as an MCP server BY HAND. ak manages
  // its drift, never its presence or its registration. Unregistered → no row at
  // all (same silence as codex-not-enabled): nudging a tool nobody opted into
  // would be management by ambush. Registered but kit.json ruvector:false → an
  // info row with NO fix, so sync never plans an upgrade the user turned off.
  //
  // Wording is deliberately "CLI": the registered command is typically
  // `npx -y ruvector mcp start`, so upgrading the global package does not
  // necessarily change what the MCP server executes. Claim only what is true.
  if (ruvectorRegistered()) {
    if (cfg.ruvector === false) {
      rows.push(row('ruvector', 'info', 'ruvector MCP registered — CLI updates disabled (kit.json ruvector:false)'));
    } else {
      try {
        const rv = await ruvectorDrift();
        if (rv.present && rv.outdated) {
          rows.push(row('ruvector', 'warn',
            `ruvector CLI ${rv.installed} installed, ${rv.latest} available`, 'sync upgrades the ruvector CLI'));
        } else if (rv.present) {
          rows.push(row('ruvector', 'ok', `ruvector CLI ${rv.installed}${rv.latest ? ' (latest)' : ''} (MCP registered, user scope)`));
        } else {
          rows.push(row('ruvector', 'info', 'ruvector MCP registered but no global CLI installed (server runs via npx)'));
        }
      } catch (e) {
        rows.push(row('ruvector', 'warn', `ruvector check unavailable: ${e.message}`));
      }
    }
  }

  // self (the kit's own version — prerelease installs track the `next` tag)
  try {
    const s = await selfDrift({ pkgRoot });
    if (s.outdated) {
      rows.push(row('self', 'warn',
        `kit ${s.installed} installed, ${s.latest} available (${s.tag} tag)`,
        'sync self-updates the kit (runs last)'));
    } else if (s.installed) {
      rows.push(row('self', 'ok', `kit ${s.installed}${s.latest ? ' (latest)' : ''}`));
    }
  } catch (e) {
    rows.push(row('self', 'warn', `kit version check unavailable: ${e.message}`));
  }

  // natives (better-sqlite3 in agentdb locations + aqe)
  try {
    const n = nativesStatus();
    const bad = n.locations.filter((l) => !l.native);
    if (n.locations.length === 0) {
      rows.push(row('natives', 'warn', 'no agentdb locations found under global ruflo', 'setup/sync installs ruflo'));
    } else if (bad.length) {
      rows.push(row('natives', 'fail',
        `${bad.length}/${n.locations.length} agentdb location(s) on WASM fallback (data-loss writes)`,
        'sync installs native better-sqlite3'));
    } else {
      rows.push(row('natives', 'ok', `native better-sqlite3 in ${n.locations.length} agentdb location(s)`));
    }
    if (n.aqe && !n.aqe.native) {
      rows.push(row('natives', 'fail', 'agentic-qe better-sqlite3 not native', 'sync repairs it'));
    }
    // #45: the agentdb copies above are NOT what `npx ruflo memory` loads — probe
    // the binding as resolved from ruflo's own memory runtime (@claude-flow/memory
    // + /cli), or the row reads ✓ while memory store runs on the WASM fallback.
    const rt = await rufloRuntimeNatives();
    if (rt.installed && rt.contexts.length) {
      const wasm = rt.contexts.filter((c) => !c.ok);
      if (wasm.length) {
        rows.push(row('natives', 'fail',
          `ruflo memory runtime on WASM fallback (${wasm.map((c) => `@claude-flow/${c.context}`).join(', ')}) — memory and orchestration may degrade`,
          'sync builds the native binding'));
      } else {
        rows.push(row('natives', 'ok', `ruflo memory runtime native (${rt.contexts.map((c) => c.context).join(', ')})`));
      }
    }
  } catch (e) {
    rows.push(row('natives', 'warn', `native check unavailable: ${e.message}`));
  }

  // #45 aftermath: a CLAUDE_FLOW_DB_PATH pin aimed at a dead or foreign path makes
  // every memory op target the wrong DB ("Database not initialized" with a healthy
  // DB in-repo). Warn-only — the pin may be deliberate; sync never touches it.
  try {
    const pin = dbPathPinStatus({
      settingsLocalFile: path.join(cwd, '.claude', 'settings.local.json'),
      projectRoot: cwd,
    });
    if (pin?.warn) {
      rows.push(row('memory-pin', 'warn',
        `CLAUDE_FLOW_DB_PATH pins ${pin.pinned} (${pin.reason})`,
        'repoint it in .claude/settings.local.json env, or remove the pin'));
    }
  } catch { /* pin check is best-effort — never blocks status */ }

  // Project memory may legitimately have two stores: the compatibility/sql.js
  // memory.db and the native bridge's plaintext agentdb-memory.db sibling.
  // Presence is a quick signal only; `ak x verify memory` performs the write
  // round-trip proof.
  try {
    const memory = projectMemoryStatus(cwd);
    if (!memory.active) {
      rows.push(row('memory', 'info', 'no project memory store yet (run setup here to initialize)'));
    } else if (!memory.active.readable) {
      rows.push(row('memory', 'warn',
        `active ${memory.active.kind} store is unreadable (${memory.active.file}) — run: ak x verify memory`));
    } else {
      const sibling = memory.secondary
        ? `; ${memory.secondary.kind} compatibility store also present`
        : '';
      rows.push(row('memory', 'ok',
        `${memory.active.kind} active writer: ${memory.active.entries} active entr${memory.active.entries === 1 ? 'y' : 'ies'}${sibling}`));
    }
  } catch (e) {
    rows.push(row('memory', 'warn', `project memory check unavailable: ${e.message}`));
  }

  // Scaffold agents (ADR-128 Phase 2 removals — ruflo#2985). Upstream never
  // revisits an existing scaffold, so projects inited before ruflo 3.38.x are
  // missing up to 9 plugin-canonical agents (coder, researcher, reviewer, …).
  // The fix is upstream's `ruflo migrate fix --agents` (PR #2986): when the
  // installed CLI ships it, the row carries a fix and sync delegates; until
  // then it is advisory-only — a kit-side restore would fork plugin-canonical
  // content. Spawn-free (dist probe + file walk), project-scoped: silent when
  // the cwd has no .claude/agents tree.
  try {
    const { relevant, gaps } = removedAgentGaps(cwd);
    if (relevant && gaps.length > 0) {
      const named = gaps.slice(0, 3).map((g) => g.basename.replace(/\.md$/, '')).join(', ');
      const suffix = gaps.length > 3 ? ', …' : '';
      if (upstreamFixAvailable()) {
        rows.push(row('scaffold-agents', 'warn',
          `${gaps.length} ADR-128-removed agent(s) missing from .claude/agents (${named}${suffix})`,
          'sync delegates to `ruflo migrate fix --agents`'));
      } else {
        rows.push(row('scaffold-agents', 'info',
          `${gaps.length} ADR-128-removed agent(s) missing (${named}${suffix}) — installed ruflo lacks \`migrate fix --agents\` (ruflo#2986 pending); upgrade ruflo or install the owning plugins`));
      }
    } else if (relevant) {
      rows.push(row('scaffold-agents', 'ok', 'ADR-128-removed agents present or plugin-covered'));
    }
  } catch (e) {
    rows.push(row('scaffold-agents', 'warn', `scaffold agent check unavailable: ${e.message}`));
  }

  // npx (stale ruflo-family cache envs — `npx --prefer-offline` fallbacks in the
  // statusline/hooks execute these verbatim, keeping retired defects alive)
  try {
    const stale = scanNpxStale();
    if (stale.length) {
      const what = stale.flatMap((e) => e.stale.map((s) => `${s.pkg}@${s.cached}`)).join(', ');
      rows.push(row('npx', 'warn',
        `${stale.length} stale npx env(s) serve outdated code (${what})`,
        'sync prunes them (npx re-fetches on demand)'));
    } else {
      rows.push(row('npx', 'ok', 'npx cache holds no stale ruflo-family envs'));
    }
  } catch (e) {
    rows.push(row('npx', 'warn', `npx cache check unavailable: ${e.message}`));
  }

  // security surface — honors kit.json security:false (`ak setup
  // --no-security`): an info row with NO fix, so sync never plans (or heals)
  // the surface a user turned off. Previously the flag was write-only.
  if (cfg.security === false) {
    rows.push(row('security', 'info', 'security checks disabled (kit.json security:false)'));
  } else if (securityPresent()) {
    if (aidefencePresent()) {
      rows.push(row('security', 'ok', '@claude-flow/security + aidefence present (defend functional)'));
    } else {
      rows.push(row('security', 'fail',
        'aidefence missing — `security defend` silently non-functional (ruvnet/ruflo#2670)',
        'sync reinstalls @claude-flow/aidefence'));
    }
  } else {
    rows.push(row('security', 'warn', '@claude-flow/security not found under global ruflo'));
  }

  // learning (project-scope quick signals)
  const stats = readJson(path.join(paths.projectClaudeFlowDir(cwd), 'neural', 'stats.json'));
  if (stats) {
    const pn = stats.patternsLearned ?? 0;
    rows.push(row('learning', pn > 0 ? 'ok' : 'warn',
      pn > 0 ? `${pn} patterns learned, ${stats.trajectoriesRecorded ?? 0} trajectories (this project)`
             : 'learning initialized but no patterns yet (this project)'));
  } else {
    rows.push(row('learning', 'info', 'no learning state in this project (run setup here to activate)'));
  }

  // aqe / RVF (project scope)
  const aqeDir = paths.projectAqeDir(cwd);
  if (fs.existsSync(aqeDir)) {
    const findings = scanRvf(aqeDir);
    if (findings.length) {
      // Oversized = the #495 runaway-append mode, the one RVF failure aqe's own
      // self-healing (>= 3.12.3) doesn't cover and the kit can see from the
      // filesystem. Everything lock-shaped is aqe's job now — see src/lib/rvf.mjs.
      rows.push(row('aqe', 'fail',
        `${findings.length} oversized RVF store(s) (runaway append) — quarantine before they eat the disk`,
        'sync quarantines them (aqe rebuilds the store)'));
    } else {
      rows.push(row('aqe', 'ok', 'agentic-qe initialized here; RVF store healthy'));
    }
  } else {
    rows.push(row('aqe', 'info', 'agentic-qe not initialized in this project'));
  }

  // agentdb (data-plane CLI `ak x harvest` drives). Pinned to ruflo's BUNDLED
  // agentdb so the shared cognitive store never skews on the core version.
  if (cfg.agentdb === false) {
    rows.push(row('agentdb', 'info', 'agentdb management disabled in kit.json'));
  } else {
    const c = adbCoherence();
    if (!c.present) {
      rows.push(row('agentdb', 'warn', 'agentdb CLI not installed (harvest write path unavailable)',
        "setup/sync installs it (pinned to ruflo's bundled agentdb)"));
    } else if (c.skew === 'core') {
      rows.push(row('agentdb', 'warn',
        `agentdb ${c.global} skewed from ruflo-bundled ${c.bundled} — shared-store corruption risk`,
        "sync repins agentdb to ruflo's bundled version"));
    } else {
      rows.push(row('agentdb', 'ok',
        `agentdb ${c.global}${c.bundled ? ` (coherent with ruflo${c.skew === 'prerelease' ? ' — prerelease diff' : ''})` : ''}`));
    }
  }

  // MCP
  const mcp = registrationStatus();
  if (mcp.claudeFlow) {
    rows.push(row('mcp', 'ok',
      `claude-flow registered (user scope)${mcp.denyCount ? `, ${mcp.denyCount} tool(s) denied by family exclusions` : ', all families allowed'}`));
  } else if (cfg.mcp.register) {
    rows.push(row('mcp', 'warn', 'ruflo MCP not registered', 'setup/sync registers claude-flow at user scope'));
  } else {
    rows.push(row('mcp', 'info', 'MCP registration disabled in kit.json'));
  }
  if (mcp.legacyRuflo) {
    rows.push(row('mcp', 'warn', "legacy 'ruflo'-keyed MCP registration present", 'sync migrates it to claude-flow'));
  }

  // Retired Claude→Codex `codex mcp-server` projection (ADR-0033). Its absence
  // is healthy; setup/sync remove only the prior agentic-kit-owned entry.
  // User-owned entries are preserved and receive an explicit manual remedy.
  if (cfg.integrations?.hosts?.codex) {
    try {
      const { registered, owned } = codexMcpStatus(cfg, cwd);
      if (registered) {
        rows.push(row('codex-mcp', 'warn',
          `deprecated codex mcp-server registered${owned ? ' — agentic-kit-owned' : ' — user-owned; preserved'}`,
          owned ? 'sync retires the legacy MCP entry' : 'remove manually: claude mcp remove codex -s project'));
      } else {
        rows.push(row('codex-mcp', 'ok', 'legacy codex mcp-server absent; supervised cross-host execution uses ak run'));
      }
    } catch (e) {
      rows.push(row('codex-mcp', 'warn', `codex MCP check unavailable: ${e.message}`));
    }
    // Independent Ruflo MCP integration lets a Codex-driven session reach the
    // same routing, swarm, and memory tools as Claude.
    try {
      const { registered, owned, command, args } = rufloCodexMcpStatus(cfg);
      const workspacePinned = command === 'ak'
        && JSON.stringify(args) === JSON.stringify(['x', 'ruflo-mcp']);
      if (registered && owned && !workspacePinned) {
        rows.push(row('codex-mcp', 'warn',
          'ak-owned ruflo MCP in codex uses the legacy cwd-only launcher',
          'sync migrates it to workspace-pinned project memory'));
      } else if (registered) {
        rows.push(row('codex-mcp', 'ok',
          `ruflo MCP registered in codex ([mcp_servers.ruflo])${owned ? ' — workspace memory pinned' : ' — pre-existing (not ak-managed)'}`));
      } else if (await have('codex')) {
        rows.push(row('codex-mcp', 'warn', 'codex enabled but ruflo MCP not registered in codex',
          'sync registers the ruflo MCP into codex'));
      }
    } catch (e) {
      rows.push(row('codex-mcp', 'warn', `ruflo→codex MCP check unavailable: ${e.message}`));
    }

    // Effective project+user topology. These checks are independent of the
    // agentic-kit ownership receipt because recursive/duplicate transports can
    // stall a Codex-driven worker even when another tool created them.
    try {
      const topology = codexMcpTopology({ cwd });
      if (topology.selfRegistrations.length) {
        const scopes = topology.selfRegistrations.map((entry) => entry.scope).join(', ');
        rows.push(row('codex-mcp', 'fail',
          `recursive codex → codex mcp-server registration detected (${scopes})`,
          'remove the [mcp_servers.codex] table from the reported Codex config before live multi-host runs'));
      }
      if (!topology.agenticQeRegistrations.length) {
        rows.push(row('codex-mcp', 'warn', 'agentic-qe MCP is not concretely registered in Codex',
          'run: aqe platform setup codex --overwrite --with-ruflo'));
      } else {
        rows.push(row('codex-mcp', 'ok', 'agentic-qe MCP concretely registered in Codex'));
      }
      if (topology.duplicateRuflo) {
        rows.push(row('codex-mcp', 'warn',
          `duplicate Ruflo MCP registrations in Codex: ${topology.rufloRegistrations.map((entry) => entry.name).join(', ')}`,
          'keep the workspace-aware [mcp_servers.ruflo] entry and remove legacy duplicates after reviewing ownership'));
      }
    } catch (e) {
      rows.push(row('codex-mcp', 'warn', `Codex MCP topology check unavailable: ${e.message}`));
    }
  }

  // Codex owns plugin installation, enablement, and refresh. Inspect every
  // explicitly enabled cached plugin's hooks and skills, but never attach a
  // sync fix: the supported repair surface is Codex's /plugins UI followed by
  // a fresh session.
  try {
    const plugins = inspectCodexPlugins();
    if (plugins.enabled.length && plugins.issues.length) {
      rows.push(row('codex-plugins', 'warn',
        `${plugins.issues.length} Codex plugin compatibility issue(s): ${plugins.issues[0]}; `
        + 'open Codex /plugins to refresh or disable it, then start a new session'));
    } else if (plugins.enabled.length) {
      const versions = plugins.plugins.map((plugin) => `${plugin.ref} (${plugin.version})`).join(', ');
      rows.push(row('codex-plugins', 'ok',
        `${plugins.enabled.length} enabled Codex plugin(s); newest cached hooks and skills pass known compatibility checks (${versions})`));
    }
  } catch (e) {
    rows.push(row('codex-plugins', 'warn', `Codex plugin check unavailable: ${e.message}`));
  }

  rows.push(...(await collectDejaVuRows({
    cfg, adapter: dejaVuAdapter, planOptions: dejaVuPlanOptions,
  })));

  // Per-host status DETAIL rows (opencode.json wiring, lifecycle bridge,
  // converted agents, platform skill, …) — the host-neutral counterpart of
  // the codex-mcp rows above. Dispatches through HOST_DETAIL_RENDERERS; only
  // a host both enabled AND registered there produces rows (enabled-but-
  // absent is the CLI-presence branch inside its own renderer, sourced from
  // the shared facts snapshot — no extra probing here or in the loop).
  rows.push(...(await renderHostDetailRows({ cfg, pkgRoot, facts: integrationFacts })));
  rows.push(...admittedLifecycleFallbackRows(cfg));

  // hosts (install-if-missing) — cheap: file read + `which`, no network.
  // An enabled host that is entirely absent is installable by sync; an external
  // install (mise/native/brew) is reported but never touched.
  try {
    // primary host absent = fail (nothing can drive); alternate absent = warn.
    const primaryHost = cfg.routing?.primaryHost ?? 'claude';
    for (const h of HOSTS) {
      if (!cfg.integrations.hosts[h.id]) continue;
      const detected = integrationFacts.hosts[h.id];
      if (detected?.present === false) {
        rows.push(row('hosts', h.id === primaryHost ? 'fail' : 'warn',
          `${h.id} enabled but not installed${h.id === primaryHost ? ' (primary)' : ''}`, `sync installs ${h.pkg}`));
        continue;
      }
      const st = await hostInstallState(h);
      if (st.method === 'absent') {
        rows.push(row('hosts', h.id === primaryHost ? 'fail' : 'warn',
          `${h.id} enabled but not installed${h.id === primaryHost ? ' (primary)' : ''}`, `sync installs ${h.pkg}`));
      } else {
        rows.push(row('hosts', 'ok', `${h.id} ${st.version ?? ''} (${st.method}${st.method === 'external' ? ' — self-managed' : ''})`));
        // auth mode (billing axis): oauth/subscription ($0) vs metered api-key.
        // A distinct row so `ak status --json` (and the dashboard) can badge it.
        const auth = hostAuthState(h.id, { present: true });
        const billing = auth.billing === 'subscription' ? 'subscription, $0'
          : auth.billing === 'metered' ? 'metered' : auth.billing;
        rows.push(row('hosts', auth.mode === 'none' ? 'warn' : 'ok',
          `${h.id} auth: ${auth.mode} (${billing})${auth.source ? ` · ${auth.source}` : ''}${auth.note ? ` — ${auth.note}` : ''}`,
          auth.mode === 'none' ? `${h.id} login` : null));
      }
    }
  } catch (e) {
    rows.push(row('hosts', 'warn', `host check unavailable: ${e.message}`));
  }

  // providers (frontier host wiring) — light: `have` probe + env read, no --version
  try {
    const { file, scope } = settingsTarget(cwd);
    const env = readJson(file, {})?.env ?? {};
    if (isDefault(cfg)) {
      // advisory only (no fix): opting codex in is a deliberate `ak host pick`
      if (await have('codex')) {
        rows.push(row('providers', 'info', 'codex CLI installed but not enabled (claude-only default)'));
      } else {
        rows.push(row('providers', 'info', 'claude-only (default host)'));
      }
      if (!cfg.integrations?.hosts?.opencode && await have('opencode')) {
        rows.push(row('providers', 'info', 'opencode CLI installed but not enabled (`ak host pick --host claude,opencode` wires it)'));
      }
    } else {
      const desired = managedEnv(cfg);
      const envDrift = MANAGED_ENV_KEYS.some((k) => (k in desired ? env[k] !== desired[k] : k in env));
      // aqe fallback chain: on-disk llm-config.json must match kit.json order.
      // Same scope gate as the writer (#129): applyAqeRouter anchors the file at
      // repoRoot and declines outside a project, so the check must read the root
      // and stay silent where sync would decline — a warn here would recommend a
      // sync that cannot repair it.
      const chain = cfg.providers.aqeFallback ?? [];
      const chainRoot = paths.repoRoot(cwd);
      let routerDrift = false;
      if (chain.length && chainRoot) {
        const disk = readJson(aqeRouterFile(chainRoot));
        const diskOrder = (disk?.fallbackChain?.entries ?? []).map((e) => e.provider).join('→');
        routerDrift = disk?._managedBy !== 'agentic-kit' || diskOrder !== chain.map((e) => e.provider).join('→');
      }
      const on = HOSTS.filter((h) => cfg.integrations.hosts[h.id]).map((h) => h.id).join('+') || 'none';
      const chainStr = chain.length ? `; aqe chain ${chain.map((e) => e.provider).join('→')}` : '';
      if (envDrift || routerDrift) {
        rows.push(row('providers', 'warn', `provider config drifted (want ${on}${chainStr}, ${scope})`, 'sync re-applies provider env + aqe router'));
      } else {
        rows.push(row('providers', 'ok', `wired: ${on}${chainStr} (${scope})`));
      }
      // Chain VIABILITY, separate from chain ORDER above: a chain in the right
      // order whose rungs have no credential fails over into nothing (#54). Warn,
      // not fail — the primary rung still works — and no `fix`, since only the
      // user can supply a key.
      if (chain.length) {
        const gaps = credentialGaps(chain);
        if (gaps.length) {
          rows.push(row('providers', 'warn',
            `aqe chain: ${chain.length - gaps.length}/${chain.length} rungs have credentials `
            + `(${gaps.map((g) => `${g.provider}: needs ${g.missing.join(', ')}`).join('; ')})`));
        } else {
          rows.push(row('providers', 'ok', `aqe chain: ${chain.length}/${chain.length} rungs have credentials`));
        }
      }
    }
    // A kit.json provider/model entry is registration intent. Ruflo >=3.38.8
    // can honor explicit OpenRouter/Ollama provider+model selection, but the
    // registry does not retarget every agent and it is not execution evidence.
    // Keep that distinction in the status rows the dashboard consumes.
    const rufloModels = cfg.providers?.models ?? [];
    if (rufloModels.length) {
      const intent = rufloModels
        .filter((entry) => entry?.id)
        .map((entry) => `${entry.id}${entry.model ? `:${entry.model}` : ''}`)
        .join(', ');
      const rufloVersion = installedVersion('ruflo');
      const affected = !!rufloVersion
        && cmpVersions(rufloVersion, MIN_RUFLO_PERSISTED_PROVIDER_VERSION) < 0;
      const missingOpenRouterKey = rufloModels.some((entry) => entry?.id === 'openrouter')
        && !integrationFacts.providers?.openrouter?.credentialPresent;
      const directIds = new Set(['ollama', 'openrouter']);
      const registryOnly = [...new Set(rufloModels
        .map((entry) => entry?.id)
        .filter((id) => id && !directIds.has(id)))];
      if (affected) {
        rows.push(row('providers', 'warn',
          `ruflo provider intent: ${intent} — ruflo ${rufloVersion} cannot honor persisted provider/model execution; needs >=${MIN_RUFLO_PERSISTED_PROVIDER_VERSION}`));
      } else if (missingOpenRouterKey) {
        rows.push(row('providers', 'warn',
          `ruflo provider intent: ${intent} — direct agents must select provider + model; openrouter needs OPENROUTER_API_KEY in the Ruflo/MCP process`));
      } else {
        const unsupported = registryOnly.length
          ? `; no direct-agent execution branch for ${registryOnly.join(', ')}`
          : '';
        rows.push(row('providers', 'info',
          `ruflo provider intent: ${intent} — direct agents must select provider + model; Usage proves served execution${unsupported}`));
      }
    }
    // ADR-0028 F-29: local-openai is a local ($0) provider deliberately NOT
    // projected to 'aqe' (unlike ollama, which is) — surface that asymmetry
    // plainly so it reads as a fact, not a bug. Registry-driven (billing +
    // projections), not an id check, so any future provider of the same
    // shape gets the same treatment for free.
    const providerById = Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, p]));
    for (const binding of cfg.integrations?.bindings ?? []) {
      const provider = providerById[binding.provider];
      if (!provider || provider.billing !== 'local' || provider.projections.includes('aqe')) continue;
      const endpoint = binding.endpoint ? ` @ ${binding.endpoint}` : '';
      rows.push(row('providers', 'info',
        `local binding: ${binding.provider} via ${binding.host}${endpoint} (${provider.billing} $0; not an AQE provider type)`));
    }
  } catch (e) {
    rows.push(row('providers', 'warn', `provider check unavailable: ${e.message}`));
  }

  // Per-activity routing (canonical routes → agentOverrides projection). Only surfaces
  // once a policy is set; the dashboard renders this row like any other subsystem.
  try {
    const policy = cfg.routing?.routes ?? {};
    if (Object.keys(policy).length) {
      const s = routingSummary(policy);
      // The WRITER's projection (#129): applyAqeRouter materializes only
      // explicitly persisted routes, so status must count and compare the same
      // set — the resolved projection would demand entries sync never writes.
      const want = configuredPolicyToAgentOverrides(policy);
      const base = `dual-host · ${s.total} activities (${s.custom} custom) → ${Object.keys(want).length} agent overrides`;
      if (!aqeSupportsAgentOverrides()) {
        rows.push(row('routing', 'info', `${base} · needs agentic-qe ≥ 3.13.1 to materialize`));
      } else {
        // Same scope gate as the writer: applyAqeRouter anchors at repoRoot(cwd)
        // and declines outside a project — a raw-cwd read from a subdir would
        // false-warn "out of sync" (M2), and outside a project a warn would
        // recommend a sync that cannot repair it (#129).
        const root = paths.repoRoot(cwd);
        if (!root) {
          rows.push(row('routing', 'info', `${base} · not in a project — aqe router unmanaged here`));
        } else {
          const overrides = readJson(aqeRouterFile(root))?.agentOverrides;
          const drift = overrides == null || agentOverridesDrift(overrides, policy);
          if (drift) rows.push(row('routing', 'warn', `${base} — llm-config.json out of sync`, 'sync re-applies agentOverrides'));
          else rows.push(row('routing', 'ok', base));
        }
      }
      // Seeded pins vs today's defaults. Deliberately `info` and deliberately
      // "diverges from": which side wins is activity-dependent (a newer default
      // can cost 2-3× the agentic turns on routine work), so a `warn` would push
      // users to spend turns clearing a lint. No `fix` — sync must never
      // auto-refresh a pin; `ak host refresh` is the opt-in path (#55).
      const diverged = divergedRoutes(policy);
      if (diverged.length) {
        const pairs = [...new Set(diverged.flatMap((d) => [
          ...(d.modelDiverged ? [`${d.model} vs ${d.defaultModel}`] : []),
          ...d.escalation.map((e) => `${e.model} vs ${e.defaultModel} (escalation)`),
        ]))].join(', ');
        rows.push(row('routing', 'info',
          `${diverged.length} seeded route(s) diverge from current defaults (${pairs}) — ak host refresh`));
      }
    }
  } catch (e) {
    rows.push(row('routing', 'warn', `routing check unavailable: ${e.message}`));
  }

  // daemons
  try {
    const daemons = await listDaemons({ cwd });
    const stale = staleDaemons(daemons);
    if (stale.length) {
      rows.push(row('daemons', 'warn',
        `${daemons.length} running, ${stale.length} stale (orphaned or past TTL)`, 'sync reaps stale daemons'));
    } else {
      rows.push(row('daemons', 'ok',
        daemons.length ? `${daemons.length} running (one per active project is expected)` : 'none running'));
    }
  } catch (e) {
    rows.push(row('daemons', 'warn', `daemon check unavailable: ${e.message}`));
  }

  // guidance-file blocks (dry-run reconcile = drift report). Three targets
  // (guidanceTargets): machine-wide ~/.claude/CLAUDE.md (claude), the project
  // <cwd>/AGENTS.md (agents), and — only when ~/.codex exists — machine-wide
  // ~/.codex/AGENTS.md (agents-user). The dual-mode block is gated on both hosts
  // being enabled (flag detector), so the agents targets stay unmanaged/quiet
  // until dual mode is on. retiredForTarget force-strips re-scoped blocks (the
  // migration path that clears the dual block from any project AGENTS.md).
  try {
    const rowsReg = registry(cfg.customBlocks);
    const resolve = (r) => (r.custom
      ? (r.template.startsWith('~/') ? path.join(paths.home, r.template.slice(2)) : r.template)
      : path.join(pkgRoot, 'claude', r.template));
    const ctx = { flags: { dualMode: bothHostsEnabled(cfg), opencodeEnabled: !!cfg.integrations?.hosts?.opencode } };
    for (const t of guidanceTargets({ cwd, cfg })) {
      const treg = [...blocksForTarget(rowsReg, t.name), ...retiredForTarget(rowsReg, t.name)];
      const res = await syncBlocks(t.file, treg, resolve, { dryRun: true, context: ctx });
      const drift = res.filter((r) => r.action === 'upserted' || r.action === 'stripped');
      const missing = res.filter((r) => r.action === 'missing-template');
      // The agents targets are unmanaged on single-host setups — stay quiet
      // unless there's actual drift (e.g. a block to strip after disabling dual
      // mode) or a missing template. Only the claude target always reports.
      if (t.name !== 'claude' && drift.length === 0 && missing.length === 0) continue;
      if (drift.length) {
        rows.push(row('blocks', 'warn',
          `${drift.length} ${t.label} block(s) drifted: ${drift.map((d) => `${d.slug}→${d.action.replace('ped', 'p')}`).join(', ')}`,
          'sync reconciles blocks'));
      } else {
        rows.push(row('blocks', 'ok', `${t.label} managed blocks in sync (${res.length} in registry)`));
      }
      for (const m of missing) rows.push(row('blocks', 'warn', `template missing for block '${m.slug}'`));
    }
  } catch (e) {
    rows.push(row('blocks', 'warn', `block check unavailable: ${e.message}`));
  }

  // statusline footer (project scope)
  const sl = paths.projectStatusline(cwd);
  if (fs.existsSync(sl)) {
    const slSrc = fs.readFileSync(sl, 'utf8');
    const hasFooter = slSrc.includes('ruflo-seg:BEGIN');
    // Drift is "would a sync CHANGE this file?", which fixStatusline's dry run answers
    // exactly. A marker-presence test alone cannot see CONTENT drift: after a kit upgrade
    // revises the footer or the security overlay, the marker is still there, this row
    // reports 'ok', and — because sync builds its plan from rows carrying a `fix` — the
    // re-injection never runs and the stale block survives indefinitely. Observed live:
    // an updated overlay silently failed to land for exactly this reason.
    let wouldChange = !hasFooter;
    try { wouldChange = fixStatusline(cwd, { dryRun: true }).applied; } catch { /* keep marker fallback */ }
    // Armed wipe: the footer can be present AND current while ruflo's helper
    // stamp lags the installed CLI — the next ruflo command (in practice the
    // daemon start) then pristine-copies statusline.cjs over ours. That is how
    // the footer kept vanishing BETWEEN syncs. Surface it as the same drift
    // story; sync closes it by refreshing the helpers before re-injecting.
    let stampStale = false;
    try { stampStale = helperStampStale(cwd); } catch { /* best-effort */ }
    rows.push(row('statusline', (wouldChange || stampStale) ? 'warn' : 'ok',
      wouldChange
        ? (hasFooter ? 'injected blocks are out of date' : 'statusline present but footer missing')
        : stampStale
          ? 'footer present but ruflo helper stamp is stale — next ruflo command wipes it'
          : 'activation footer present and current',
      (wouldChange || stampStale) ? 'sync refreshes helpers, then re-injects the footer' : null));
    // The CVE-counter overlay is tracked SEPARATELY from the footer: a footer-only
    // check reports 'ok' while the statusline still renders ruflo's fabricated
    // "⚠ 3 CVEs" (hardcoded totalCves, cvesFixed from a file count). Only warn while
    // the upstream defect is actually present — once ruflo fixes getSecurityStatus
    // the overlay is intentionally absent, and this row must go quiet on its own
    // rather than nag for a patch that is no longer wanted.
    if (upstreamCveCounterFabricated()) {
      const patched = slSrc.includes('ruflo-sec:BEGIN');
      rows.push(row('statusline/cve', patched ? 'ok' : 'warn',
        patched
          ? 'CVE counter overlaid with real scan results'
          : 'statusline shows ruflo\'s fabricated CVE count (upstream defect)',
        patched ? null : 'sync injects the security overlay'));
    }
  } else {
    rows.push(row('statusline', 'info', 'no project statusline here (created by setup)'));
  }
  // Codex has a native user-scoped line, but no command-backed rich renderer.
  if (cfg.integrations?.hosts?.codex || cfg.statusline?.codex) {
    const codexLine = statuslineDrift(cfg);
    if (!codexLine.owned) {
      rows.push(row('codex-statusline', 'info',
        'Codex native status line is unmanaged — opt in with `ak x statusline codex native`'));
    } else if (codexLine.drifted) {
      rows.push(row('codex-statusline', 'warn',
        `managed Codex ${codexLine.preset} status line has drifted`,
        'sync restores the selected native preset'));
    } else {
      rows.push(row('codex-statusline', 'ok',
        `managed Codex ${codexLine.preset} native status line is current (rich ruflo/SONA/AQE segments remain Claude-only)`));
    }
  }
  if (cfg.integrations?.hosts?.opencode) {
    rows.push(row('statusline', 'info',
      'opencode has no statusline surface; its ruflo lifecycle ships via the plugins/ bridge + AGENTS.md'));
  }

  // qe-court (ADR-124): read-only awareness. agentic-qe >=3.13.3 owns config
  // validation and ships a valid default; ak reports existing project state
  // but never rewrites the skill's config.
  if (qeCourtShipped()) {
    const qcRoot = paths.repoRoot(cwd);
    const qc = qcRoot ? readQeCourtConfig(qcRoot) : null;
    if (qc) {
      const violations = validateCourtConfig(qc);
      if (violations.length) {
        rows.push(row('qe-court', 'warn',
          `qe-court panel invalid: ${violations.join(', ')} — regenerate with agentic-qe >=3.13.3 or choose different defense/jury vendors`));
      } else {
        const readiness = qeCourtReadiness(qcRoot);
        if (readiness.ready) {
          rows.push(row('qe-court', 'ok', 'qe-court routing and consumer artifacts are ready; provider-seat readiness still requires a live proof'));
        } else {
          rows.push(row('qe-court', 'warn',
            `qe-court routing config passes the local anti-collusion check, but executability is not proven (${readiness.artifactIssues.join('; ')})`));
        }
      }
    }
  }

  return rows;
}

export async function run({ flags, pkgRoot }) {
  const rows = await collect({ pkgRoot });
  const worst = rows.some((r) => r.level === 'fail') ? 'fail'
    : rows.some((r) => r.level === 'warn') ? 'warn' : 'ok';

  if (flags.json) {
    console.log(JSON.stringify({ overall: worst, rows }, null, 2));
    return worst === 'fail' ? 1 : 0;
  }

  console.log(bold('ak status'));
  let last = '';
  for (const r of rows) {
    const label = r.subsystem === last ? ' '.repeat(r.subsystem.length) : r.subsystem;
    last = r.subsystem;
    console.log(`  ${glyph(r.level)} ${label.padEnd(11)} ${r.message}${r.fix ? dim(`  → ${r.fix}`) : ''}`);
  }

  // health-history: alarm on any backslide since the previous sync snapshot.
  for (const reg of detectRegression(loadRing(loadKitConfig()))) warn(`regression: ${reg.message}`);

  if (flags.hint) {
    const actionable = rows.filter((r) => r.fix);
    console.log('');
    if (worst === 'ok') console.log(`${glyph('ok')} all healthy — nothing to do`);
    else console.log(`${actionable.length} item(s) need attention — run: ${bold('ak sync')}${worst === 'fail' ? '' : dim('  (or --dry-run to preview)')}`);
    console.log(dim('📊 ak dashboard — open the local web dashboard (http://127.0.0.1:7431)'));
  }
  return worst === 'fail' ? 1 : 0;
}
