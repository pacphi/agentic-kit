// A remembered correction is deliberately narrower than general MCP ownership:
// one recognized user-scope alias in one absolute file, with the managed
// workspace-aware replacement still present. Never inherit historical --yes.
import { codexMcpTopology, codexMcpRepairPlan, repairCodexMcpTopology } from './mcp.mjs';
import { codexConfigPath } from './paths.mjs';
import { saveKitConfig } from './config.mjs';

function repairKey(entry) {
  if (entry?.scope !== 'user' || entry.file !== codexConfigPath()
    || entry.repairKind !== 'legacy-ruflo' || entry.name !== 'claude-flow'
    || entry.command !== 'ruflo' || JSON.stringify(entry.args) !== '["mcp","start"]') return null;
  return `${entry.file}\nclaude-flow\nruflo mcp start`;
}

function managedReplacement(cfg, topology) {
  return cfg.integrations?.hosts?.codex === true
    && cfg.integrations?.ownership?.codex?.reverseMcp === 'ak'
    && topology.effectiveRufloRegistrations.some(entry => entry.name === 'ruflo'
      && entry.command === 'ak' && JSON.stringify(entry.args) === '["x","ruflo-mcp"]');
}

function rememberedKeys(cfg) {
  const consent = cfg.integrations?.ownership?.codex?.mcpRepairConsent;
  return consent?.version === 1 && Array.isArray(consent.targets) ? consent.targets : [];
}

export function hasCodexMcpRepairConsent(cfg, entry, topology) {
  const key = repairKey(entry);
  return key !== null && managedReplacement(cfg, topology) && rememberedKeys(cfg).includes(key);
}

export function rememberCodexMcpRepairs(cfg, targets, topology) {
  if (!managedReplacement(cfg, topology)) return false;
  const prior = rememberedKeys(cfg);
  const keys = [...new Set([...prior, ...targets.map(repairKey).filter(Boolean)])];
  if (keys.length === prior.length) return false;
  cfg.integrations.ownership.codex.mcpRepairConsent = { version: 1, targets: keys };
  return true;
}

export async function confirmCodexMcpRepairs(cfg, targets, topology, { yes, confirm }) {
  if (!targets.length) return true;
  console.log(`Codex repair plan (${targets.length} action(s)):`);
  for (const entry of targets) console.log(`  • remove ${entry.file} → [mcp_servers.${entry.name}] — ${entry.reason}`);
  const pending = targets.filter(entry => !hasCodexMcpRepairConsent(cfg, entry, topology));
  if (!pending.length) {
    console.log('Using remembered consent for the recognized legacy Ruflo correction.');
    return true;
  }
  const remember = pending.some(entry => repairKey(entry) !== null);
  const question = remember
    ? 'Apply these Codex repairs and remember this recognized user-scope Ruflo correction for future setup/sync runs?'
    : 'Apply these Codex repairs?';
  console.log(question);
  return yes || await confirm(question);
}

/** Reinspect after every initializer/upgrade has finished. A new target still
 * needs approval; a changed/custom table is never eligible for remembered
 * correction. Every removal retains mcp.mjs's live fingerprint and backup gate. */
export async function reconcileCodexMcp({
  cfg, cwd, yes = false, confirm, inspect = codexMcpTopology,
  repair = repairCodexMcpTopology, save = saveKitConfig, includeProject = true,
  approvedTargets = [],
}) {
  if (!cfg.integrations?.hosts?.codex) return { ok: true, changed: false, detail: 'Codex disabled' };
  let topology = inspect({ cwd });
  const targets = codexMcpRepairPlan(topology).filter(entry => includeProject || entry.scope === 'user');
  const replacingAlias = targets.some(entry => entry.repairKind === 'legacy-ruflo');
  const hasReplacement = () => topology.effectiveRufloRegistrations.some(entry => entry.name === 'ruflo');
  if (replacingAlias && !hasReplacement()) {
    return { ok: false, changed: false,
      detail: 'canonical Ruflo replacement is missing or disabled; existing alias preserved — run ak sync to provision the replacement' };
  }
  if (targets.length) {
    const pending = targets.filter(entry => !approvedTargets.some(prior =>
      prior.file === entry.file && prior.scope === entry.scope && prior.name === entry.name
      && prior.fingerprint === entry.fingerprint && prior.repairKind === entry.repairKind));
    if (!await confirmCodexMcpRepairs(cfg, pending, topology, { yes, confirm })) {
      return { ok: false, changed: false, detail: 'Codex repair declined; remaining registrations were preserved' };
    }
    const result = await repair(targets, cwd);
    if (!result.ok) return result;
    topology = inspect({ cwd });
    if (replacingAlias && !hasReplacement()) {
      return { ok: false, changed: true, detail: 'canonical Ruflo replacement disappeared during repair' };
    }
    if (rememberCodexMcpRepairs(cfg, targets, topology)) save(cfg);
  }
  if (topology.duplicateRuflo) {
    return { ok: false, changed: targets.length > 0,
      detail: 'duplicate Ruflo registrations remain; custom or unrecognized entries require review before removal' };
  }
  if (topology.selfRegistrations.some(entry => includeProject || entry.scope === 'user')) {
    return { ok: false, changed: targets.length > 0,
      detail: 'recursive Codex MCP registration remains; custom entries require review before removal' };
  }
  return { ok: true, changed: targets.length > 0, detail: 'Codex MCP topology verified after provisioning' };
}
