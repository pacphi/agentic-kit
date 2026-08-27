// opencode host integration — the third host adapter's I/O half.
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
import { createHash } from 'node:crypto';
import { have } from './exec.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import { registry, syncBlocks, blocksForTarget, retiredForTarget, guidanceTargets } from './blocks.mjs';
import { CURRENT_INTEGRATIONS_VERSION } from './adapters/config.mjs';
import * as paths from './paths.mjs';

const opencodeOwnership = (cfg) => cfg?.integrations?.ownership?.opencode ?? {};
function mutableOpencodeOwnership(cfg) {
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
 *  @param {{ brainShim?: string, nestedPath?: string, includeAqe?: boolean }} [opts] */
export async function mcpEntriesFor({
  brainShim = brainShimPath(), nestedPath = nestedMcpServerPath(), includeAqe = true,
} = {}) {
  const entries = {
    'claude-flow': {
      type: 'local',
      command: mcpCommandFor({ binPresent: await have('claude-flow-mcp'), nestedPath }),
      enabled: true,
      timeout: 30000,
      environment: { ...RUFLO_MCP_ENV },
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
  const entries = await mcpEntriesFor({ brainShim, includeAqe: cfg.aqe !== false });
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

/** Order-insensitive deep compare (JSON with sorted keys). */
function deepEqual(a, b) {
  const stable = (v) => JSON.stringify(v, (k, x) => (
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)))
      : x
  ));
  return stable(a) === stable(b);
}

const contentHash = (text) => createHash('sha256').update(text).digest('hex');
const hasReceiptValue = (value) => value !== null && value !== undefined;
const receiptMatches = (text, receipt) =>
  typeof receipt === 'string' && contentHash(text) === receipt;

/** Tolerate a legacy/malformed `receipts` value (array, non-object) by
 *  treating it as an empty ledger — shared by syncAgents and agentsStatus. */
const asReceiptMap = (receipts) => (
  receipts && typeof receipts === 'object' && !Array.isArray(receipts) ? receipts : {}
);

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

function normalizeManaged(m) {
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
  const entries = await mcpEntriesFor({ brainShim, includeAqe: cfg.aqe !== false });
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

// ── ruflo catalog source (agents + skills) ──────────────────────────────────

/** Resolve where ruflo's agent/skill catalog comes from. Order: explicit
 *  override (kit.json integrations.ownership.opencode.catalogDir) →
 *  $RUFLO_REPO → the claude
 *  marketplace clone (full repo mirror, auto-updated by claude) → the
 *  published @claude-flow/cli package (subset: ADR-128 agents + core skills)
 *  → the nested copy under global ruflo/node_modules (the layout a plain
 *  `npm i -g ruflo` actually produces). Candidates are LAZY thunks: the
 *  npm-root lookups spawn `npm root -g` (cached per process), so evaluating
 *  them only when earlier candidates miss keeps status probes spawn-free on
 *  marketplace machines. Returns {kind, root, id, hasPlugins, hasPlatformSkill}
 *  or null.
 *  @param {{ override?: string }} [opts]
 *  @returns {CatalogSource|null} */
export function catalogSource({ override } = {}) {
  const candidates = [];
  if (override) candidates.push(() => ({ kind: 'override', root: override }));
  if (process.env.RUFLO_REPO) candidates.push(() => ({ kind: 'env', root: process.env.RUFLO_REPO }));
  candidates.push(() => ({ kind: 'marketplace', root: paths.rufloMarketplaceRoot() }));
  candidates.push(() => ({ kind: 'npm', root: paths.rufloCliPkgRoot() }));
  candidates.push(() => ({ kind: 'npm-nested', root: path.join(paths.rufloNodeModules(), '@claude-flow', 'cli') }));
  for (const thunk of candidates) {
    const c = thunk();
    if (!c.root || !fs.existsSync(path.join(c.root, '.claude', 'agents'))) continue;
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(c.root, 'package.json'), 'utf8')).version; } catch { /* unversioned source */ }
    return {
      ...c,
      id: `${c.kind}@${version ?? 'unversioned'}`,
      hasPlugins: fs.existsSync(path.join(c.root, 'plugins')),
      hasPlatformSkill: fs.existsSync(path.join(c.root, 'SKILL.md')),
    };
  }
  return null;
}

/** skills.paths entries for a catalog source (existing dirs only).
 *  @param {CatalogSource|null} source */
