// opencode host integration — the third host adapter's I/O half.
//
// why: opencode (opencode.ai) consumes the same rUv stack as claude/codex but
// through different surfaces. This module owns every ak-managed byte on those
// surfaces, backup-first + merge-not-clobber + ownership-marked, mirroring the
// claude (settings.mjs / mcp.mjs) and codex (providers.mjs reverse bridge)
// contracts:
//
//   ~/.config/opencode/opencode.json   mcp.claude-flow + mcp.ruvnet-brain,
//                                      skills.paths, permission patterns
//   ~/.config/opencode/AGENTS.md       guidance blocks (blocks.mjs target
//                                      'agents-opencode' — NOT here)
//   ~/.config/opencode/plugins/ruflo-hooks.js   lifecycle bridge (opencode has
//                                      no settings-hooks surface; its plugin
//                                      events are the hook spine)
//   ~/.config/opencode/agents/*.md     ruflo's agent set, converted (Claude
//                                      Code agent format → opencode subagent)
//   ~/.config/opencode/skills/ruflo/   the platform SKILL.md
//
// Grounded:
//   - opencode.json schema (https://opencode.ai/config.json): mcp local
//     servers {type,command[],environment,enabled,timeout}, skills.paths[],
//     permission as wildcard tool-name patterns (MCP tools surface as
//     `<server>_<tool>`, hence the claude-flow_*/ruvnet-brain_* patterns).
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

/** Permission patterns ak pre-approves (opencode surfaces MCP tools as
 *  `<server>_<tool>`; cover both separator spellings defensively). */
export const PERMISSION_KEYS = ['claude-flow_*', 'claude_flow_*', 'ruvnet-brain_*', 'ruvnet_brain_*'];

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
 *  (bin on PATH → nested mcp-server.js → `ruflo mcp start`). ruvnet-brain is
 *  included only when its shim is on disk.
 *  @param {{ brainShim?: string, nestedPath?: string }} [opts] */
