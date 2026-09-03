// opencode-core.mjs — opencode.json config-wiring: the receipt-owned
// reconcile/status/teardown pair (applyOpencode/undoOpencode,
// opencodeConverged/opencodeMcpStatus) at the heart of the third host
// adapter's I/O half. Split out of opencode.mjs (ADR-0037's file-size gate);
// opencode.mjs re-exports this module's public names, and
// opencode-lifecycle.mjs composes them with opencode-agents.mjs /
// opencode-artifacts.mjs into the full enable/retire stack.
//
// why: opencode (opencode.ai) consumes the same rUv stack as claude/codex but
// through different surfaces. This module owns every ak-managed byte on those
// surfaces, backup-first + merge-not-clobber + ownership-marked, mirroring the
// claude (settings.mjs / mcp.mjs) and codex (providers.mjs Ruflo integration)
// contracts:
//
//   ~/.config/opencode/opencode.json   mcp.claude-flow + mcp.agentic-qe +
//                                      mcp.ruvnet-brain,
//                                      skills.paths, permission patterns
//   ~/.config/opencode/AGENTS.md       guidance blocks (blocks.mjs target
//                                      'agents-opencode' — NOT here)
//   ~/.config/opencode/plugins/ruflo-hooks.js   lifecycle bridge (opencode has
//                                      no settings-hooks surface; its plugin
//                                      events are the hook spine)
//   ~/.config/opencode/plugins/ruflo-gateway.js lazy bridges to the complete
//                                      live Ruflo and Agentic QE catalogues
//   ~/.config/opencode/agents/ak-specialist.md
//                                      one stock subagent; receipt-owned rUv
//                                      profiles stay embedded and load lazily
//   ~/.config/opencode/skills/ruflo/   the platform SKILL.md
//
// Grounded:
//   - opencode.json schema (https://opencode.ai/config.json): mcp local
//     servers {type,command[],environment,enabled,timeout}, skills.paths[],
//     permission as wildcard tool-name patterns (MCP tools surface as
//     `<server>_<tool>`, hence the claude-flow_*/agentic-qe_*/ruvnet-brain_* patterns).
//   - ruflo's own init/mcp-generator.ts env block (CLAUDE_FLOW_* below).
//   - `claude-flow-mcp` (the dedicated stdio bin of @claude-flow/cli) answers
//     initialize directly; `ruflo mcp start` is the fallback (what ak already
//     registers for claude/codex) when that bin is absent.
//   - ruvnet-brain's stable-spine shim (~/.claude/ruvnet-brain/mcp/server.mjs)
//     hot-swaps brain versions — the registration never needs rewriting.
//   - opencode.json may legally contain JSONC comments ($schema allowComments):
//     a file we cannot parse is REFUSED, never clobbered.
import fs from 'node:fs';
import path from 'node:path';
import { have } from './exec.mjs';
import { writeJsonWithBackup } from './settings.mjs';
import { CURRENT_INTEGRATIONS_VERSION } from './adapters/config.mjs';
import * as paths from './paths.mjs';
import { deepEqual, hasReceiptValue } from './opencode-receipts.mjs';
import { catalogSource, skillPathsFor } from './opencode-agents.mjs';
import { managedAgentBrowserEnv } from './agent-browser.mjs';

export const opencodeOwnership = (cfg) => cfg?.integrations?.ownership?.opencode ?? {};
export function mutableOpencodeOwnership(cfg) {
  cfg.integrations ??= {
    version: CURRENT_INTEGRATIONS_VERSION,
    hosts: {},
    bindings: [],
  };
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.opencode ??= {};
  return cfg.integrations.ownership.opencode;
}

// ── config-file wiring (opencode.json) ──────────────────────────────────────

/** ruflo init/mcp-generator.ts's env block, mirrored for parity. */
export const RUFLO_MCP_ENV = {
  npm_config_update_notifier: 'false',
  CLAUDE_FLOW_MODE: 'v3',
  CLAUDE_FLOW_HOOKS_ENABLED: 'true',
  CLAUDE_FLOW_TOPOLOGY: 'hierarchical-mesh',
  CLAUDE_FLOW_MAX_AGENTS: '15',
  CLAUDE_FLOW_MEMORY_BACKEND: 'hybrid',
};

/** agentic-qe init's project MCP environment, mirrored for OpenCode. */
export const AQE_MCP_ENV = {
  AQE_LEARNING_ENABLED: 'true',
  AQE_WORKERS_ENABLED: 'true',
  NODE_ENV: 'production',
};

