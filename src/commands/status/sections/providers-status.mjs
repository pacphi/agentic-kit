// providers (frontier host wiring) — light: `have` probe + env read, no --version
//
// The CORE "is provider config synced" signal: env drift, aqe fallback-chain
// order drift, and chain credential viability. Split out from the ~8-concern
// monolith (ADR-complexity-program #4) so a probe failure here doesn't also
// swallow the external-intent, external-projection, ruflo-models, and
// local-bindings rows in the sibling sections below.
//
// Drift itself is judged by src/lib/providers.mjs's own comparators
// (providerEnvDrift, aqeRouterDrift) — the same dry-run computation the
// writer (applyHosts/applyAqeRouter) executes, so this section can never
// silently diverge from what `ak sync` would actually do (#129).
import { have } from '../../../lib/exec.mjs';
import {
  HOSTS, settingsTarget, isDefault, providerEnvDrift, aqeRouterDrift, credentialGaps, providerExternalState,
} from '../../../lib/providers.mjs';
import { readJson } from '../../../lib/settings.mjs';
import { hostManagement, hostEnableCommand, NOT_PARTICIPATING } from '../../../lib/host-management.mjs';
import { row } from '../row.mjs';

// One row per host in the words every surface uses (ADR-0053, 2026-09-26):
// Managed by ak / Found, not managed / Not installed. Information only and
// never a `fix`: opting a host in is a deliberate `ak host pick`, which sync
// never does. The hint names the COMPLETE --host list (pick disables any
// enabled host left out of it), built from the current enabled set.
//
// `integrationFacts` (from providers.mjs's detectHosts, already computed once
// per collect() and evidence-cached — Task 5) carries `.present` for every
// host regardless of enablement, so this reuses that fact instead of a second
// `have(h.bin)` probe of the exact same PATH question; `have` stays as a
// fallback only for a caller that passes no integrationFacts at all (a direct
// test/library call, not the status.mjs path).
async function hostManagementRows(cfg, dflt, integrationFacts) {
  const rows = [];
  for (const h of HOSTS) {
    const enabled = cfg.integrations?.hosts?.[h.id] === true;
    const present = enabled ? null
      : integrationFacts?.hosts?.[h.id]?.present ?? await have(h.bin);
    const { state, label } = hostManagement({ enabled, present });
    const tail = state === 'managed' && dflt ? ' (default host)'
      : state === 'found' ? ` — ${NOT_PARTICIPATING}; to include it: ${hostEnableCommand(cfg, h.id)}` : '';
    rows.push(row('providers', 'info', `${h.id}: ${label}${tail}`));
  }
  return rows;
}

function driftRow(cfg, cwd, env, scope) {
  const envDrift = providerEnvDrift(cfg, env);
  const { drift: routerDrift } = aqeRouterDrift(cfg, cwd);
  const chain = cfg.providers.aqeFallback ?? [];
  const on = HOSTS.filter((h) => cfg.integrations.hosts[h.id]).map((h) => h.id).join('+') || 'none';
  const chainStr = chain.length ? `; aqe chain ${chain.map((e) => e.provider).join('→')}` : '';
  return (envDrift || routerDrift)
    ? row('providers', 'warn', `provider config drifted (want ${on}${chainStr}, ${scope})`, 'sync re-applies provider env + aqe router')
    : row('providers', 'ok', `wired: ${on}${chainStr} (${scope})`);
}

// Chain VIABILITY, separate from chain ORDER above: a chain in the right
// order whose rungs have no credential fails over into nothing (#54). Warn,
// not fail — the primary rung still works — and no `fix`, since only the
// user can supply a key.
function credentialChainRow(cfg, unavailableExternalSet) {
  const chain = cfg.providers.aqeFallback ?? [];
  const credentialChain = chain.filter((entry) => !unavailableExternalSet.has(entry?.provider));
  if (!credentialChain.length) return null;
  const gaps = credentialGaps(credentialChain);
  if (gaps.length) {
    return row('providers', 'warn',
      `aqe chain: ${credentialChain.length - gaps.length}/${credentialChain.length} rungs have credentials `
      + `(${gaps.map((g) => `${g.provider}: needs ${g.missing.join(', ')}`).join('; ')})`);
  }
  return row('providers', 'ok', `aqe chain: ${credentialChain.length}/${credentialChain.length} rungs have credentials`);
}

export default {
  id: 'providers',
  async collect({ cfg, cwd, integrationFacts }) {
    const rows = [];
    try {
      const { file, scope } = settingsTarget(cwd);
      const env = readJson(file, {})?.env ?? {};
      const { unavailableIntentSet } = providerExternalState(cfg, cwd);
      const dflt = isDefault(cfg);
      if (!dflt) {
        rows.push(driftRow(cfg, cwd, env, scope));
        const credRow = credentialChainRow(cfg, unavailableIntentSet);
        if (credRow) rows.push(credRow);
      }
      rows.push(...(await hostManagementRows(cfg, dflt, integrationFacts)));
    } catch (e) {
      rows.push(row('providers', 'warn', `provider check unavailable: ${e.message}`));
    }
    return rows;
  },
};
