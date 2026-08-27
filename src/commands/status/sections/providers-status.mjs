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
import { row } from '../row.mjs';

async function defaultHostRows(cfg) {
  const rows = [];
  // advisory only (no fix): opting codex in is a deliberate `ak host pick`
  if (await have('codex')) {
    rows.push(row('providers', 'info', 'codex CLI installed but not enabled (claude-only default)'));
  } else {
    rows.push(row('providers', 'info', 'claude-only (default host)'));
  }
  if (!cfg.integrations?.hosts?.opencode && await have('opencode')) {
    rows.push(row('providers', 'info', 'opencode CLI installed but not enabled (`ak host pick --host claude,opencode` wires it)'));
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
  async collect({ cfg, cwd }) {
    const rows = [];
    try {
      const { file, scope } = settingsTarget(cwd);
      const env = readJson(file, {})?.env ?? {};
      const { unavailableIntentSet } = providerExternalState(cfg, cwd);
      if (isDefault(cfg)) {
        rows.push(...(await defaultHostRows(cfg)));
      } else {
        rows.push(driftRow(cfg, cwd, env, scope));
        const credRow = credentialChainRow(cfg, unavailableIntentSet);
        if (credRow) rows.push(credRow);
      }
    } catch (e) {
      rows.push(row('providers', 'warn', `provider check unavailable: ${e.message}`));
    }
    return rows;
  },
};