export function skillPathsFor(source) {
  if (!source) return [];
  const out = [path.join(source.root, '.claude', 'skills')];
  if (source.hasPlugins) out.push(path.join(source.root, 'plugins'));
  return out.filter((p) => fs.existsSync(p));
}

// ── agent conversion (Claude Code agent .md → opencode subagent .md) ─────────

/** Ownership markers on generated agent files — the current ak marker plus the
 *  legacy standalone-script marker, so the one-time script's output is adopted
 *  (removed/replaced) rather than orphaned. */
const AGENT_MARKERS = ['generated-by: agentic-kit', 'generated-by: sync-ruflo-agents.mjs'];
const STAMP_FILE = '.ak-agents-stamp.json';

function* walkMd(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (e.isFile() && e.name.endsWith('.md')) yield p;
  }
}

/** Minimal YAML frontmatter reader: scalar fields + block scalars
 *  (description: | / >). A block scalar's content is every following line that
 *  is INDENTED, with blank lines allowed inside — terminating at the first
 *  blank (they'd otherwise truncate multi-paragraph descriptions and leak the
 *  remainder into mis-parsed fields). */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;
  const fields = {};
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!km) continue;
    const [, key, raw] = km;
    if (/^[>|]-?$/.test(raw) && i + 1 < lines.length) {
      const buf = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s+\S/.test(lines[i + 1]))) {
        const t = lines[++i].trim();
        if (t) buf.push(t);
      }
      fields[key] = buf.join(' ').trim();
    } else {
      fields[key] = raw.replace(/^["']|["']$/g, '').trim();
    }
  }
  return { fields, body };
}

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const lazyGatewayCall = (family, name) =>
  `\`${family}_call\` with \`name=${JSON.stringify(name)}\` and \`arguments_json\` set to one JSON object string`;

const directOpenCodeReferences = (body) => String(body)
  .replace(/mcp__(?:claude-flow|claude_flow|ruflo)__([A-Za-z0-9_./:*-]+)/g, 'claude-flow_$1')
  .replace(/mcp__(?:agentic-qe|agentic_qe)__([A-Za-z0-9_./:*-]+)/g, 'agentic-qe_$1');

/** Rewrite tool-name references inside an OpenCode-only generated agent so
 *  the instructions use the lazy gateway that is actually advertised. The
 *  Claude/Ruflo source file is never changed. Families without a managed
 *  gateway retain their direct OpenCode tool spelling.
 *  @param {string} body @param {{ruflo?:boolean,aqe?:boolean}} capabilities */
export function rewriteAgentGatewayReferences(body, capabilities = {}) {
  let result = directOpenCodeReferences(body);
  if (capabilities.ruflo) {
    result = result
      .replace(/\b(?:claude-flow|claude_flow)_\*/g,
        () => 'the Ruflo operation selected with `ak_ruflo_search`, then invoked through `ak_ruflo_call`')
      .replace(/\b(?:claude-flow|claude_flow)_([A-Za-z0-9_./:-]+)/g,
        (_match, name) => lazyGatewayCall('ruflo', name));
  }
  if (capabilities.aqe) {
    result = result
      .replace(/\b(?:agentic-qe|agentic_qe)_\*/g,
        () => 'the Agentic QE operation selected with `ak_aqe_search`, then invoked through `ak_aqe_call`')
      .replace(/\b(?:agentic-qe|agentic_qe)_([A-Za-z0-9_./:-]+)/g,
        (_match, name) => lazyGatewayCall('aqe', name));
  }
  return result;
}

/** Convert every agent under <src>/.claude/agents into opencode form:
 *  frontmatter → {description, mode: subagent} (Claude's `tools:` string list
 *  is dropped — OpenCode applies the subagent's permissions plus inherited
 *  parent/session deny rules); body MCP refs
 *  rewritten across all catalogue spellings. Lazy-gateway conversion emits
 *  ak_ruflo_call/ak_aqe_call guidance; direct fallback conversion emits OpenCode's
 *  direct tool spelling.
 *  basename collisions across category dirs get the parent dir prefixed. The
 *  description is emitted as a JSON double-quoted scalar (valid YAML 1.2 —
 *  unquoted values containing ': ' or '#' would corrupt the frontmatter).
 *  Pure (returns content, writes nothing).
 *  @param {string} srcRoot */