/** Permission patterns follow the rUv capabilities AK actually projects. */
function permissionFamiliesFor(entries) {
  return [
    ...('claude-flow' in entries ? [['claude-flow_*', 'claude_flow_*']] : []),
    ...('agentic-qe' in entries ? [['agentic-qe_*', 'agentic_qe_*']] : []),
    ...('ruvnet-brain' in entries ? [['ruvnet-brain_*', 'ruvnet_brain_*']] : []),
  ];
}

function permissionKeysFor(entries) {
  return permissionFamiliesFor(entries).flat();
}

/** The brain's stable-spine shim (same registration codex carries). */
export const brainShimPath = () => path.join(paths.home, '.claude', 'ruvnet-brain', 'mcp', 'server.mjs');

/** The dedicated stdio MCP server bundled inside a plain `npm i -g ruflo`
 *  install (nested dependency — present even when no claude-flow-mcp bin is
 *  on PATH). */
export const nestedMcpServerPath = () =>
  path.join(paths.rufloNodeModules(), '@claude-flow', 'cli', 'bin', 'mcp-server.js');

/** The claude-flow MCP command, best-available-first: the claude-flow-mcp bin
 *  on PATH → the nested mcp-server.js via absolute node path (no PATH/cwd
 *  dependence — the fresh ruflo-only machine case) → `ruflo mcp start` (ak's
 *  claude/codex registration path, always present when ruflo is). Pure. */
export function mcpCommandFor({ binPresent, nestedPath }) {
  if (binPresent) return ['claude-flow-mcp'];
  if (nestedPath && fs.existsSync(nestedPath)) return ['node', nestedPath];
  return ['ruflo', 'mcp', 'start'];
}

/** @typedef {{ kind: string, root: string, id: string, hasPlugins: boolean, hasPlatformSkill: boolean }} CatalogSource */

/** The MCP server entries ak writes. `claude-flow` resolves via mcpCommandFor
 *  (bin on PATH → nested mcp-server.js → `ruflo mcp start`). Agentic QE is
 *  included by default because machine setup installs it; `--no-aqe` disables
 *  that projection. ruvnet-brain is included only when its shim is on disk.
 *  @param {{ brainShim?: string, nestedPath?: string, includeAqe?: boolean,
 *            agentBrowserEnabled?: boolean }} [opts] */
export async function mcpEntriesFor({
  brainShim = brainShimPath(), nestedPath = nestedMcpServerPath(), includeAqe = true,
  agentBrowserEnabled = true,
} = {}) {
  const entries = {
    'claude-flow': {
      type: 'local',
      command: mcpCommandFor({ binPresent: await have('claude-flow-mcp'), nestedPath }),
      enabled: true,
      timeout: 30000,
      environment: {
        ...RUFLO_MCP_ENV,
        ...managedAgentBrowserEnv({ enabled: agentBrowserEnabled }),
      },
    },
  };
  if (includeAqe) {
    entries['agentic-qe'] = {
      type: 'local',
      command: ['aqe-mcp'],
      enabled: true,
      timeout: 30000,
      environment: { ...AQE_MCP_ENV },
    };
  }
  if (fs.existsSync(brainShim)) {
    entries['ruvnet-brain'] = { type: 'local', command: ['node', brainShim], enabled: true, timeout: 30000 };
  }
  return entries;
}

/** Strict read: distinguishes "absent/empty" from "present but not plain JSON"
 *  (opencode.json may legally be JSONC). NB: settings.readJson's fallback
 *  parameter can't express this — passing undefined re-triggers its default. */
function readJsonStrict(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { ok: true, doc: {} };
    return { ok: true, doc: JSON.parse(raw) };
  } catch {
    return { ok: false, doc: null };
  }
}

/** OpenCode loads opencode.jsonc after opencode.json. A sibling JSONC file can
 *  shadow managed MCP, permission, or plugin values, and AK deliberately does
 *  not normalize or rewrite user comments. */
function laterJsoncOverride(configFile) {
  if (path.basename(configFile) !== 'opencode.json') return null;
  const candidate = path.join(path.dirname(configFile), 'opencode.jsonc');
  return fs.existsSync(candidate) ? candidate : null;
}

/** Registration state, spawn-free (mirrors mcp.mjs registrationStatus's
 *  file-read approach). `parseError` distinguishes "absent" from "present but
 *  not plain JSON" (JSONC) — the writer refuses the latter.
 *  @param {any} cfg @param {{ configFile?: string }} [opts] */
