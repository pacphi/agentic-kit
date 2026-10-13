// Per-host status DETAIL rows — beyond the generic install/auth rows the
// `hosts` loop in collect() already renders from facts for every host alike.
// A detail renderer owns everything specific to how ONE host proves itself
// wired (config files, lifecycle bridges, converted artifacts, …); the
// opencode-specific PROBES/MESSAGES live in the renderer below and in
// lib/opencode.mjs, never in the dispatch loop itself. Adding a fourth host
// means adding (or not adding) a table entry here — the loop that walks this
// table never changes.
import {
  opencodeMcpStatus, catalogSource, createOpencodeLifecycleAdapter,
  opencodeArtifactReceiptState,
} from '../../lib/opencode.mjs';
import { row } from './row.mjs';

function opencodeWiringRow(st, conv) {
  if (st.parseError) {
    return row('opencode', 'warn',
      'opencode.json is not plain JSON (JSONC comments?) — ak refuses to touch it',
      'merge the ak wiring manually', { repair: 'manual' });
  }
  if (!st.exists || !st.claudeFlow) {
    return row('opencode', 'warn',
      `opencode.json wiring incomplete (${[!st.exists ? 'no config file' : null, !st.claudeFlow ? 'claude-flow MCP missing' : null].filter(Boolean).join(', ')})`,
      'sync writes the opencode wiring');
  }
  if (!conv?.converged) {
    return row('opencode', 'warn',
      `opencode.json wiring drifted (${(conv?.reasons ?? []).slice(0, 3).join('; ')}${(conv?.reasons?.length ?? 0) > 3 ? '…' : ''})`,
      'sync re-applies the opencode wiring');
  }
  return row('opencode', 'ok',
    `opencode.json converged (claude-flow${st.aqe ? ' + agentic-qe' : ''}${st.brain ? ' + ruvnet-brain' : ''} MCP, ${st.paths?.length ?? 0} skills path(s))${st.owned ? '' : ' — pre-existing (not ak-managed)'}`);
}

// Shared adoptable → foreign → absent → stale [→ not-required] [→ ok] ladder
// behind the plugin/gateway/skill artifacts (ADR-complexity-program #3): each
// used to repeat this exact decision tree with its own `!receiptState.
// adoptionBlocked &&` guard on every branch. The caller supplies only what
// differs per artifact — its label and its exact message/fix text — so the
// control flow lives in exactly one place. Returns `null` when the artifact
// is fine and has no `okMessage` configured (silence, matching plug/skill).
function artifactRow(subsystem, label, state, opts) {
  const {
    foreignMessage,
    absentMessage,
    absentFix = 'sync deploys it',
    staleMessage,
    staleFix = 'sync rewrites it',
    required = true,
    notRequiredMessage,
    notRequiredFix,
    okMessage,
  } = opts;
  if (state.adoptable) {
    return row(subsystem, 'warn', `${label} is exact and marker-bearing but lacks an ownership receipt`,
      'sync adopts it into the receipt ledger without rewriting it');
  }
  if (state.foreign) return row(subsystem, 'info', foreignMessage);
  if (!required) {
    return (state.present && notRequiredMessage) ? row(subsystem, 'warn', notRequiredMessage, notRequiredFix) : null;
  }
  if (!state.present) return row(subsystem, 'warn', absentMessage, absentFix);
  if (!state.current) return row(subsystem, 'warn', staleMessage, staleFix);
  return okMessage ? row(subsystem, 'ok', okMessage) : null;
}

// A stale projection says which stamp fact diverged (opencode-agents.mjs
// agentStaleReasons). Only a source change names both source ids; a projection
// written for a gateway state that no longer holds names the gateway, since
// its source did not change (Branch 0 real-machine pass, P4).
function staleAgentsMessage(ag, gateway) {
  const reasons = ag.staleReasons ?? [];
  if (!reasons.length || reasons.includes('stamp') || reasons.includes('source')) {
    return `${ag.count} agent projection files from ${ag.stampedId ?? 'unknown source'}, current source is ${ag.currentId ?? 'none'}`;
  }
  const causes = [];
  if (reasons.includes('files')) causes.push('the projected file set changed on disk');
  if (reasons.includes('catalogue') || reasons.includes('gateway')) {
    causes.push(gateway.required && !gateway.current
      ? 'they were written for the lazy rUv gateway, which is out of date'
      : 'the gateway capabilities they were written for changed');
  }
  return `${ag.count} agent projection files from ${ag.currentId} are out of date: ${causes.join('; ')}`;
}

