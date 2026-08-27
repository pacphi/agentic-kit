// opencode-lifecycle.mjs — the shared enable/retire stack composition and the
// ADR-0016 lifecycle adapter for OpenCode's managed native surfaces. Split
// out of opencode.mjs (ADR-0037's file-size gate) — behavior and export
// names are unchanged; opencode.mjs re-exports the externally-consumed
// names so no import path elsewhere in the repo needed to change.
import path from 'node:path';
import * as paths from './paths.mjs';
import { registry, syncBlocks, blocksForTarget, retiredForTarget, guidanceTargets } from './blocks.mjs';
import {
  opencodeOwnership, mutableOpencodeOwnership, applyOpencode, undoOpencode,
  opencodeArtifactReceiptState, managedGatewayMcp, opencodeConverged, normalizeManaged,
} from './opencode-core.mjs';
import { catalogSource, specialistDispatcherState, gatewayAgentCatalog, syncAgents, agentsStatus } from './opencode-agents.mjs';
import {
  deployPlugin, deployGatewayPlugin, retireGatewayPlugin, gatewayPluginStatus, pluginStatus,
  deploySkill, skillStatus, removeArtifacts,
} from './opencode-artifacts.mjs';

/** @typedef {import('./opencode-agents.mjs').CatalogSource} CatalogSource */

// ── shared stack composition (the ONE owner-module operation) ────────────────
// setup / sync / `ak host pick` all enable opencode the same way; off /
// uninstall / pick-disable all retire it the same way. The composition itself
// (which ops, in which order) is part of the ownership contract — three copies
// would drift (codex-review: the provider-picker rework must not duplicate
// merge/ownership logic in the command). Persistence of cfg stays with the
// CALLER (applyOpencode/undoOpencode mutate the ownership markers; the command
// decides when saveKitConfig runs).

/** Snapshot of the ownership markers used to compute `markersChanged`
 *  (applyOpencode re-records them on every run, so callers must compare
 *  before/after rather than trust `oc.changed` alone). */
function ownershipMarkersSnapshot(cfg) {
  return JSON.stringify([opencodeOwnership(cfg).mcp ?? null, opencodeOwnership(cfg).managed ?? null]);
}

/** The shape returned for every artifact surface when the receipt ledger is
 *  malformed — adoption is blocked fleet-wide until it's repaired by hand. */
function blockedArtifactResults(receipts) {
  const detail = 'skipped because the artifact receipt ledger is malformed';
  return {
    plugin: { ok: false, changed: false, receipt: receipts.plugin, adoptionBlocked: true, detail },
    gateway: { ok: false, changed: false, receipt: receipts.gateway, adoptionBlocked: true, detail },
    agents: {
      ok: false, changed: false, receipts: receipts.agents,
      stampReceipt: receipts.agentStamp, adopted: 0, adoptionBlocked: true, detail,
    },
    skill: { ok: false, changed: false, receipt: receipts.skill, adoptionBlocked: true, detail },
  };
}

/** Deploy/converge the plugin, lazy gateway, agent set, and platform skill —
 *  the non-blocked body of opencodeStack's enable path.
 *  @param {{ cfg: any, pkgRoot: string, source: CatalogSource|null, receiptState: any, configFile?: string, pluginsDir?: string, agentsDir?: string, skillsDir?: string }} args */