export async function mcpEntriesFor({ brainShim = brainShimPath(), nestedPath = nestedMcpServerPath() } = {}) {
  const entries = {
    'claude-flow': {
      type: 'local',
      command: mcpCommandFor({ binPresent: await have('claude-flow-mcp'), nestedPath }),
      enabled: true,
      timeout: 30000,
      environment: { ...RUFLO_MCP_ENV },
    },
  };
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

/** Registration state, spawn-free (mirrors mcp.mjs registrationStatus's
 *  file-read approach). `parseError` distinguishes "absent" from "present but
 *  not plain JSON" (JSONC) — the writer refuses the latter.
 *  @param {any} cfg @param {{ configFile?: string }} [opts] */
export function opencodeMcpStatus(cfg, { configFile = paths.opencodeConfigPath() } = {}) {
  const exists = fs.existsSync(configFile);
  const { ok, doc } = exists ? readJsonStrict(configFile) : { ok: true, doc: {} };
  if (!ok) {
    return { exists, parseError: true, claudeFlow: false, brain: false, owned: opencodeOwnership(cfg).mcp === 'ak' };
  }
  return {
    exists,
    parseError: false,
    claudeFlow: !!doc?.mcp?.['claude-flow'],
    brain: !!doc?.mcp?.['ruvnet-brain'],
    paths: doc?.skills?.paths ?? [],
    owned: opencodeOwnership(cfg).mcp === 'ak',
  };
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
  const doc = readJsonStrict(configFile).doc;
  const reasons = [];
  const entries = await mcpEntriesFor({ brainShim });
  for (const [name, want] of Object.entries(entries)) {
    if (!(name in (doc.mcp ?? {}))) reasons.push(`${name} missing`);
    else if (!deepEqual(doc.mcp[name], want)) reasons.push(`${name} drifted`);
  }
  if (doc.mcp?.['ruvnet-brain'] && !entries['ruvnet-brain']) reasons.push('ruvnet-brain stale (brain shim gone)');
  const source = catalogSource({ override: opencodeOwnership(cfg).catalogDir });
  for (const p of skillPathsFor(source)) {
    if (!(doc.skills?.paths ?? []).includes(p)) reasons.push(`skills path missing: ${p}`);
  }
  for (const k of PERMISSION_KEYS) {
    if (doc.permission?.[k] !== 'allow') reasons.push(`permission ${k} not allowed`);
  }
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

/** Normalize an opencodeManaged record — the current precise shape
 *  { mcp: {name:{prior,written}}, paths: [], permissions: {key:{prior,written}} },
 *  tolerating the legacy names-only shape from the first shipped version
 *  (legacy entries have unknown prior/written → treated conservatively: prior
 *  null, written null → never auto-deleted, only re-recorded on next apply). */
function normalizeManaged(m) {
  const out = {
    mcp: {}, paths: [], permissions: {}, permissionScalar: null,
    artifacts: { plugin: null, agents: {}, agentStamp: null, skill: null },
    artifactState: {
      containerMalformed: false, agentsMalformed: false,
      rawContainer: null,
    },
  };
  if (!m || typeof m !== 'object') return out;
  const legacyNames = Array.isArray(m.mcp) ? m.mcp : Object.keys(m.mcp ?? {});
  for (const n of legacyNames) {
    const rec = Array.isArray(m.mcp) ? null : m.mcp[n];
    out.mcp[n] = rec && typeof rec === 'object' && 'written' in rec ? rec : { prior: null, written: null };
  }
  out.paths = Array.isArray(m.paths) ? [...m.paths] : [];
  const permKeys = Array.isArray(m.permissions) ? m.permissions : Object.keys(m.permissions ?? {});
  for (const k of permKeys) {
    const rec = Array.isArray(m.permissions) ? null : m.permissions[k];
    out.permissions[k] = rec && typeof rec === 'object' && 'written' in rec ? rec : { prior: null, written: null };
  }
  out.permissionScalar = typeof m.permissionScalar === 'string' ? m.permissionScalar : null;
  if (hasReceiptValue(m.artifacts)) {
    out.artifactState.rawContainer = structuredClone(m.artifacts);
  }
  if (hasReceiptValue(m.artifacts)
      && (typeof m.artifacts !== 'object' || Array.isArray(m.artifacts))) {
    out.artifactState.containerMalformed = true;
    return out;
  }
  const artifacts = m.artifacts ?? {};
  out.artifacts.plugin = hasReceiptValue(artifacts.plugin) ? artifacts.plugin : null;
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
  const exists = fs.existsSync(configFile);
  const { ok: parsedOk, doc } = exists ? readJsonStrict(configFile) : { ok: true, doc: {} };
  if (!parsedOk) {
    return {
      ok: false, fatal: true, changed: false,
      detail: `${configFile} is not plain JSON (JSONC comments?) — refusing to touch it; merge manually`,
    };
  }
  const entries = await mcpEntriesFor({ brainShim });
  const source = catalogSource({ override: opencodeOwnership(cfg).catalogDir });
  const skillPaths = skillPathsFor(source);
  const prevManaged = normalizeManaged(opencodeOwnership(cfg).managed);
  const collisions = [];
  const pruned = [];

  const next = JSON.parse(JSON.stringify(doc));
  next.$schema ??= 'https://opencode.ai/config.json';

  // ── mcp: prune stale ak entries, then merge desired with collision refusal ──
  next.mcp = { ...(next.mcp ?? {}) };
  for (const [name, rec] of Object.entries(prevManaged.mcp)) {
    if (name in entries) continue;
    if (!(name in next.mcp)) continue;
    if (rec.written && deepEqual(next.mcp[name], rec.written)) {
      // RESTORE the prior when there was one (a user entry that happened to
      // equal the old desired value is a user value, not ak's to delete);
      // delete only what ak itself created (codex-review r2).
      if (rec.prior != null) { next.mcp[name] = rec.prior; pruned.push(`${name} (prior restored)`); }
      else { delete next.mcp[name]; pruned.push(name); }
    } // else: user edited (or legacy record) → leave it, keep no ownership
  }
  const managed = {
    mcp: {}, paths: [], permissions: {}, permissionScalar: null,
    artifacts: (prevManaged.artifactState.containerMalformed
      || prevManaged.artifactState.agentsMalformed)
      ? structuredClone(prevManaged.artifactState.rawContainer)
      : structuredClone(prevManaged.artifacts),
  };
  for (const [name, want] of Object.entries(entries)) {
    const cur = next.mcp[name];
    const priorRec = prevManaged.mcp[name];
    if (cur !== undefined && !deepEqual(cur, want) && !(priorRec?.written && deepEqual(cur, priorRec.written))) {
      collisions.push(`mcp.${name}`);
      managed.mcp[name] = { prior: cur, written: null }; // tracked but NOT ak-owned
      continue;
    }
    // A previously-colliding (never ak-authored) value the USER has since
    // aligned to the desired one stays unmanaged: adopting it with the stale
    // pre-collision prior would make undo overwrite the user's own later
    // choice (codex-review r2). Noted, not owned.
    if (priorRec && priorRec.written == null && cur !== undefined && deepEqual(cur, want)) {
      managed.mcp[name] = { prior: priorRec.prior, written: null };
      continue;
    }
    // prior is the ORIGINAL pre-ak value (kept across reapplies), never the
    // ak-written value currently in place.
    managed.mcp[name] = { prior: priorRec ? priorRec.prior : (cur ?? null), written: want };
    next.mcp[name] = want;
  }

  // ── skills.paths: remove stale ak-added paths, add desired ──
  if (next.skills?.paths && prevManaged.paths.length) {
    const stale = new Set(prevManaged.paths.filter((p) => !skillPaths.includes(p)));
    next.skills.paths = next.skills.paths.filter((p) => !stale.has(p));
    if (stale.size) pruned.push(`${stale.size} stale skills path(s)`);
  }
  if (skillPaths.length) {
    next.skills = { ...(next.skills ?? {}) };
    const cur = new Set(next.skills.paths ?? []);
    const newlyAdded = skillPaths.filter((p) => !cur.has(p));
    // ownership = previously-recorded ak paths that are still desired + newly
    // added ones (a re-apply must not erase the record of what ak added).
    managed.paths = [...new Set([...prevManaged.paths.filter((p) => skillPaths.includes(p)), ...newlyAdded])];
    next.skills.paths = [...cur, ...newlyAdded];
  }

  // ── permission: lift scalar shorthand, prune stale, merge desired ──
  // Record scalar ORIGIN explicitly (codex-review r2): undo restores the
  // scalar form only when the file actually started scalar — a pre-existing
  // {"*":"ask"} object must survive as an object, not be "restored" to "ask".
  managed.permissionScalar = typeof doc.permission === 'string'
    ? doc.permission
    : (prevManaged.permissionScalar ?? null);
  if (typeof next.permission === 'string') next.permission = { '*': next.permission };
  next.permission = { ...(next.permission ?? {}) };
  for (const [k, rec] of Object.entries(prevManaged.permissions)) {
    if (PERMISSION_KEYS.includes(k)) continue;
    if (!(k in next.permission)) continue;
    if (rec.written && deepEqual(next.permission[k], rec.written)) {
      if (rec.prior != null) {
        next.permission[k] = rec.prior;
        pruned.push(`permission.${k} (prior restored)`);
      } else {
        delete next.permission[k];
        pruned.push(`permission.${k}`);
      }
    }
  }
  for (const k of PERMISSION_KEYS) {
    const cur = next.permission[k];
    const priorRec = prevManaged.permissions[k];
    if (cur !== undefined && cur !== 'allow' && !(priorRec?.written && deepEqual(cur, priorRec.written))) {
      collisions.push(`permission.${k}`);
      managed.permissions[k] = { prior: cur, written: null };
      continue;
    }
    managed.permissions[k] = { prior: priorRec ? priorRec.prior : (cur ?? null), written: 'allow' };
    next.permission[k] = 'allow';
  }

  const changed = JSON.stringify(next) !== JSON.stringify(doc);
  if (!dryRun) {
    const ownership = mutableOpencodeOwnership(cfg);
    ownership.mcp = 'ak';
    ownership.managed = managed;
  }
  if (changed && !dryRun) writeJsonWithBackup(configFile, next);
  const brain = entries['ruvnet-brain'] ? ' + ruvnet-brain' : ' (brain shim absent — ruflo only)';
  const notes = [
    changed ? `opencode.json wired: claude-flow (${entries['claude-flow'].command.join(' ')})${brain}, ${skillPaths.length} skills path(s), ${PERMISSION_KEYS.length} permission pattern(s)`
      : `opencode.json in sync${source ? '' : ' — ⚠ no ruflo catalog source found for skills.paths'}`,
  ];
  if (pruned.length) notes.push(`pruned: ${pruned.join(', ')}`);
  if (collisions.length) notes.push(`⚠ collisions preserved (user-owned, untouched): ${collisions.join(', ')}`);
  return { ok: collisions.length === 0, fatal: false, changed, detail: notes.join(' — ') };
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

  if (doc.skills?.paths && managed.paths.length) {
    const drop = new Set(managed.paths);
    const keptPaths = doc.skills.paths.filter((p) => !drop.has(p));
    if (keptPaths.length !== doc.skills.paths.length) {
      changed = true;
      if (keptPaths.length) doc.skills.paths = keptPaths;
      else { delete doc.skills.paths; if (Object.keys(doc.skills).length === 0) delete doc.skills; }
    }
  }

  const scalarOrigin = managed.permissionScalar ?? null;
  for (const [k, rec] of Object.entries(managed.permissions)) restore(doc.permission, k, rec, `permission.${k}`);
  if (doc.permission && Object.keys(doc.permission).length === 0) delete doc.permission;
  else if (doc.permission && scalarOrigin != null && Object.keys(doc.permission).length === 1 && doc.permission['*'] != null) {
    // restore the scalar shorthand we lifted (only when scalar was the ORIGIN;
    // the current '*' value is what collapses back — '*' is never ak-managed)
    doc.permission = doc.permission['*'];
    changed = true;
  }

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

/** Enable path: wire opencode.json, deploy the lifecycle plugin, convert the
 *  agent set, deploy the platform skill. Callers gate on the CLI being present
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
  const before = JSON.stringify([
    opencodeOwnership(cfg).mcp ?? null,
    opencodeOwnership(cfg).managed ?? null,
  ]);
  const oc = await applyOpencode(cfg, { ...(configFile ? { configFile } : {}), ...(brainShim ? { brainShim } : {}) });
  if (oc.fatal) {
    const skipped = { ok: false, changed: false, detail: 'skipped because opencode.json did not converge' };
    return { oc, plugin: skipped, agents: skipped, skill: skipped, source: null, markersChanged: false };
  }
  const receiptState = opencodeArtifactReceiptState(opencodeOwnership(cfg).managed);
  const { receipts, adoptionBlocked } = receiptState;
  const source = catalogSource({ override: opencodeOwnership(cfg).catalogDir });
  if (adoptionBlocked) {
    const detail = 'skipped because the artifact receipt ledger is malformed';
    const plugin = { ok: false, changed: false, receipt: receipts.plugin, adoptionBlocked: true, detail };
    const agents = {
      ok: false, changed: false, receipts: receipts.agents,
      stampReceipt: receipts.agentStamp, adopted: 0, adoptionBlocked: true, detail,
    };
    const skill = { ok: false, changed: false, receipt: receipts.skill, adoptionBlocked: true, detail };
    const markersChanged = JSON.stringify([
      opencodeOwnership(cfg).mcp ?? null,
      opencodeOwnership(cfg).managed ?? null,
    ]) !== before;
    return { oc, plugin, agents, skill, source, markersChanged };
  }
  const plugin = deployPlugin({
    pkgRoot, receipt: receipts.plugin, adoptionBlocked,
    ...(pluginsDir ? { pluginsDir } : {}),
  });
  const agents = syncAgents({
    source, receipts: receipts.agents, stampReceipt: receipts.agentStamp,
    adoptionBlocked: receiptState.agentsAdoptionBlocked,
    ...(agentsDir ? { destDir: agentsDir } : {}),
  });
  const skill = deploySkill({
    source, receipt: receipts.skill, adoptionBlocked,
    ...(skillsDir ? { skillsDir } : {}),
  });
  if (!adoptionBlocked) {
    mutableOpencodeOwnership(cfg).managed.artifacts = {
      plugin: plugin.receipt ?? receipts.plugin ?? null,
      agents: agents.receipts ?? receipts.agents ?? {},
      agentStamp: agents.stampReceipt ?? receipts.agentStamp ?? null,
      skill: skill.receipt ?? receipts.skill ?? null,
    };
  }
  const markersChanged = JSON.stringify([
    opencodeOwnership(cfg).mcp ?? null,
    opencodeOwnership(cfg).managed ?? null,
  ]) !== before;
  return { oc, plugin, agents, skill, source, markersChanged };
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
    const plugin = opts.pkgRoot
      ? pluginStatus({
          pkgRoot: opts.pkgRoot, receipt: receipts.plugin, adoptionBlocked,
          ...(opts.pluginsDir ? { pluginsDir: opts.pluginsDir } : {}),
        })
      : { present: false, current: false, foreign: false, adoptable: false };
    const agents = agentsStatus({
      source, receipts: receipts.agents, stampReceipt: receipts.agentStamp,
      adoptionBlocked: receiptState.agentsAdoptionBlocked,
      ...(opts.agentsDir ? { destDir: opts.agentsDir } : {}),
    });
    const skill = skillStatus({
      source, receipt: receipts.skill, adoptionBlocked,
      ...(opts.skillsDir ? { skillsDir: opts.skillsDir } : {}),
    });
    return { enabled: !!cfg.integrations?.hosts?.opencode, convergence, plugin, agents, skill };
  };
  return {
    id: 'opencode',
    detect,
    async plan(request = {}) {
      const facts = request.facts ?? await detect(request);
      const changed = facts.enabled && (!facts.convergence.converged
        || facts.plugin.adoptable || (!facts.plugin.current && !facts.plugin.foreign)
        || (!facts.agents.adoptionBlocked && (facts.agents.adoptable || facts.agents.stale))
        || facts.skill.adoptable || (!facts.skill.current && !facts.skill.foreign));
      return { changed, facts, operations: changed ? ['config', 'plugin', 'agents', 'skill'] : [] };
    },
    async apply(request = {}) {
      const cfg = request.cfg;
      const opts = options(request);
      if (!cfg || !opts.pkgRoot) throw new TypeError('opencode lifecycle apply requires cfg and pkgRoot');
      const result = await opencodeStack(cfg, opts);
      return {
        changed: result.oc.changed || result.plugin.changed || result.agents.changed
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
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
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

/** Convert every agent under <src>/.claude/agents into opencode form:
 *  frontmatter → {description, mode: subagent} (Claude's `tools:` string list
 *  is dropped — opencode uses permissions; subagents inherit the invoker's
 *  tool access, matching the broad lists these agents declare); body MCP refs
 *  rewritten across all three spellings the catalog uses
 *  (mcp__claude-flow__ / mcp__claude_flow__ / mcp__ruflo__ → claude-flow_);
 *  basename collisions across category dirs get the parent dir prefixed. The
 *  description is emitted as a JSON double-quoted scalar (valid YAML 1.2 —
 *  unquoted values containing ': ' or '#' would corrupt the frontmatter).
 *  Pure (returns content, writes nothing).
 *  @param {string} srcRoot */
export function convertAgents(srcRoot) {
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
      body: parsed.body
        .replace(/mcp__claude-flow__/g, 'claude-flow_')
        .replace(/mcp__claude_flow__/g, 'claude-flow_')
        .replace(/mcp__ruflo__/g, 'claude-flow_'),
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

const isGeneratedContent = (text) => AGENT_MARKERS.some((m) => text.includes(m));

/** Reconcile the converted agent set into the dest dir: rewrite generated
 *  files, remove stale generated ones (either marker), NEVER overwrite a file
 *  that carries no generated marker (a user-owned agent with a colliding name
 *  is preserved and reported). The stamp records the source id + the exact
 *  generated file list and is only rewritten when the set actually changed
 *  (no per-run timestamp churn — idempotent-write semantics).
 *  @param {{ source: CatalogSource|null, destDir?: string, dryRun?: boolean, receipts?:Record<string,string>, stampReceipt?:string|null, adoptionBlocked?:boolean }} opts */
export function syncAgents({
  source, destDir = paths.opencodeAgentsDir(), dryRun = false, receipts = {}, stampReceipt = null,
  adoptionBlocked = false,
}) {
  if (!source) return { ok: false, changed: false, detail: 'no ruflo catalog source (marketplace clone or @claude-flow/cli) found' };
  const receiptMap = receipts && typeof receipts === 'object' && !Array.isArray(receipts)
    ? receipts
    : {};
  const { agents, scanned, skipped, renamed } = convertAgents(source.root);
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  let removed = 0, userOwned = 0, adopted = 0;
  const removedFiles = new Set();
  if (fs.existsSync(destDir)) {
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
  let written = 0;
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
  const changed = written > 0 || removed > 0;
  // The stamp records what was ACTUALLY deployed (a user-owned file occupying
  // a slot is never in it) — otherwise status would diverge forever.
  // Preserve a non-null mismatched receipt while its file still exists. If it
  // were dropped, a later pass could mistake the resulting absence for a
  // pre-receipts install and launder an edited file back into ak ownership.
  const nextReceipts = Object.fromEntries(Object.entries(receiptMap).filter(([f]) => (
    !removedFiles.has(f) && fs.existsSync(path.join(destDir, f))
  )));
  const deployedHashes = Object.fromEntries(deployed.map((f) => {
    const agent = agents.find((a) => `${a.name}.md` === f);
    return [f, contentHash(agent.content)];
  }));
  Object.assign(nextReceipts, deployedHashes);
  const stamp = { source: source.id, count: deployed.length, files: deployed.sort(), hashes: deployedHashes };
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
  return {
    ok: true,
    changed,
    receipts: nextReceipts,
    stampReceipt: mayWriteStamp ? contentHash(stampText) : stampReceipt,
    adopted,
    detail: `${agents.length} agents from ${source.id} (${written} written, ${removed} removed, ${skipped} skipped, ${renamed} collision-renamed${adopted ? `, ${adopted} adopted` : ''}${userOwned ? `, ${userOwned} user-owned preserved` : ''}; scanned ${scanned})`,
  };
}

/** Agent-set drift, honestly: stale when the stamp is missing, the catalog
 *  source id diverged (upgrade/marketplace pull), or the on-disk generated
 *  file set differs from the stamp. Count reports marker-bearing agents for
 *  visibility, while receipt/hash divergence is reported as `modified` so
 *  callers classify user edits as preserved rather than repairable drift.
 *  @param {{ source?: CatalogSource|null, destDir?: string, receipts?:Record<string,string>|null, stampReceipt?:string|null, adoptionBlocked?:boolean }} [opts] */
export function agentsStatus({
  source, destDir = paths.opencodeAgentsDir(), receipts = null, stampReceipt = null,
  adoptionBlocked = false,
} = {}) {
  const stampPath = path.join(destDir, STAMP_FILE);
  const stamp = readJson(stampPath, null);
  const stampText = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null;
  const hasReceiptLedger = receipts !== null;
  const receiptMap = receipts && typeof receipts === 'object' && !Array.isArray(receipts)
    ? receipts
    : {};
  const desired = source
    ? new Map(convertAgents(source.root).agents.map((a) => [`${a.name}.md`, a.content]))
    : new Map();
  const adoptableFiles = [];
  let generatedCount = 0;
  if (fs.existsSync(destDir)) {
    for (const f of fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
      try { if (isGeneratedContent(fs.readFileSync(path.join(destDir, f), 'utf8'))) generatedCount++; } catch { /* skip */ }
    }
  }
  const onDisk = fs.existsSync(destDir)
    ? fs.readdirSync(destDir).filter((f) => {
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
      }).sort()
    : [];
  const stampFiles = Array.isArray(stamp?.files) ? [...stamp.files].sort() : null;
  const filesDiverged = stampFiles != null && JSON.stringify(stampFiles) !== JSON.stringify(onDisk);
  const contentDiverged = !!stamp?.hashes && onDisk.some((f) => {
    try { return contentHash(fs.readFileSync(path.join(destDir, f), 'utf8')) !== stamp.hashes[f]; } catch { return true; }
  });
  const expectedStamp = source && onDisk.length > 0 && onDisk.every((f) => desired.has(f))
    ? `${JSON.stringify({
        source: source.id,
        count: onDisk.length,
        files: onDisk,
        // syncAgents hashes in converter declaration order, then sorts only
        // the separate files list. Preserve that byte order for exact
        // stamp-only adoption detection.
        hashes: Object.fromEntries([...desired.entries()]
          .filter(([f]) => onDisk.includes(f))
          .map(([f, text]) => [f, contentHash(text)])),
      }, null, 2)}\n`
    : null;
  const stampAdoptable = hasReceiptLedger && !adoptionBlocked && !hasReceiptValue(stampReceipt)
    && expectedStamp !== null && stampText === expectedStamp;
  return {
    count: generatedCount,
    stampedId: stamp?.source ?? null,
    currentId: source?.id ?? null,
    adoptable: !adoptionBlocked && (adoptableFiles.length > 0 || stampAdoptable),
    adoptionBlocked,
    modified: contentDiverged || (hasReceiptLedger && fs.existsSync(destDir)
      && fs.readdirSync(destDir).filter((f) => f.endsWith('.md')).some((f) => {
        try {
          return hasReceiptValue(receiptMap[f])
            && !receiptMatches(fs.readFileSync(path.join(destDir, f), 'utf8'), receiptMap[f]);
        } catch { return true; }
      })),
    stale: !stamp || stamp.source !== (source?.id ?? null) || filesDiverged,
  };
}

// ── plugin (lifecycle bridge) ────────────────────────────────────────────────

export const PLUGIN_NAME = 'ruflo-hooks.js';
const pluginTemplate = (pkgRoot) => path.join(pkgRoot, 'src', 'templates', 'opencode-ruflo-hooks.js');

/** The marker any ak-deployed plugin copy carries (from the template header). */
const PLUGIN_MARKER = 'src/templates/opencode-ruflo-hooks.js';

/** Deploy the lifecycle bridge plugin from the kit's template, content-diffed
 *  (rewrites only when the template changed — hash-stamped by content itself).
 *  A destination file that exists WITHOUT the ak marker is user-owned:
 *  preserved and reported, never overwritten.
 *  @param {{ pkgRoot: string, pluginsDir?: string, dryRun?: boolean, receipt?:string|null, adoptionBlocked?:boolean }} opts */
export function deployPlugin({
  pkgRoot, pluginsDir = paths.opencodePluginsDir(), dryRun = false, receipt = null,
  adoptionBlocked = false,
}) {
  const tpl = pluginTemplate(pkgRoot);
  if (!fs.existsSync(tpl)) return { ok: false, changed: false, detail: `template missing: ${tpl}` };
  const want = fs.readFileSync(tpl, 'utf8');
  const dest = path.join(pluginsDir, PLUGIN_NAME);
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  const hasReceipt = adoptionBlocked || hasReceiptValue(receipt);
  const adoptable = cur === want && !hasReceipt && cur.includes(PLUGIN_MARKER);
  if (cur === want && (receiptMatches(cur, receipt) || adoptable)) {
    return {
      ok: true, changed: false, receipt: contentHash(cur), adopted: adoptable,
      detail: adoptable ? 'lifecycle plugin adopted into receipt ledger' : 'lifecycle plugin current',
    };
  }
  if (cur !== null && (!hasReceipt || !receiptMatches(cur, receipt))) {
    return { ok: true, changed: false, receipt, detail: `⚠ ${dest} differs from ak's last-written receipt (user-owned/edited) — left untouched` };
  }
  if (!dryRun) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(dest, want);
  }
  return { ok: true, changed: true, receipt: contentHash(want), detail: cur == null ? 'lifecycle plugin deployed (ruflo-hooks.js)' : 'lifecycle plugin updated (ruflo-hooks.js)' };
}

/** Plugin presence/currency against the kit template. `foreign` flags a
 *  user-owned file occupying the destination (status must not nag to
 *  overwrite it — deploy will leave it alone). */
export function pluginStatus({
  pkgRoot, pluginsDir = paths.opencodePluginsDir(), receipt = null, adoptionBlocked = false,
}) {
  const dest = path.join(pluginsDir, PLUGIN_NAME);
  const present = fs.existsSync(dest);
  const currentText = present ? fs.readFileSync(dest, 'utf8') : null;
  const tpl = pluginTemplate(pkgRoot);
  const desired = fs.existsSync(tpl) ? fs.readFileSync(tpl, 'utf8') : null;
  const hasReceipt = adoptionBlocked || hasReceiptValue(receipt);
  const receiptOwned = present && receiptMatches(currentText, receipt);
  const adoptable = present && !hasReceipt && desired !== null
    && currentText === desired && currentText.includes(PLUGIN_MARKER);
  const foreign = present && !receiptOwned && !adoptable;
  const current = present && !foreign && desired !== null && currentText === desired;
  return { present, current, foreign, adoptable, adoptionBlocked };
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
  const plugin = path.join(pluginsDir, PLUGIN_NAME);
  if (fs.existsSync(plugin) && receipts.plugin
      && contentHash(fs.readFileSync(plugin, 'utf8')) === receipts.plugin) {
    fs.rmSync(plugin, { force: true });
    removed.push('plugin ruflo-hooks.js');
  }
  if (fs.existsSync(agentsDir)) {
    let n = 0;
    for (const f of fs.readdirSync(agentsDir)) {
      const p = path.join(agentsDir, f);
      if (f === STAMP_FILE && receipts.agentStamp
          && contentHash(fs.readFileSync(p, 'utf8')) === receipts.agentStamp) {
        fs.rmSync(p, { force: true }); continue;
      }
      if (f.endsWith('.md') && receipts.agents?.[f]
          && contentHash(fs.readFileSync(p, 'utf8')) === receipts.agents[f]) {
        fs.rmSync(p, { force: true });
        n++;
      }
    }
    if (n) removed.push(`${n} generated agents`);
  }
  const skillDir = path.join(skillsDir, 'ruflo');
  const skill = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skill) && receipts.skill
      && contentHash(fs.readFileSync(skill, 'utf8')) === receipts.skill) {
    fs.rmSync(skill, { force: true });
    rmdirIfEmpty(skillDir);
    removed.push('platform skill');
  }
  return { ok: true, changed: removed.length > 0, detail: removed.length ? `removed: ${removed.join(', ')}` : 'no ak-deployed artifacts found' };
}