export function convertAgents(srcRoot, { gatewayCapabilities = {} } = {}) {
  const srcDir = path.join(srcRoot, '.claude', 'agents');
  const agents = [];
  let scanned = 0;
  for (const file of walkMd(srcDir)) {
    scanned++;
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!parsed) continue;
    // documentation masquerading as an agent (e.g. MIGRATION_SUMMARY.md)
    if (collapse(parsed.fields.type).toLowerCase() === 'documentation') continue;
    const description = collapse(parsed.fields.description);
    if (!description) continue;
    const rel = path.relative(srcDir, file);
    const dir = path.dirname(rel) === '.' ? null : path.dirname(rel).split(path.sep)[0];
    agents.push({
      base: path.basename(file, '.md'),
      dir,
      description,
      body: rewriteAgentGatewayReferences(parsed.body, gatewayCapabilities),
    });
  }
  const seen = new Set();
  let renamed = 0;
  for (const a of agents) {
    let name = a.base;
    if (seen.has(name)) { name = a.dir ? `${a.dir}-${a.base}` : `${a.base}-x`; renamed++; }
    let n = 2;
    while (seen.has(name)) name = `${a.dir ?? 'agent'}-${a.base}-${n++}`;
    seen.add(name);
    a.name = name;
    a.content = `---\ndescription: ${JSON.stringify(a.description)}\nmode: subagent\n---\n\n<!-- ${AGENT_MARKERS[0]} — re-synced by \`ak sync\`; do not edit -->\n${a.body}`;
  }
  return { agents, scanned, skipped: scanned - agents.length, renamed };
}

const SPECIALIST_AGENT = {
  name: 'ak-specialist',
  description: 'Runs one Agentic Kit specialist profile selected lazily with ak_agent_search',
  content: `---
description: "Runs one Agentic Kit specialist profile selected lazily with ak_agent_search"
mode: subagent
---

<!-- ${AGENT_MARKERS[0]} — re-synced by \`ak sync\`; do not edit -->
You are the Agentic Kit specialist dispatcher for stock OpenCode.

The parent task must begin with \`PROFILE: <exact-name>\`. Call \`ak_agent_load\` with that exact
name before doing any work. Treat the returned receipt-owned profile as your specialist
instructions for the rest of this task. If the profile names an optional dependency that is not
available, report the missing dependency instead of inventing a result.
`,
};

function specialistDispatcherState({
  destDir = paths.opencodeAgentsDir(), receipts = {}, adoptionBlocked = false,
} = {}) {
  if (adoptionBlocked) return { available: false, blocked: true };
  const file = 'ak-specialist.md';
  const target = path.join(destDir, file);
  if (!fs.existsSync(target)) return { available: true, blocked: false };
  let current;
  try { current = fs.readFileSync(target, 'utf8'); } catch {
    return { available: false, blocked: true };
  }
  if (receiptMatches(current, receipts?.[file])) return { available: true, blocked: false };
  if (hasReceiptValue(receipts?.[file])) return { available: false, blocked: true };
  const adoptable = current === SPECIALIST_AGENT.content && isGeneratedContent(current);
  return { available: adoptable, blocked: false };
}

function desiredAgentSet(source, gatewayCapabilities, lazyCatalog) {
  const converted = convertAgents(source.root, { gatewayCapabilities });
  return { ...converted, agents: lazyCatalog ? [SPECIALIST_AGENT] : converted.agents };
}

function gatewayAgentCatalog(source) {
  if (!source) return [];
  return convertAgents(source.root, { gatewayCapabilities: {} }).agents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    body: agent.body,
  }));
}

const isGeneratedContent = (text) => AGENT_MARKERS.some((m) => text.includes(m));

/** Write/adopt each desired agent file, skipping any user-owned collision.
 *  Returns per-run counts plus the exact list of files actually deployed. */
function deployDesiredAgents(agents, destDir, { dryRun, receiptMap, adoptionBlocked }) {
  let userOwned = 0, adopted = 0, written = 0;
  const deployed = [];
  for (const a of agents) {
    const file = `${a.name}.md`;
    const p = path.join(destDir, file);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    const priorReceipt = receiptMap[file];
    const hasPriorReceipt = adoptionBlocked || hasReceiptValue(priorReceipt);
    const priorOwned = cur !== null && receiptMatches(cur, priorReceipt);
    const adoptable = cur === a.content && !hasPriorReceipt && isGeneratedContent(cur);
    if (cur !== null && !priorOwned && !adoptable) { userOwned++; continue; }
    if (adoptable) adopted++;
    deployed.push(file);
    if (cur !== a.content) {
      written++;
      if (!dryRun) fs.writeFileSync(p, a.content);
    }
  }
  return { userOwned, adopted, written, deployed };
}