function deployOpencodeArtifacts({ cfg, pkgRoot, source, receiptState, configFile, pluginsDir, agentsDir, skillsDir }) {
  const { receipts, adoptionBlocked } = receiptState;
  const managedMcp = managedGatewayMcp(cfg, { ...(configFile ? { configFile } : {}) });
  const dispatcher = specialistDispatcherState({
    destDir: agentsDir ?? paths.opencodeAgentsDir(),
    receipts: receipts.agents,
    adoptionBlocked: receiptState.agentsAdoptionBlocked,
  });
  const agentCatalog = dispatcher.available ? gatewayAgentCatalog(source) : [];
  const gatewayRequired = Object.keys(managedMcp).length > 0 || agentCatalog.length > 0;
  const plugin = deployPlugin({
    pkgRoot, receipt: receipts.plugin, adoptionBlocked,
    ...(pluginsDir ? { pluginsDir } : {}),
  });
  const gateway = gatewayRequired
    ? deployGatewayPlugin({
        pkgRoot, managedMcp, agentCatalog, receipt: receipts.gateway, adoptionBlocked,
        ...(pluginsDir ? { pluginsDir } : {}),
      })
    : retireGatewayPlugin({
        receipt: receipts.gateway, ...(pluginsDir ? { pluginsDir } : {}),
      });
  const gatewayFacts = gatewayRequired
    ? gatewayPluginStatus({
        pkgRoot, managedMcp, agentCatalog,
        receipt: gateway.receipt ?? receipts.gateway ?? null,
        ...(pluginsDir ? { pluginsDir } : {}),
      })
    : { current: false };
  const gatewayCapabilities = {
    ruflo: gatewayFacts.current && managedMcp['claude-flow'] != null,
    aqe: gatewayFacts.current && managedMcp['agentic-qe'] != null,
  };
  const agents = dispatcher.blocked
    ? {
        ok: false, changed: false, receipts: receipts.agents,
        stampReceipt: receipts.agentStamp, adopted: 0, adoptionBlocked: true,
        detail: 'specialist dispatcher receipt mismatch; agent projection preserved',
      }
    : syncAgents({
        source, receipts: receipts.agents, stampReceipt: receipts.agentStamp,
        adoptionBlocked: receiptState.agentsAdoptionBlocked,
        gatewayCapabilities,
        lazyCatalog: gatewayFacts.current && agentCatalog.length > 0,
        ...(agentsDir ? { destDir: agentsDir } : {}),
      });
  const skill = deploySkill({
    source, receipt: receipts.skill, adoptionBlocked,
    ...(skillsDir ? { skillsDir } : {}),
  });
  return { plugin, gateway, agents, skill, gatewayRequired };
}

/** Enable path: wire opencode.json, deploy the lifecycle and lazy-catalogue
 *  plugins, convert the agent set, deploy the platform skill. Callers gate on the CLI being present
 *  first (have('opencode')) — this never fabricates the config home for an
 *  absent host. Returns each step's result for the caller's own formatting,
 *  plus `markersChanged`: applyOpencode re-records the ownership markers on
 *  EVERY run (a converged file with stale/missing markers in kit.json still
 *  needs persisting, or the next teardown cannot prove ownership) — callers
 *  must save cfg when `oc.changed || markersChanged`, not on `oc.changed`
 *  alone (codex-review r3).
 *  The destination seams exist for TESTS ONLY — production callers pass none
 *  and get the real config home; a test that forgets them writes to the
 *  developer's real machine (codex-review r4).
 *  @param {any} cfg @param {{ pkgRoot: string, configFile?: string, brainShim?: string, pluginsDir?: string, agentsDir?: string, skillsDir?: string }} opts */
export async function opencodeStack(cfg, { pkgRoot, configFile, brainShim, pluginsDir, agentsDir, skillsDir }) {
  const before = ownershipMarkersSnapshot(cfg);
  const oc = await applyOpencode(cfg, { ...(configFile ? { configFile } : {}), ...(brainShim ? { brainShim } : {}) });
  if (oc.fatal) {
    const skipped = { ok: false, changed: false, detail: 'skipped because opencode.json did not converge' };
    return {
      oc, plugin: skipped, gateway: skipped, agents: skipped, skill: skipped,
      source: null, markersChanged: false,
    };
  }
  const receiptState = opencodeArtifactReceiptState(opencodeOwnership(cfg).managed);
  const { receipts, adoptionBlocked } = receiptState;
  const source = catalogSource({ override: opencodeOwnership(cfg).catalogDir });
  if (adoptionBlocked) {
    return {
      oc, ...blockedArtifactResults(receipts), source,
      markersChanged: ownershipMarkersSnapshot(cfg) !== before,
    };
  }
  const { plugin, gateway, agents, skill, gatewayRequired } = deployOpencodeArtifacts({
    cfg, pkgRoot, source, receiptState, configFile, pluginsDir, agentsDir, skillsDir,
  });
  if (!adoptionBlocked) {
    mutableOpencodeOwnership(cfg).managed.artifacts = {
      plugin: plugin.receipt ?? receipts.plugin ?? null,
      gateway: gatewayRequired
        ? (gateway.receipt ?? receipts.gateway ?? null)
        : (gateway.ok ? null : (gateway.receipt ?? receipts.gateway ?? null)),
      agents: agents.receipts ?? receipts.agents ?? {},
      agentStamp: agents.stampReceipt ?? receipts.agentStamp ?? null,
      skill: skill.receipt ?? receipts.skill ?? null,
    };
  }
  return { oc, plugin, gateway, agents, skill, source, markersChanged: ownershipMarkersSnapshot(cfg) !== before };
}

