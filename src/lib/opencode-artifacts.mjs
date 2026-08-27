// opencode-artifacts.mjs — the plugin (lifecycle bridge + lazy rUv gateway)
// and platform-skill deployment, plus the shared teardown (removeArtifacts).
// Split out of opencode.mjs (ADR-0037's file-size gate) — behavior and
// export names are unchanged; opencode.mjs re-exports the
// externally-consumed names so no import path elsewhere in the repo needed
// to change.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { contentHash, hasReceiptValue, receiptMatches } from './opencode-receipts.mjs';
import { parseFrontmatter, SPECIALIST_AGENT, STAMP_FILE } from './opencode-agents.mjs';

/** @typedef {import('./opencode-agents.mjs').CatalogSource} CatalogSource */

// ── plugin (lifecycle bridge) ────────────────────────────────────────────────

export const PLUGIN_NAME = 'ruflo-hooks.js';
export const GATEWAY_PLUGIN_NAME = 'ruflo-gateway.js';
const pluginTemplate = (pkgRoot) => path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-hooks.js');
const gatewayPluginTemplate = (pkgRoot) => path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-gateway.js');

/** The marker any ak-deployed plugin copy carries (from the template header). */
const PLUGIN_MARKER = 'src/templates/opencode-ruflo-hooks.js';
const GATEWAY_PLUGIN_MARKER = 'src/templates/opencode-ruflo-gateway.js';

function deployManagedPlugin({
  template, marker, name, label, pluginsDir, dryRun, receipt, adoptionBlocked,
  desiredText = null,
}) {
  if (!fs.existsSync(template)) return { ok: false, changed: false, detail: `template missing: ${template}` };
  const want = desiredText ?? fs.readFileSync(template, 'utf8');
  const dest = path.join(pluginsDir, name);
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  const hasReceipt = adoptionBlocked || hasReceiptValue(receipt);
  const adoptable = cur === want && !hasReceipt && cur.includes(marker);
  if (cur === want && (receiptMatches(cur, receipt) || adoptable)) {
    return {
      ok: true, changed: false, receipt: contentHash(cur), adopted: adoptable,
      detail: adoptable ? `${label} adopted into receipt ledger` : `${label} current`,
    };
  }
  if (cur !== null && (!hasReceipt || !receiptMatches(cur, receipt))) {
    return { ok: true, changed: false, receipt, detail: `⚠ ${dest} differs from ak's last-written receipt (user-owned/edited) — left untouched` };
  }
  if (!want.includes(marker)) return { ok: false, changed: false, receipt, detail: `template marker missing: ${marker}` };
  if (!dryRun) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(dest, want);
  }
  return {
    ok: true,
    changed: true,
    receipt: contentHash(want),
    detail: cur == null ? `${label} deployed (${name})` : `${label} updated (${name})`,
  };
}

function managedPluginStatus({
  template, marker, name, pluginsDir, receipt, adoptionBlocked, desiredText = null,
}) {
  const dest = path.join(pluginsDir, name);
  const present = fs.existsSync(dest);
  const currentText = present ? fs.readFileSync(dest, 'utf8') : null;
  const desired = fs.existsSync(template) ? (desiredText ?? fs.readFileSync(template, 'utf8')) : null;
  const hasReceipt = adoptionBlocked || hasReceiptValue(receipt);
  const receiptOwned = present && receiptMatches(currentText, receipt);
  const adoptable = present && !hasReceipt && desired !== null
    && currentText === desired && currentText.includes(marker);
  const foreign = present && !receiptOwned && !adoptable;
  return {
    present,
    current: present && !foreign && desired !== null && currentText === desired,
    foreign,
    adoptable,
    adoptionBlocked,
  };
}