/** Remove receipt-owned generated agent files that are no longer desired.
 *  Deploy/adopt the dispatcher or complete direct set BEFORE retiring any
 *  receipt-owned predecessor. A write failure therefore preserves the last
 *  known-good eager catalogue instead of leaving no executable agent path. */
function retireStaleGeneratedAgents(destDir, agents, receiptMap, { dryRun, lazyCatalog, deployed }) {
  let removed = 0;
  const removedFiles = new Set();
  if ((!lazyCatalog || deployed.includes('ak-specialist.md')) && fs.existsSync(destDir)) {
    for (const f of fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
      const p = path.join(destDir, f);
      let owned = false;
      try { owned = receiptMatches(fs.readFileSync(p, 'utf8'), receiptMap[f]); } catch { /* leave alone */ }
      const wanted = agents.some((a) => `${a.name}.md` === f);
      if (owned && !wanted) {
        if (!dryRun) fs.rmSync(p);
        removedFiles.add(f);
        removed++;
      }
    }
  }
  return { removed, removedFiles };
}

/** Compute + (when ownable) write the agent-set stamp file, returning the
 *  per-file content hashes and the stamp's own receipt for the caller's
 *  managed-artifacts ledger. */
function writeAgentStamp({ destDir, dryRun, source, gatewayCapabilities, lazyCatalog, deployed, agents, stampReceipt, adoptionBlocked }) {
  const deployedHashes = Object.fromEntries(deployed.map((f) => {
    const agent = agents.find((a) => `${a.name}.md` === f);
    return [f, contentHash(agent.content)];
  }));
  const gateway = { ruflo: !!gatewayCapabilities.ruflo, aqe: !!gatewayCapabilities.aqe };
  const stamp = {
    source: source.id, gateway, lazyCatalog: !!lazyCatalog,
    count: deployed.length, files: deployed.sort(), hashes: deployedHashes,
  };
  const stampText = JSON.stringify(stamp, null, 2) + '\n';
  const stampPath = path.join(destDir, STAMP_FILE);
  const priorStampText = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null;
  const hasStampReceipt = adoptionBlocked || hasReceiptValue(stampReceipt);
  const stampOwned = priorStampText !== null && receiptMatches(priorStampText, stampReceipt);
  // The stamp has no marker of its own, so exact bytes are adoptable only when
  // every file it lists was independently receipt-owned, newly written, or
  // adopted through exact marker-bearing content.
  const stampAdoptable = priorStampText === stampText && !hasStampReceipt && deployed.length > 0
    && deployed.every((f) => {
      try {
        return contentHash(fs.readFileSync(path.join(destDir, f), 'utf8')) === deployedHashes[f];
      } catch { return false; }
    });
  const mayWriteStamp = priorStampText === null || stampOwned || stampAdoptable;
  if (!dryRun && mayWriteStamp && priorStampText !== stampText) {
    fs.writeFileSync(stampPath, stampText);
  }
  return { deployedHashes, stampReceipt: mayWriteStamp ? contentHash(stampText) : stampReceipt };
}

/** Reconcile the converted agent set into the dest dir: rewrite generated
 *  files, remove stale generated ones (either marker), NEVER overwrite a file
 *  that carries no generated marker (a user-owned agent with a colliding name
 *  is preserved and reported). The stamp records the source id + the exact
 *  generated file list and is only rewritten when the set actually changed
 *  (no per-run timestamp churn — idempotent-write semantics).
 *  @param {{ source: CatalogSource|null, destDir?: string, dryRun?: boolean, receipts?:Record<string,string>, stampReceipt?:string|null, adoptionBlocked?:boolean, gatewayCapabilities?:{ruflo?:boolean,aqe?:boolean}, lazyCatalog?:boolean }} opts */