export function opencodeMcpStatus(cfg, { configFile = paths.opencodeConfigPath() } = {}) {
  const exists = fs.existsSync(configFile);
  const laterOverride = laterJsoncOverride(configFile);
  const { ok, doc } = exists ? readJsonStrict(configFile) : { ok: true, doc: {} };
  if (!ok) {
    return {
      exists, parseError: true, laterOverride, claudeFlow: false, aqe: false, brain: false,
      owned: opencodeOwnership(cfg).mcp === 'ak',
    };
  }
  return {
    exists,
    parseError: false,
    laterOverride,
    claudeFlow: !!doc?.mcp?.['claude-flow'],
    aqe: !!doc?.mcp?.['agentic-qe'],
    brain: !!doc?.mcp?.['ruvnet-brain'],
    paths: doc?.skills?.paths ?? [],
    owned: opencodeOwnership(cfg).mcp === 'ak',
  };
}

/** mcp.<name> reasons: missing entirely, or present but drifted from desired. */
function mcpConvergenceReasons(doc, entries) {
  const reasons = [];
  for (const [name, want] of Object.entries(entries)) {
    if (!(name in (doc.mcp ?? {}))) reasons.push(`${name} missing`);
    else if (!deepEqual(doc.mcp[name], want)) reasons.push(`${name} drifted`);
  }
  return reasons;
}

/** A previously-owned key that fell out of the desired set but still equals
 *  what ak wrote is stale — shared shape for managed.mcp and
 *  managed.permissions convergence reasons. */
function staleOwnedReasons(records, desiredKeys, currentValues, label) {
  const reasons = [];
  for (const [key, rec] of Object.entries(records)) {
    if (desiredKeys.has(key) || rec.written == null) continue;
    if (deepEqual(currentValues?.[key], rec.written)) reasons.push(label(key));
  }
  return reasons;
}

function skillPathReasons(doc, skillPaths) {
  return skillPaths
    .filter((p) => !(doc.skills?.paths ?? []).includes(p))
    .map((p) => `skills path missing: ${p}`);
}

function permissionAllowReasons(doc, permissionKeys) {
  return permissionKeys
    .filter((k) => doc.permission?.[k] !== 'allow')
    .map((k) => `permission ${k} not allowed`);
}

/** Convergence check — deeper than key existence (codex-review #16): the MCP
 *  entries must EQUAL today's desired values (command/env/timeout drift when
 *  the user edits them or a kit upgrade changes the template), desired skills
 *  paths must all be present, desired permission patterns must be 'allow', and
 *  a ruvnet-brain entry whose shim has vanished is stale. Async because the
 *  desired entries probe the claude-flow-mcp bin (one `which`, matching the
 *  spawn profile of status's hosts rows).
 *  @param {any} cfg @param {{ configFile?: string, brainShim?: string }} [opts] */
export async function opencodeConverged(cfg, { configFile = paths.opencodeConfigPath(), brainShim } = {}) {
  const st = opencodeMcpStatus(cfg, { configFile });
  if (!st.exists || st.parseError) return { converged: false, reasons: st.parseError ? ['unparseable config'] : ['no config file'] };
  if (st.laterOverride) {
    return {
      converged: false,
      reasons: [`later OpenCode config override is unverified: ${st.laterOverride}`],
    };
  }
  const doc = readJsonStrict(configFile).doc;
  const entries = await mcpEntriesFor({
    brainShim, includeAqe: cfg.aqe !== false, agentBrowserEnabled: cfg.agentBrowser !== false,
  });
  const managed = normalizeManaged(opencodeOwnership(cfg).managed);
  const ownedEntries = Object.fromEntries(Object.entries(entries).filter(
    ([name]) => managed.mcp[name]?.written != null,
  ));
  const permissionKeys = permissionKeysFor(ownedEntries);
  const source = catalogSource({ override: opencodeOwnership(cfg).catalogDir });
  const reasons = [
    ...mcpConvergenceReasons(doc, entries),
    ...staleOwnedReasons(managed.mcp, new Set(Object.keys(entries)), doc.mcp, (name) => `${name} stale (no longer desired)`),
    ...skillPathReasons(doc, skillPathsFor(source)),
    ...permissionAllowReasons(doc, permissionKeys),
    ...staleOwnedReasons(managed.permissions, new Set(permissionKeys), doc.permission, (key) => `permission ${key} stale (no longer desired)`),
  ];
  return { converged: reasons.length === 0, reasons };
}