/** Retire path: strip the ak-managed opencode.json wiring (user priors
 *  restored; collisions and user-edited values left), then remove ak-deployed
 *  artifacts (marker-gated — user-owned files survive). undoOpencode nulls the
 *  ownership markers in cfg on success and keeps them on failure; the caller
 *  persists — and MUST honor undo.ok before claiming a disable (codex-review
 *  r3: a JSONC-refused config leaves active wiring behind).
 *  @param {any} cfg */
/** @param {any} cfg
 *  @param {{configFile?:string,pluginsDir?:string,agentsDir?:string,skillsDir?:string}} [opts] */
export function retireOpencode(cfg, { configFile, pluginsDir, agentsDir, skillsDir } = {}) {
  const receipts = normalizeManaged(opencodeOwnership(cfg).managed).artifacts;
  const undo = undoOpencode(cfg, { ...(configFile ? { configFile } : {}) });
  const artifacts = undo.ok
    ? removeArtifacts({
        receipts,
        ...(pluginsDir ? { pluginsDir } : {}),
        ...(agentsDir ? { agentsDir } : {}),
        ...(skillsDir ? { skillsDir } : {}),
      })
    : { ok: false, changed: false, detail: 'retained because opencode.json teardown is incomplete' };
  return { undo, artifacts, ok: undo.ok };
}

/**
 * ADR-0016 lifecycle adapter for OpenCode's managed native surfaces.
 * Configuration lifecycle is deliberately separate from activity routing:
 * this adapter drives setup/sync/status/teardown while the host-neutral runner
 * separately honors the registry's explicit `canRouteActivities:true`.
 *
 * The factory keeps filesystem destinations injectable for hermetic conformance
 * tests. `detect`, `plan`, and `verify` are read-only. `runLifecycle` owns the
 * dry-run boundary, so `apply` and `undo` are never called for a dry-run.
 */