export function syncAgents({
  source, destDir = paths.opencodeAgentsDir(), dryRun = false, receipts = {}, stampReceipt = null,
  adoptionBlocked = false, gatewayCapabilities = {}, lazyCatalog = false,
}) {
  if (!source) return { ok: false, changed: false, detail: 'no ruflo catalog source (marketplace clone or @claude-flow/cli) found' };
  const receiptMap = asReceiptMap(receipts);
  const { agents, scanned, skipped, renamed } = desiredAgentSet(
    source, gatewayCapabilities, lazyCatalog,
  );
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  const { userOwned, adopted, written, deployed } = deployDesiredAgents(
    agents, destDir, { dryRun, receiptMap, adoptionBlocked },
  );
  const { removed, removedFiles } = retireStaleGeneratedAgents(
    destDir, agents, receiptMap, { dryRun, lazyCatalog, deployed },
  );
  const changed = written > 0 || removed > 0;
  // The stamp records what was ACTUALLY deployed (a user-owned file occupying
  // a slot is never in it) — otherwise status would diverge forever.
  // Preserve a non-null mismatched receipt while its file still exists. If it
  // were dropped, a later pass could mistake the resulting absence for a
  // pre-receipts install and launder an edited file back into ak ownership.
  const nextReceipts = Object.fromEntries(Object.entries(receiptMap).filter(([f]) => (
    !removedFiles.has(f) && fs.existsSync(path.join(destDir, f))
  )));
  const { deployedHashes, stampReceipt: nextStampReceipt } = writeAgentStamp({
    destDir, dryRun, source, gatewayCapabilities, lazyCatalog, deployed, agents, stampReceipt, adoptionBlocked,
  });
  Object.assign(nextReceipts, deployedHashes);
  return {
    ok: !lazyCatalog || deployed.includes('ak-specialist.md'),
    changed,
    receipts: nextReceipts,
    stampReceipt: nextStampReceipt,
    adopted,
    detail: `${agents.length} ${lazyCatalog ? 'lazy dispatcher agent' : 'agents'} from ${source.id} (${written} written, ${removed} removed, ${skipped} skipped, ${renamed} collision-renamed${adopted ? `, ${adopted} adopted` : ''}${userOwned ? `, ${userOwned} user-owned preserved` : ''}; scanned ${scanned})`,
  };
}

function readAgentStamp(destDir) {
  const stampPath = path.join(destDir, STAMP_FILE);
  return {
    stamp: readJson(stampPath, null),
    stampText: fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null,
  };
}

function countGeneratedAgentFiles(destDir) {
  if (!fs.existsSync(destDir)) return 0;
  let count = 0;
  for (const f of fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
    try { if (isGeneratedContent(fs.readFileSync(path.join(destDir, f), 'utf8'))) count++; } catch { /* skip */ }
  }
  return count;
}

/** The on-disk generated (receipt-owned or adoptable) agent file list,
 *  sorted. Adoptable files (exact marker-bearing desired bytes, no prior
 *  receipt) are appended to `adoptableFiles` as a side effect. */
function onDiskAgentFiles(destDir, desired, { hasReceiptLedger, receiptMap, adoptionBlocked, adoptableFiles }) {
  if (!fs.existsSync(destDir)) return [];
  return fs.readdirSync(destDir).filter((f) => {
    if (!f.endsWith('.md')) return false;
    try {
      const text = fs.readFileSync(path.join(destDir, f), 'utf8');
      if (hasReceiptLedger) {
        const hasReceipt = adoptionBlocked || hasReceiptValue(receiptMap[f]);
        const receiptOwned = receiptMatches(text, receiptMap[f]);
        const adoptable = !hasReceipt && isGeneratedContent(text) && desired.get(f) === text;
        if (adoptable) adoptableFiles.push(f);
        return receiptOwned || adoptable;
      }
      return isGeneratedContent(text);
    } catch { return false; }
  }).sort();
}

function agentContentDiverged(destDir, onDisk, stamp) {
  return !!stamp?.hashes && onDisk.some((f) => {
    try { return contentHash(fs.readFileSync(path.join(destDir, f), 'utf8')) !== stamp.hashes[f]; } catch { return true; }
  });
}

/** The stamp bytes syncAgents would write for today's on-disk generated set,
 *  or null when there's no source or the on-disk set doesn't fully match
 *  desired — used only for stamp-only adoption detection. */