/** Normalize an opencodeManaged record — the current precise shape
 *  { mcp: {name:{prior,written}}, paths: [], permissions: {key:{prior,written}} },
 *  tolerating the legacy names-only shape from the first shipped version
 *  (legacy entries have unknown prior/written → treated conservatively: prior
 *  null, written null → never auto-deleted, only re-recorded on next apply). */
/** Normalize a legacy-tolerant names-or-{prior,written}-records collection
 *  (used identically for both m.mcp and m.permissions). */
function normalizeOwnedRecordMap(source) {
  const names = Array.isArray(source) ? source : Object.keys(source ?? {});
  const out = {};
  for (const n of names) {
    const rec = Array.isArray(source) ? null : source[n];
    out[n] = rec && typeof rec === 'object' && 'written' in rec ? rec : { prior: null, written: null };
  }
  return out;
}

/** Normalize the artifacts sub-container into `out.artifacts`/`out.artifactState`. */
function normalizeManagedArtifacts(m, out) {
  if (hasReceiptValue(m.artifacts)) {
    out.artifactState.rawContainer = structuredClone(m.artifacts);
  }
  if (hasReceiptValue(m.artifacts)
      && (typeof m.artifacts !== 'object' || Array.isArray(m.artifacts))) {
    out.artifactState.containerMalformed = true;
    return;
  }
  const artifacts = m.artifacts ?? {};
  out.artifacts.plugin = hasReceiptValue(artifacts.plugin) ? artifacts.plugin : null;
  out.artifacts.gateway = hasReceiptValue(artifacts.gateway) ? artifacts.gateway : null;
  out.artifacts.agentStamp = hasReceiptValue(artifacts.agentStamp) ? artifacts.agentStamp : null;
  out.artifacts.skill = hasReceiptValue(artifacts.skill) ? artifacts.skill : null;
  if (hasReceiptValue(artifacts.agents)
      && (typeof artifacts.agents !== 'object' || Array.isArray(artifacts.agents))) {
    out.artifactState.agentsMalformed = true;
  } else if (artifacts.agents) {
    out.artifacts.agents = Object.fromEntries(
      Object.entries(artifacts.agents).filter(([, hash]) => hasReceiptValue(hash)),
    );
  }
}

export function normalizeManaged(m) {
  const out = {
    mcp: {}, paths: [], permissions: {}, permissionScalar: null,
    artifacts: { plugin: null, gateway: null, agents: {}, agentStamp: null, skill: null },
    artifactState: {
      containerMalformed: false, agentsMalformed: false,
      rawContainer: null,
    },
  };
  if (!m || typeof m !== 'object') return out;
  out.mcp = normalizeOwnedRecordMap(m.mcp);
  out.paths = Array.isArray(m.paths) ? [...m.paths] : [];
  out.permissions = normalizeOwnedRecordMap(m.permissions);
  out.permissionScalar = typeof m.permissionScalar === 'string' ? m.permissionScalar : null;
  normalizeManagedArtifacts(m, out);
  return out;
}

/** Read-only artifact receipt boundary shared by lifecycle and status paths.
 *  Only null/absent containers represent a pre-receipts migration gap;
 *  malformed non-null containers fail closed and block adoption. */
export function opencodeArtifactReceiptState(managed) {
  const normalized = normalizeManaged(managed);
  const blocked = normalized.artifactState.containerMalformed
    || normalized.artifactState.agentsMalformed;
  return {
    receipts: normalized.artifacts,
    adoptionBlocked: blocked,
    agentsAdoptionBlocked: blocked,
  };
}

/** Exact MCP values the lazy gateway may capture. A same-name entry is not
 * enough: the command and both direct permission spellings must still match
 * values positively recorded as AK-written. Explicit direct-tool enablement
 * is an operator opt-out from lazy capture. */
export function managedGatewayMcp(cfg, { configFile = paths.opencodeConfigPath() } = {}) {
  const managed = normalizeManaged(opencodeOwnership(cfg).managed);
  const parsed = fs.existsSync(configFile) ? readJsonStrict(configFile) : { ok: true, doc: {} };
  const tools = parsed.ok ? (parsed.doc?.tools ?? {}) : {};
  const permissions = parsed.ok && typeof parsed.doc?.permission === 'object'
    ? parsed.doc.permission
    : {};
  const families = {
    'claude-flow': ['claude-flow_*', 'claude_flow_*'],
    'agentic-qe': ['agentic-qe_*', 'agentic_qe_*'],
  };
  return Object.fromEntries(Object.entries(families)
    .filter(([name, keys]) => managed.mcp[name]?.written != null
      && keys.every((key) => managed.permissions[key]?.written === 'allow'
        && permissions[key] === 'allow')
      && !keys.some((key) => tools[key] === true))
    .map(([name]) => [name, structuredClone(managed.mcp[name].written)]));
}