// The agents artifact doesn't fit the adoptable/foreign/absent/stale shape
// above — its branches are counted-projection facts, not a single present/
// current pair — so it keeps its own ladder, just lifted out of the mega
// function.
function opencodeAgentsRow({ ag, gateway, source }) {
  const lazyAgents = gateway.required && gateway.current && ag.count === 1;
  if (ag.adoptable) {
    return row('opencode', 'warn',
      `${ag.count} exact marker-bearing agent projection or stamp lacks ownership receipts`,
      'sync adopts them into the receipt ledger without rewriting them');
  }
  if (ag.count === 0 && !source) {
    return row('opencode', 'warn',
      'no ruflo catalog source (marketplace clone or @claude-flow/cli)',
      'install ruflo (or claude marketplace) for the agent catalog', { repair: 'manual' });
  }
  if (ag.count === 0) {
    return row('opencode', 'warn', 'no Agentic Kit specialist projection', 'sync deploys the specialist dispatcher');
  }
  if (ag.modified) {
    return row('opencode', 'info', `${ag.count} agent projection files include user edits — ak leaves those files alone`);
  }
  if (ag.stale) {
    return row('opencode', 'warn', staleAgentsMessage(ag, gateway), 'sync refreshes the agent projection');
  }
  return row('opencode', 'ok', lazyAgents
    ? `lazy specialist dispatcher current (${ag.currentId})`
    : `${ag.count} converted agents (${ag.currentId})`);
}

// The loop also passes `hostId`; this renderer doesn't need it (it IS the
// opencode renderer) but the signature admits it so the dispatch call site
// typechecks for every renderer uniformly.
export async function opencodeDetailRows({ cfg, pkgRoot, facts, hostId: _hostId = 'opencode' } = /** @type {any} */ ({})) {
  const rows = [];
  try {
    if (!facts.hosts?.opencode?.present) {
      rows.push(row('opencode', 'warn', 'enabled but opencode CLI not installed', 'sync installs opencode-ai (hosts step)'));
      return rows;
    }
    const source = catalogSource({ override: cfg.integrations?.ownership?.opencode?.catalogDir });
    const st = opencodeMcpStatus(cfg);
    const lifecycle = await createOpencodeLifecycleAdapter({ pkgRoot }).detect({ cfg });
    const conv = st.parseError ? null : lifecycle.convergence;
    rows.push(opencodeWiringRow(st, conv));

    const receiptState = opencodeArtifactReceiptState(cfg.integrations?.ownership?.opencode?.managed);
    if (receiptState.adoptionBlocked) {
      rows.push(row('opencode', 'warn',
        'artifact receipt ledger is malformed — ownership adoption blocked; artifacts left untouched',
        'repair integrations.ownership.opencode.managed.artifacts in kit.json or restore it from backup',
        { repair: 'manual' }));
      return rows;
    }

    const plugRow = artifactRow('opencode', 'lifecycle plugin', lifecycle.plugin, {
      foreignMessage: 'lifecycle plugin slot occupied by a user-owned ruflo-hooks.js — ak leaves it alone',
      absentMessage: 'lifecycle plugin (ruflo-hooks.js) not deployed',
      staleMessage: 'lifecycle plugin out of date',
    });
    if (plugRow) rows.push(plugRow);

    const gatewayRow = artifactRow('opencode', 'lazy rUv gateway', lifecycle.gateway, {
      foreignMessage: 'lazy rUv gateway slot is user-owned — direct MCP exposure is preserved',
      absentMessage: 'lazy rUv gateway not deployed',
      staleMessage: 'lazy rUv gateway out of date',
      required: lifecycle.gateway.required,
      notRequiredMessage: 'lazy rUv gateway is no longer required',
      notRequiredFix: 'sync retires it',
      okMessage: 'Ruflo and Agentic QE connected; compact ak_* gateway projection active',
    });
    if (gatewayRow) rows.push(gatewayRow);

    rows.push(opencodeAgentsRow({ ag: lifecycle.agents, gateway: lifecycle.gateway, source }));

    const skillRow = artifactRow('opencode', 'platform skill', lifecycle.skill, {
      foreignMessage: 'skills/ruflo/SKILL.md is user-owned — ak leaves it alone',
      absentMessage: 'platform skill (skills/ruflo/SKILL.md) not deployed',
      staleMessage: 'platform skill out of date',
      staleFix: 'sync re-deploys it',
      required: !!source?.hasPlatformSkill,
    });
    if (skillRow) rows.push(skillRow);
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