function expectedAgentStampText(source, onDisk, desired, gatewayCapabilities, lazyCatalog) {
  if (!source || onDisk.length === 0 || !onDisk.every((f) => desired.has(f))) return null;
  return `${JSON.stringify({
    source: source.id,
    gateway: { ruflo: !!gatewayCapabilities.ruflo, aqe: !!gatewayCapabilities.aqe },
    lazyCatalog: !!lazyCatalog,
    count: onDisk.length,
    files: onDisk,
    // syncAgents hashes in converter declaration order, then sorts only
    // the separate files list. Preserve that byte order for exact
    // stamp-only adoption detection.
    hashes: Object.fromEntries([...desired.entries()]
      .filter(([f]) => onDisk.includes(f))
      .map(([f, text]) => [f, contentHash(text)])),
  }, null, 2)}\n`;
}

function agentReceiptDivergence(destDir, receiptMap) {
  if (!fs.existsSync(destDir)) return false;
  return fs.readdirSync(destDir).filter((f) => f.endsWith('.md')).some((f) => {
    try {
      return hasReceiptValue(receiptMap[f])
        && !receiptMatches(fs.readFileSync(path.join(destDir, f), 'utf8'), receiptMap[f]);
    } catch { return true; }
  });
}

/** Assemble agentsStatus's final result object from its computed signals. */
function agentsStatusResult({
  generatedCount, stamp, source, adoptionBlocked, adoptableFiles, stampAdoptable,
  contentDiverged, hasReceiptLedger, destDir, receiptMap, filesDiverged, lazyCatalog, gatewayCapabilities,
}) {
  return {
    count: generatedCount,
    stampedId: stamp?.source ?? null,
    currentId: source?.id ?? null,
    adoptable: !adoptionBlocked && (adoptableFiles.length > 0 || stampAdoptable),
    adoptionBlocked,
    modified: contentDiverged || (hasReceiptLedger && agentReceiptDivergence(destDir, receiptMap)),
    stale: !stamp || stamp.source !== (source?.id ?? null) || filesDiverged
      || !!stamp.lazyCatalog !== !!lazyCatalog
      || !deepEqual(stamp.gateway ?? { ruflo: false, aqe: false }, {
        ruflo: !!gatewayCapabilities.ruflo, aqe: !!gatewayCapabilities.aqe,
      }),
  };
}

/** Agent-set drift, honestly: stale when the stamp is missing, the catalog
 *  source id diverged (upgrade/marketplace pull), or the on-disk generated
 *  file set differs from the stamp. Count reports marker-bearing agents for
 *  visibility, while receipt/hash divergence is reported as `modified` so
 *  callers classify user edits as preserved rather than repairable drift.
 *  @param {{ source?: CatalogSource|null, destDir?: string, receipts?:Record<string,string>|null, stampReceipt?:string|null, adoptionBlocked?:boolean, gatewayCapabilities?:{ruflo?:boolean,aqe?:boolean}, lazyCatalog?:boolean }} [opts] */
export function agentsStatus({
  source, destDir = paths.opencodeAgentsDir(), receipts = null, stampReceipt = null,
  adoptionBlocked = false, gatewayCapabilities = {}, lazyCatalog = false,
} = {}) {
  const { stamp, stampText } = readAgentStamp(destDir);
  const hasReceiptLedger = receipts !== null;
  const receiptMap = asReceiptMap(receipts);
  const desired = source
    ? new Map(desiredAgentSet(source, gatewayCapabilities, lazyCatalog)
      .agents.map((a) => [`${a.name}.md`, a.content]))
    : new Map();
  const generatedCount = countGeneratedAgentFiles(destDir);
  const adoptableFiles = [];
  const onDisk = onDiskAgentFiles(destDir, desired, { hasReceiptLedger, receiptMap, adoptionBlocked, adoptableFiles });
  const stampFiles = Array.isArray(stamp?.files) ? [...stamp.files].sort() : null;
  const filesDiverged = stampFiles != null && JSON.stringify(stampFiles) !== JSON.stringify(onDisk);
  const contentDiverged = agentContentDiverged(destDir, onDisk, stamp);
  const expectedStamp = expectedAgentStampText(source, onDisk, desired, gatewayCapabilities, lazyCatalog);
  const stampAdoptable = hasReceiptLedger && !adoptionBlocked && !hasReceiptValue(stampReceipt)
    && expectedStamp !== null && stampText === expectedStamp;
  return agentsStatusResult({
    generatedCount, stamp, source, adoptionBlocked, adoptableFiles, stampAdoptable,
    contentDiverged, hasReceiptLedger, destDir, receiptMap, filesDiverged, lazyCatalog, gatewayCapabilities,
  });
}

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