/** Generic receipt-owned key→value map reconciler: prune-stale-owned →
 *  collision-detect → adopt/own with {prior, written} records. This is the
 *  ONE algorithm behind applyOpencode's mcp block and (behind the
 *  family-atomicity wrapper below) its permission block — previously
 *  hand-instantiated per surface (the audit's `reconcileOwnedMap` finding).
 *  Mutates `obj` in place; returns the new {prior,written} ledger for every
 *  key in `desiredEntries`.
 *  @param {Record<string, any>} obj @param {[string, any][]} desiredEntries
 *  @param {Record<string, {prior:any, written:any}>} prevRecords
 *  @param {{ collisions: string[], pruned: string[], pruneLabel: (key:string) => string, collisionLabel: (key:string) => string }} opts */
function reconcileOwnedMap(obj, desiredEntries, prevRecords, { collisions, pruned, pruneLabel, collisionLabel }) {
  const desiredKeys = new Set(desiredEntries.map(([key]) => key));
  for (const [key, rec] of Object.entries(prevRecords)) {
    if (desiredKeys.has(key) || !(key in obj)) continue;
    if (rec.written && deepEqual(obj[key], rec.written)) {
      // RESTORE the prior when there was one (a user entry that happened to
      // equal the old desired value is a user value, not ak's to delete);
      // delete only what ak itself created (codex-review r2).
      if (rec.prior != null) { obj[key] = rec.prior; pruned.push(`${pruneLabel(key)} (prior restored)`); }
      else { delete obj[key]; pruned.push(pruneLabel(key)); }
    } // else: user edited (or legacy record) → leave it, keep no ownership
  }
  const managed = {};
  for (const [key, want] of desiredEntries) {
    const cur = obj[key];
    const priorRec = prevRecords[key];
    if (cur !== undefined && !deepEqual(cur, want) && !(priorRec?.written && deepEqual(cur, priorRec.written))) {
      collisions.push(collisionLabel(key));
      managed[key] = { prior: cur, written: null }; // tracked but NOT ak-owned
      continue;
    }
    // A previously-colliding (never ak-authored) value the USER has since
    // aligned to the desired one stays unmanaged: adopting it with the stale
    // pre-collision prior would make undo overwrite the user's own later
    // choice (codex-review r2). Noted, not owned.
    if (priorRec && priorRec.written == null && cur !== undefined && deepEqual(cur, want)) {
      managed[key] = { prior: priorRec.prior, written: null };
      continue;
    }
    // prior is the ORIGINAL pre-ak value (kept across reapplies), never the
    // ak-written value currently in place.
    managed[key] = { prior: priorRec ? priorRec.prior : (cur ?? null), written: want };
    obj[key] = want;
  }
  return managed;
}

/** Family-atomicity wrapper for permissions: a family's members (both
 *  claude-flow_* and claude_flow_* spellings) must ALL be free of collision
 *  before ANY of them join this run's desired permission set — a
 *  same-name MCP collision must never let AK add broad `allow` on the
 *  sibling spelling. A blocked family's present members are recorded
 *  {prior, written:null} (never applied via reconcileOwnedMap) and reported
 *  as a collision when their value isn't already the desired 'allow'.
 *  @param {Record<string, any>} ownedEntries @param {Record<string, any>} current
 *  @param {Record<string, {prior:any, written:any}>} prevRecords
 *  @param {{ collisions: string[] }} opts
 *  @returns {{ desiredKeys: string[], managed: Record<string, {prior:any, written:any}> }} */