/** Deploy the lifecycle bridge plugin from the kit's template, content-diffed
 *  (rewrites only when the template changed — hash-stamped by content itself).
 *  A destination file that exists WITHOUT the ak marker is user-owned:
 *  preserved and reported, never overwritten.
 *  @param {{ pkgRoot: string, pluginsDir?: string, dryRun?: boolean, receipt?:string|null, adoptionBlocked?:boolean }} opts */
export function deployPlugin({
  pkgRoot, pluginsDir = paths.opencodePluginsDir(), dryRun = false, receipt = null,
  adoptionBlocked = false,
}) {
  return deployManagedPlugin({
    template: pluginTemplate(pkgRoot), marker: PLUGIN_MARKER, name: PLUGIN_NAME,
    label: 'lifecycle plugin', pluginsDir, dryRun, receipt, adoptionBlocked,
  });
}

const GATEWAY_MCP_PLACEHOLDER = '/* AK_MANAGED_MCP_ENTRIES */ {}';
const GATEWAY_AGENT_PLACEHOLDER = '/* AK_MANAGED_AGENT_CATALOG */ []';
const GATEWAY_SPECIALIST_PLACEHOLDER = '/* AK_SPECIALIST_AGENT_PROMPT */ ""';

function gatewayDesiredText(pkgRoot, managedMcp, agentCatalog = []) {
  const template = gatewayPluginTemplate(pkgRoot);
  if (!fs.existsSync(template)) return null;
  const source = fs.readFileSync(template, 'utf8');
  for (const [placeholder, label] of [
    [GATEWAY_MCP_PLACEHOLDER, 'managed-MCP'],
    [GATEWAY_AGENT_PLACEHOLDER, 'managed-agent'],
    [GATEWAY_SPECIALIST_PLACEHOLDER, 'specialist-agent'],
  ]) {
    const first = source.indexOf(placeholder);
    if (first < 0 || source.indexOf(placeholder, first + 1) >= 0) {
      throw new Error(`lazy gateway template must contain exactly one ${label} placeholder`);
    }
  }
  const stable = Object.fromEntries(Object.entries(managedMcp ?? {})
    .sort(([a], [b]) => a.localeCompare(b)));
  const specialistPrompt = parseFrontmatter(SPECIALIST_AGENT.content)?.body.trim() ?? '';
  return source
    .replace(GATEWAY_MCP_PLACEHOLDER, JSON.stringify(stable))
    .replace(GATEWAY_AGENT_PLACEHOLDER, JSON.stringify(agentCatalog))
    .replace(GATEWAY_SPECIALIST_PLACEHOLDER, JSON.stringify(specialistPrompt));
}

/** Deploy the lazy Ruflo/Agentic-QE catalogue gateway for stock OpenCode. */
export function deployGatewayPlugin({
  pkgRoot, managedMcp = {}, agentCatalog = [], pluginsDir = paths.opencodePluginsDir(), dryRun = false,
  receipt = null, adoptionBlocked = false,
}) {
  return deployManagedPlugin({
    template: gatewayPluginTemplate(pkgRoot), marker: GATEWAY_PLUGIN_MARKER,
    name: GATEWAY_PLUGIN_NAME, label: 'lazy rUv gateway', pluginsDir, dryRun,
    receipt, adoptionBlocked, desiredText: gatewayDesiredText(pkgRoot, managedMcp, agentCatalog),
  });
}

/** Remove only exact receipt-owned gateway bytes when no rUv family remains
 * safe to capture. User-edited/unreceipted files are preserved. */
export function retireGatewayPlugin({
  pluginsDir = paths.opencodePluginsDir(), receipt = null, dryRun = false,
} = {}) {
  const dest = path.join(pluginsDir, GATEWAY_PLUGIN_NAME);
  if (!fs.existsSync(dest)) {
    return { ok: true, changed: false, receipt: null, detail: 'lazy gateway not deployed' };
  }
  const current = fs.readFileSync(dest, 'utf8');
  if (!receipt || !receiptMatches(current, receipt)) {
    return {
      ok: false, changed: false, receipt,
      detail: `⚠ ${dest} is not provably ak-owned; left untouched`,
    };
  }
  if (!dryRun) fs.rmSync(dest, { force: true });
  return { ok: true, changed: true, receipt: null, detail: 'lazy rUv gateway retired' };
}