export function createOpencodeLifecycleAdapter(defaults = {}) {
  const options = (request) => ({ ...defaults, ...(request.options ?? {}) });
  const detect = async (request = {}) => {
    const cfg = request.cfg ?? {};
    const opts = options(request);
    const source = catalogSource({ override: opencodeOwnership(cfg).catalogDir });
    const convergence = await opencodeConverged(cfg, {
      ...(opts.configFile ? { configFile: opts.configFile } : {}),
      ...(opts.brainShim ? { brainShim: opts.brainShim } : {}),
    });
    const receiptState = opencodeArtifactReceiptState(opencodeOwnership(cfg).managed);
    const { receipts, adoptionBlocked } = receiptState;
    const managedMcp = managedGatewayMcp(cfg, {
      ...(opts.configFile ? { configFile: opts.configFile } : {}),
    });
    const dispatcher = specialistDispatcherState({
      destDir: opts.agentsDir ?? paths.opencodeAgentsDir(),
      receipts: receipts.agents,
      adoptionBlocked: receiptState.agentsAdoptionBlocked,
    });
    const agentCatalog = dispatcher.available ? gatewayAgentCatalog(source) : [];
    const gatewayRequired = Object.keys(managedMcp).length > 0 || agentCatalog.length > 0;
    const plugin = opts.pkgRoot
      ? pluginStatus({
          pkgRoot: opts.pkgRoot, receipt: receipts.plugin, adoptionBlocked,
          ...(opts.pluginsDir ? { pluginsDir: opts.pluginsDir } : {}),
        })
      : { present: false, current: false, foreign: false, adoptable: false };
    const gateway = opts.pkgRoot
      ? gatewayPluginStatus({
          pkgRoot: opts.pkgRoot, managedMcp, agentCatalog,
          receipt: receipts.gateway, adoptionBlocked,
          ...(opts.pluginsDir ? { pluginsDir: opts.pluginsDir } : {}),
        })
      : { present: false, current: false, foreign: false, adoptable: false };
    gateway.required = gatewayRequired;
    const agents = agentsStatus({
      source, receipts: receipts.agents, stampReceipt: receipts.agentStamp,
      adoptionBlocked: receiptState.agentsAdoptionBlocked || dispatcher.blocked,
      gatewayCapabilities: {
        ruflo: gateway.current && managedMcp['claude-flow'] != null,
        aqe: gateway.current && managedMcp['agentic-qe'] != null,
      },
      lazyCatalog: gateway.current && agentCatalog.length > 0,
      ...(opts.agentsDir ? { destDir: opts.agentsDir } : {}),
    });
    const skill = skillStatus({
      source, receipt: receipts.skill, adoptionBlocked,
      ...(opts.skillsDir ? { skillsDir: opts.skillsDir } : {}),
    });
    return {
      enabled: !!cfg.integrations?.hosts?.opencode,
      convergence, plugin, gateway, agents, skill,
    };
  };
  return {
    id: 'opencode',
    detect,
    async plan(request = {}) {
      const facts = request.facts ?? await detect(request);
      const changed = facts.enabled && (!facts.convergence.converged
        || facts.plugin.adoptable || (!facts.plugin.current && !facts.plugin.foreign)
        || (facts.gateway.required
          && (facts.gateway.adoptable || (!facts.gateway.current && !facts.gateway.foreign)))
        || (!facts.gateway.required && facts.gateway.present && !facts.gateway.foreign)
        || (!facts.agents.adoptionBlocked && (facts.agents.adoptable || facts.agents.stale))
        || facts.skill.adoptable || (!facts.skill.current && !facts.skill.foreign));
      return {
        changed, facts,
        operations: changed ? ['config', 'plugin', 'gateway', 'agents', 'skill'] : [],
      };
    },
    async apply(request = {}) {
      const cfg = request.cfg;
      const opts = options(request);
      if (!cfg || !opts.pkgRoot) throw new TypeError('opencode lifecycle apply requires cfg and pkgRoot');
      const result = await opencodeStack(cfg, opts);
      return {
        changed: result.oc.changed || result.plugin.changed || result.gateway.changed || result.agents.changed
          || result.skill.changed || result.markersChanged,
        result,
      };
    },
    async verify(request = {}) {
      return detect(request);
    },
    async undo(request = {}) {
      if (!request.cfg) throw new TypeError('opencode lifecycle undo requires cfg');
      const result = retireOpencode(request.cfg, options(request));
      return { changed: result.undo.changed || result.artifacts.changed, result };
    },
  };
}

export const OPENCODE_LIFECYCLE_ADAPTER = createOpencodeLifecycleAdapter();

/** Reconcile the opencode AGENTS.md guidance blocks for the current enablement
 *  state — the `agents-opencode` target only, never the claude/project files.
 *  Enable (`enabled: true`) upserts the enablement-gated blocks as soon as the
 *  config home exists; disable (`enabled: false`) strips them (the always-on
 *  preamble stays by design; user content is never touched). Shared by setup,
 *  `ak host pick` enable/disable, and `ak host off`, so every command
 *  converges guidance the same way sync's blocks branch does (codex-review r3).
 *  @param {{ pkgRoot: string, cfg: any, cwd?: string, enabled: boolean }} opts */
export async function reconcileOpencodeGuidance({ pkgRoot, cfg, cwd = process.cwd(), enabled }) {
  const target = guidanceTargets({ cwd }).find((t) => t.name === 'agents-opencode');
  if (!target) return { ok: true, changed: false, detail: 'no opencode config home — guidance skipped' };
  const rows = registry(cfg.customBlocks);
  const resolve = (r) => (r.custom
    ? (r.template.startsWith('~/') ? path.join(paths.home, r.template.slice(2)) : r.template)
    : path.join(pkgRoot, 'claude', r.template));
  const ctx = {
    flags: {
      dualMode: !!cfg.integrations?.hosts?.claude && !!cfg.integrations?.hosts?.codex,
      opencodeEnabled: enabled,
    },
  };
  const treg = [...blocksForTarget(rows, 'agents-opencode'), ...retiredForTarget(rows, 'agents-opencode')];
  const res = await syncBlocks(target.file, treg, resolve, { context: ctx });
  const changed = res.filter((r) => r.action !== 'unchanged' && r.action !== 'skipped')
    .map((r) => `${r.slug} ${r.action}`);
  return { ok: true, changed: changed.length > 0, detail: changed.length ? `guidance: ${changed.join(', ')}` : 'guidance in sync' };
}