function reconcileFamilyPermissions(ownedEntries, current, prevRecords, { collisions }) {
  const desiredKeys = [];
  const managed = {};
  for (const keys of permissionFamiliesFor(ownedEntries)) {
    const blocked = keys.some((key) => {
      const cur = current[key];
      const priorRec = prevRecords[key];
      const conflicts = cur !== undefined && cur !== 'allow'
        && !(priorRec?.written && deepEqual(cur, priorRec.written));
      const previouslyUnowned = cur !== undefined && priorRec && priorRec.written == null;
      return conflicts || previouslyUnowned;
    });
    if (!blocked) {
      desiredKeys.push(...keys);
      continue;
    }
    for (const key of keys) {
      const cur = current[key];
      const priorRec = prevRecords[key];
      if (cur !== undefined && cur !== 'allow'
          && !(priorRec?.written && deepEqual(cur, priorRec.written))) {
        collisions.push(`permission.${key}`);
      }
      if (cur !== undefined) {
        managed[key] = { prior: priorRec ? priorRec.prior : cur, written: null };
      }
    }
  }
  return { desiredKeys, managed };
}

/** Reconcile ak's desired skills.paths membership: prune previously-ak-added
 *  paths that fell out of the desired set, then add newly desired paths not
 *  already present. No collision concept applies — path membership isn't
 *  exclusively owned the way a single mcp/permission value is.
 *  @param {any} next @param {string[]} skillPaths
 *  @param {{paths:string[]}} prevManaged @param {string[]} pruned
 *  @returns {string[]} the new managed paths list */
function reconcileSkillPaths(next, skillPaths, prevManaged, pruned) {
  if (next.skills?.paths && prevManaged.paths.length) {
    const stale = new Set(prevManaged.paths.filter((p) => !skillPaths.includes(p)));
    next.skills.paths = next.skills.paths.filter((p) => !stale.has(p));
    if (stale.size) pruned.push(`${stale.size} stale skills path(s)`);
  }
  if (!skillPaths.length) return [];
  next.skills = { ...(next.skills ?? {}) };
  const cur = new Set(next.skills.paths ?? []);
  const newlyAdded = skillPaths.filter((p) => !cur.has(p));
  // ownership = previously-recorded ak paths that are still desired + newly
  // added ones (a re-apply must not erase the record of what ak added).
  const managedPaths = [...new Set([...prevManaged.paths.filter((p) => skillPaths.includes(p)), ...newlyAdded])];
  next.skills.paths = [...cur, ...newlyAdded];
  return managedPaths;
}

/** Build applyOpencode's human-readable result summary from its accumulated
 *  notes (wired/in-sync headline, pruned keys, preserved collisions). */
function applyOpencodeSummary({ changed, entries, skillPaths, permissionKeys, source, pruned, collisions }) {
  const aqe = entries['agentic-qe'] ? ' + agentic-qe' : '';
  const brain = entries['ruvnet-brain'] ? ' + ruvnet-brain' : ' (brain shim absent)';
  const notes = [
    changed ? `opencode.json wired: claude-flow (${entries['claude-flow'].command.join(' ')})${aqe}${brain}, ${skillPaths.length} skills path(s), ${permissionKeys.length} permission pattern(s)`
      : `opencode.json in sync${source ? '' : ' — ⚠ no ruflo catalog source found for skills.paths'}`,
  ];
  if (pruned.length) notes.push(`pruned: ${pruned.join(', ')}`);
  if (collisions.length) notes.push(`⚠ collisions preserved (user-owned, untouched): ${collisions.join(', ')}`);
  return notes.join(' — ');
}

/** Reconcile opencode.json: ak's MCP servers, skills.paths, and permission
 *  patterns merged into whatever is already there. The ownership contract is
 *  VALUE-PRECISE, not name-precise:
 *   - a pre-existing entry that DIFFERS from ak's desired value (and was not
 *     previously ak-written) is a COLLISION: preserved, reported, never taken
 *     over — merge-not-clobber applies to values, not just files;
 *   - every key ak writes is recorded as {prior, written} so teardown can
 *     restore the user's original value instead of deleting it;
 *   - previously-managed keys that fall OUT of the desired set (brain shim
 *     removed, catalog source changed) are removed only while they still equal
 *     what ak wrote — a user-edited value is left and reported.
 *  Scalar `permission` ("permission":"allow") is first lifted to its
 *  documented object equivalent {"*":"allow"} (wildcard key semantics), never
 *  spread character-by-character. Backup-first, idempotent, JSONC-refusing.
 *  @param {any} cfg @param {{ dryRun?: boolean, configFile?: string, brainShim?: string }} [opts] */