/** Plugin presence/currency against the kit template. `foreign` flags a
 *  user-owned file occupying the destination (status must not nag to
 *  overwrite it — deploy will leave it alone). */
export function pluginStatus({
  pkgRoot, pluginsDir = paths.opencodePluginsDir(), receipt = null, adoptionBlocked = false,
}) {
  return managedPluginStatus({
    template: pluginTemplate(pkgRoot), marker: PLUGIN_MARKER, name: PLUGIN_NAME,
    pluginsDir, receipt, adoptionBlocked,
  });
}

/** Lazy gateway presence/currency against its embedded, receipt-bound MCP commands. */
export function gatewayPluginStatus({
  pkgRoot, managedMcp = {}, agentCatalog = [], pluginsDir = paths.opencodePluginsDir(), receipt = null,
  adoptionBlocked = false,
}) {
  return managedPluginStatus({
    template: gatewayPluginTemplate(pkgRoot), marker: GATEWAY_PLUGIN_MARKER,
    name: GATEWAY_PLUGIN_NAME, pluginsDir, receipt, adoptionBlocked,
    desiredText: gatewayDesiredText(pkgRoot, managedMcp, agentCatalog),
  });
}

// ── platform skill ───────────────────────────────────────────────────────────

const SKILL_DEPLOYED_MARKER = '<!-- deployed by agentic-kit -->';

/** Deploy ruflo's platform SKILL.md (from the catalog source) into opencode's
 *  global skills dir, stamped with the source id for drift detection. A
 *  destination SKILL.md without the ak marker is user-owned: preserved.
 *  @param {{ source: CatalogSource|null, skillsDir?: string, dryRun?: boolean, receipt?:string|null, adoptionBlocked?:boolean }} opts */
export function deploySkill({
  source, skillsDir = paths.opencodeSkillsDir(), dryRun = false, receipt = null,
  adoptionBlocked = false,
}) {
  if (!source?.hasPlatformSkill) return { ok: true, changed: false, detail: `no platform SKILL.md in catalog source${source ? ` (${source.id})` : ''}` };
  const src = path.join(source.root, 'SKILL.md');
  const dest = path.join(skillsDir, 'ruflo', 'SKILL.md');
  const want = `${fs.readFileSync(src, 'utf8').replace(/\s*$/, '')}\n\n${SKILL_DEPLOYED_MARKER} from ${source.id} — re-synced by \`ak sync\`\n`;
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  const hasReceipt = adoptionBlocked || hasReceiptValue(receipt);
  const adoptable = cur === want && !hasReceipt && cur.includes(SKILL_DEPLOYED_MARKER);
  if (cur === want && (receiptMatches(cur, receipt) || adoptable)) {
    return {
      ok: true, changed: false, receipt: contentHash(cur), adopted: adoptable,
      detail: adoptable ? 'platform skill adopted into receipt ledger' : 'platform skill current',
    };
  }
  if (cur !== null && (!hasReceipt || !receiptMatches(cur, receipt))) {
    return { ok: true, changed: false, receipt, detail: `⚠ ${dest} differs from ak's last-written receipt (user-owned/edited) — left untouched` };
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
  }
  return { ok: true, changed: true, receipt: contentHash(want), detail: `platform skill deployed (skills/ruflo/SKILL.md, ${source.id})` };
}

/** Platform skill presence/currency against the catalog source id. `foreign`
 *  flags a user-owned SKILL.md at the destination.
 *  @param {{ source?: CatalogSource|null, skillsDir?: string, receipt?:string|null, adoptionBlocked?:boolean }} [opts] */