export async function applyOpencode(cfg, { dryRun = false, configFile = paths.opencodeConfigPath(), brainShim } = {}) {
  if (!cfg.integrations?.hosts?.opencode) return { ok: true, changed: false, detail: 'opencode not enabled — unmanaged' };
  const laterOverride = laterJsoncOverride(configFile);
  if (laterOverride) {
    return {
      ok: false, fatal: true, changed: false,
      detail: `${laterOverride} loads after opencode.json — refusing to write or claim an unverified effective config; merge the Agentic Kit entries there manually or remove the override`,
    };
  }
  const exists = fs.existsSync(configFile);
  const { ok: parsedOk, doc } = exists ? readJsonStrict(configFile) : { ok: true, doc: {} };
  if (!parsedOk) {
    return {
      ok: false, fatal: true, changed: false,
      detail: `${configFile} is not plain JSON (JSONC comments?) — refusing to touch it; merge manually`,
    };
  }
  const entries = await mcpEntriesFor({
    brainShim, includeAqe: cfg.aqe !== false, agentBrowserEnabled: cfg.agentBrowser !== false,
  });
  const source = catalogSource({ override: opencodeOwnership(cfg).catalogDir });
  const skillPaths = skillPathsFor(source);
  const prevManaged = normalizeManaged(opencodeOwnership(cfg).managed);
  const collisions = [];
  const pruned = [];

  const next = JSON.parse(JSON.stringify(doc));
  next.$schema ??= 'https://opencode.ai/config.json';

  // ── mcp: prune stale ak entries, then merge desired with collision refusal ──
  next.mcp = { ...(next.mcp ?? {}) };
  const managed = {
    mcp: reconcileOwnedMap(next.mcp, Object.entries(entries), prevManaged.mcp, {
      collisions, pruned,
      pruneLabel: (name) => name,
      collisionLabel: (name) => `mcp.${name}`,
    }),
    paths: [], permissions: {}, permissionScalar: null,
    artifacts: (prevManaged.artifactState.containerMalformed
      || prevManaged.artifactState.agentsMalformed)
      ? structuredClone(prevManaged.artifactState.rawContainer)
      : structuredClone(prevManaged.artifacts),
  };

  // ── skills.paths: remove stale ak-added paths, add desired ──
  managed.paths = reconcileSkillPaths(next, skillPaths, prevManaged, pruned);

  // ── permission: lift scalar shorthand, prune stale, merge desired ──
  // Record scalar ORIGIN explicitly (codex-review r2): undo restores the
  // scalar form only when the file actually started scalar — a pre-existing
  // {"*":"ask"} object must survive as an object, not be "restored" to "ask".
  managed.permissionScalar = typeof doc.permission === 'string'
    ? doc.permission
    : (prevManaged.permissionScalar ?? null);
  if (typeof next.permission === 'string') next.permission = { '*': next.permission };
  next.permission = { ...(next.permission ?? {}) };

  // Permissions are family-atomic with MCP ownership. A foreign/colliding
  // same-name MCP must never inherit broad AK-written `allow` patterns, and a
  // collision on either spelling prevents AK from adding the other spelling.
  const ownedEntries = Object.fromEntries(Object.entries(entries).filter(
    ([name]) => managed.mcp[name]?.written != null,
  ));
  const { desiredKeys: permissionKeys, managed: blockedPermissions } =
    reconcileFamilyPermissions(ownedEntries, next.permission, prevManaged.permissions, { collisions });
  Object.assign(managed.permissions, blockedPermissions);
  Object.assign(managed.permissions, reconcileOwnedMap(
    next.permission, permissionKeys.map((k) => [k, 'allow']), prevManaged.permissions,
    {
      collisions, pruned,
      pruneLabel: (k) => `permission.${k}`,
      collisionLabel: (k) => `permission.${k}`,
    },
  ));

  const changed = JSON.stringify(next) !== JSON.stringify(doc);
  if (!dryRun) {
    const ownership = mutableOpencodeOwnership(cfg);
    ownership.mcp = 'ak';
    ownership.managed = managed;
  }
  if (changed && !dryRun) writeJsonWithBackup(configFile, next);
  return {
    ok: collisions.length === 0,
    fatal: false,
    changed,
    collisions,
    detail: applyOpencodeSummary({ changed, entries, skillPaths, permissionKeys, source, pruned, collisions }),
  };
}

/** Surgical teardown of ak's opencode.json wiring — ONLY the recorded managed
 *  keys, and ONLY when ak wrote them
 *  (`integrations.ownership.opencode.mcp === 'ak'`). For each
 *  managed key: when the current value still equals what ak wrote, the user's
 *  PRIOR value is restored (or the key removed if there was none); a value the
 *  user edited since is left and reported, never silently deleted. Scalar
 *  permission shorthand is restored to scalar when teardown empties the object
 *  but a prior '*' wildcard exists. Deployed artifacts are removed separately
 *  (removeArtifacts).
 *  @param {any} cfg @param {{ configFile?: string }} [opts] */
/** Remove ak-managed paths that fell out of the desired set from
 *  doc.skills.paths, pruning the now-empty container(s) too. Returns whether
 *  anything changed. */
function restoreSkillPaths(doc, managedPaths) {
  if (!doc.skills?.paths || !managedPaths.length) return false;
  const drop = new Set(managedPaths);
  const keptPaths = doc.skills.paths.filter((p) => !drop.has(p));
  if (keptPaths.length === doc.skills.paths.length) return false;
  if (keptPaths.length) doc.skills.paths = keptPaths;
  else {
    delete doc.skills.paths;
    if (Object.keys(doc.skills).length === 0) delete doc.skills;
  }
  return true;
}

/** Drop an emptied permission object, or collapse it back to the scalar
 *  shorthand ak lifted from (only when scalar was the ORIGIN). Returns
 *  whether anything changed. */
function collapsePermissionScalar(doc, scalarOrigin) {
  if (doc.permission && Object.keys(doc.permission).length === 0) {
    delete doc.permission;
    return false;
  }
  if (doc.permission && scalarOrigin != null && Object.keys(doc.permission).length === 1 && doc.permission['*'] != null) {
    // restore the scalar shorthand we lifted (only when scalar was the ORIGIN;
    // the current '*' value is what collapses back — '*' is never ak-managed)
    doc.permission = doc.permission['*'];
    return true;
  }
  return false;
}

export function undoOpencode(cfg, { configFile = paths.opencodeConfigPath() } = {}) {
  if (opencodeOwnership(cfg).mcp !== 'ak') {
    return { ok: true, changed: false, detail: 'opencode.json left as-is (not ak-managed)' };
  }
  const managed = normalizeManaged(opencodeOwnership(cfg).managed);
  if (!fs.existsSync(configFile)) {
    // Nothing left to strip — but the markers would otherwise survive as a lie
    // (a later teardown would chase a phantom config). Clear them; the change
    // is the marker cleanup itself (codex-review r3).
    const ownership = mutableOpencodeOwnership(cfg);
    ownership.mcp = null;
    ownership.managed = null;
    return { ok: true, changed: true, detail: 'opencode.json absent — ownership markers cleared (nothing to strip)' };
  }
  const { ok: parsedOk, doc } = readJsonStrict(configFile);
  if (!parsedOk) {
    // NOT ok: the ak wiring is still ACTIVE inside a file we refuse to parse,
    // and the markers are the only teardown proof — keep both, fail honestly,
    // and name the manual remediation. Never report "disabled" here, and never
    // null the markers (codex-review r3).
    return {
      ok: false, changed: false,
      detail: 'opencode.json is not plain JSON (JSONC comments?) — ak wiring left ACTIVE and ownership markers retained; remove the file or make it plain JSON, then re-run the teardown',
    };
  }
  const kept = [];
  let changed = false;

  const restore = (obj, key, rec, label) => {
    if (!obj || !(key in obj)) return;
    if (rec.written == null) { kept.push(`${label} (not ak-written)`); return; }
    if (!deepEqual(obj[key], rec.written)) { kept.push(`${label} (edited since ak wrote it)`); return; }
    if (rec.prior == null) delete obj[key];
    else obj[key] = rec.prior;
    changed = true;
  };

  for (const [name, rec] of Object.entries(managed.mcp)) restore(doc.mcp, name, rec, `mcp.${name}`);
  if (doc.mcp && Object.keys(doc.mcp).length === 0) delete doc.mcp;

  if (restoreSkillPaths(doc, managed.paths)) changed = true;

  const scalarOrigin = managed.permissionScalar ?? null;
  for (const [k, rec] of Object.entries(managed.permissions)) restore(doc.permission, k, rec, `permission.${k}`);
  if (collapsePermissionScalar(doc, scalarOrigin)) changed = true;

  if (changed) writeJsonWithBackup(configFile, doc);
  const ownership = mutableOpencodeOwnership(cfg);
  ownership.mcp = null;
  ownership.managed = null;
  const detail = [
    changed ? 'ak-managed opencode.json wiring stripped (user priors restored)' : 'nothing managed found in opencode.json',
    kept.length ? `left untouched: ${kept.join(', ')}` : null,
  ].filter(Boolean).join(' — ');
  return { ok: true, changed, detail };
}