export function skillStatus({
  source, skillsDir = paths.opencodeSkillsDir(), receipt = null, adoptionBlocked = false,
} = {}) {
  const dest = path.join(skillsDir, 'ruflo', 'SKILL.md');
  const present = fs.existsSync(dest);
  const text = present ? fs.readFileSync(dest, 'utf8') : null;
  const sourceFile = source?.hasPlatformSkill ? path.join(source.root, 'SKILL.md') : null;
  const desired = sourceFile && fs.existsSync(sourceFile)
    ? `${fs.readFileSync(sourceFile, 'utf8').replace(/\s*$/, '')}\n\n${SKILL_DEPLOYED_MARKER} from ${source.id} — re-synced by \`ak sync\`\n`
    : null;
  const hasReceipt = adoptionBlocked || hasReceiptValue(receipt);
  const receiptOwned = present && receiptMatches(text, receipt);
  const adoptable = present && !hasReceipt && desired !== null
    && text === desired && text.includes(SKILL_DEPLOYED_MARKER);
  const foreign = present && !receiptOwned && !adoptable;
  return {
    present,
    foreign,
    adoptable,
    adoptionBlocked,
    current: present && !foreign && desired != null && text === desired,
  };
}

/** Remove `file` only when it exists and its content hash exactly matches
 *  `receipt` (provable ak ownership); push `label` onto `removed` when given.
 *  Returns whether the file was removed. */
function removeIfReceiptOwned(file, receipt, label, removed) {
  if (!fs.existsSync(file) || !receipt) return false;
  if (contentHash(fs.readFileSync(file, 'utf8')) !== receipt) return false;
  fs.rmSync(file, { force: true });
  if (label) removed.push(label);
  return true;
}

/** Remove receipt-owned generated agent files + the stamp file, pushing a
 *  single summary label for the count of agents removed. */
function removeGeneratedAgents(agentsDir, receipts, removed) {
  if (!fs.existsSync(agentsDir)) return;
  let n = 0;
  for (const f of fs.readdirSync(agentsDir)) {
    const p = path.join(agentsDir, f);
    if (f === STAMP_FILE) { removeIfReceiptOwned(p, receipts.agentStamp, null, removed); continue; }
    if (f.endsWith('.md') && removeIfReceiptOwned(p, receipts.agents?.[f], null, removed)) n++;
  }
  if (n) removed.push(`${n} generated agents`);
}

/** Remove ak-deployed artifacts (marker-gated — user files are never touched):
 *  the lifecycle plugin, generated agents (+ stamp), the platform skill's
 *  SKILL.md. Directories are pruned only when EMPTY after the managed files
 *  are gone — user resources placed beside them survive.
 *  @param {{ pluginsDir?: string, agentsDir?: string, skillsDir?: string, receipts?:any }} [opts] */
export function removeArtifacts({
  pluginsDir = paths.opencodePluginsDir(), agentsDir = paths.opencodeAgentsDir(),
  skillsDir = paths.opencodeSkillsDir(), receipts = {},
} = {}) {
  const removed = [];
  const rmdirIfEmpty = (dir) => {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* absent or not empty */ }
  };
  removeIfReceiptOwned(path.join(pluginsDir, PLUGIN_NAME), receipts.plugin, 'plugin ruflo-hooks.js', removed);
  removeIfReceiptOwned(path.join(pluginsDir, GATEWAY_PLUGIN_NAME), receipts.gateway, 'plugin ruflo-gateway.js', removed);
  removeGeneratedAgents(agentsDir, receipts, removed);
  const skillDir = path.join(skillsDir, 'ruflo');
  if (removeIfReceiptOwned(path.join(skillDir, 'SKILL.md'), receipts.skill, 'platform skill', removed)) {
    rmdirIfEmpty(skillDir);
  }
  return { ok: true, changed: removed.length > 0, detail: removed.length ? `removed: ${removed.join(', ')}` : 'no ak-deployed artifacts found' };
}
