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
import { have } from './exec.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import * as paths from './paths.mjs';

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

/** @typedef {{ kind: string, root: string, id: string, hasPlugins: boolean, hasPlatformSkill: boolean }} CatalogSource */

/** The MCP server entries ak writes. `claude-flow` prefers the dedicated
 *  claude-flow-mcp bin (purpose-built stdio server) and falls back to
 *  `ruflo mcp start` (ak's claude/codex registration) when it is absent.
 *  ruvnet-brain is included only when its shim is on disk.
 *  @param {{ brainShim?: string }} [opts] */
export async function mcpEntriesFor({ brainShim = brainShimPath() } = {}) {
  const entries = {
    'claude-flow': {
      type: 'local',
      command: (await have('claude-flow-mcp')) ? ['claude-flow-mcp'] : ['ruflo', 'mcp', 'start'],
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
    return { exists, parseError: true, claudeFlow: false, brain: false, owned: cfg?.providers?.opencodeMcp === 'ak' };
  }
  return {
    exists,
    parseError: false,
    claudeFlow: !!doc?.mcp?.['claude-flow'],
    brain: !!doc?.mcp?.['ruvnet-brain'],
    paths: doc?.skills?.paths ?? [],
    owned: cfg?.providers?.opencodeMcp === 'ak',
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
  const source = catalogSource({ override: cfg.providers?.opencodeCatalogDir });
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

/** Normalize an opencodeManaged record — the current precise shape
 *  { mcp: {name:{prior,written}}, paths: [], permissions: {key:{prior,written}} },
 *  tolerating the legacy names-only shape from the first shipped version
 *  (legacy entries have unknown prior/written → treated conservatively: prior
 *  null, written null → never auto-deleted, only re-recorded on next apply). */
function normalizeManaged(m) {
  const out = { mcp: {}, paths: [], permissions: {} };
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
  return out;
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
  if (!cfg.providers?.hosts?.opencode) return { ok: true, changed: false, detail: 'opencode not enabled — unmanaged' };
  const exists = fs.existsSync(configFile);
  const { ok: parsedOk, doc } = exists ? readJsonStrict(configFile) : { ok: true, doc: {} };
  if (!parsedOk) {
    return { ok: false, changed: false, detail: `${configFile} is not plain JSON (JSONC comments?) — refusing to touch it; merge manually` };
  }
  const entries = await mcpEntriesFor({ brainShim });
  const source = catalogSource({ override: cfg.providers?.opencodeCatalogDir });
  const skillPaths = skillPathsFor(source);
  const prevManaged = normalizeManaged(cfg.providers?.opencodeManaged);
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
      delete next.mcp[name];
      pruned.push(name);
    } // else: user edited (or legacy record) → leave it, keep no ownership
  }
  const managed = { mcp: {}, paths: [], permissions: {} };
  for (const [name, want] of Object.entries(entries)) {
    const cur = next.mcp[name];
    const priorRec = prevManaged.mcp[name];
    if (cur !== undefined && !deepEqual(cur, want) && !(priorRec?.written && deepEqual(cur, priorRec.written))) {
      collisions.push(`mcp.${name}`);
      managed.mcp[name] = { prior: cur, written: null }; // tracked but NOT ak-owned
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
  if (typeof next.permission === 'string') next.permission = { '*': next.permission };
  next.permission = { ...(next.permission ?? {}) };
  for (const [k, rec] of Object.entries(prevManaged.permissions)) {
    if (PERMISSION_KEYS.includes(k)) continue;
    if (!(k in next.permission)) continue;
    if (rec.written && deepEqual(next.permission[k], rec.written)) {
      delete next.permission[k];
      pruned.push(`permission.${k}`);
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
  if (cfg.providers) {
    cfg.providers.opencodeMcp = 'ak';
    cfg.providers.opencodeManaged = managed;
  }
  if (changed && !dryRun) writeJsonWithBackup(configFile, next);
  const brain = entries['ruvnet-brain'] ? ' + ruvnet-brain' : ' (brain shim absent — ruflo only)';
  const notes = [
    changed ? `opencode.json wired: claude-flow (${entries['claude-flow'].command.join(' ')})${brain}, ${skillPaths.length} skills path(s), ${PERMISSION_KEYS.length} permission pattern(s)`
      : `opencode.json in sync${source ? '' : ' — ⚠ no ruflo catalog source found for skills.paths'}`,
  ];
  if (pruned.length) notes.push(`pruned: ${pruned.join(', ')}`);
  if (collisions.length) notes.push(`⚠ collisions preserved (user-owned, untouched): ${collisions.join(', ')}`);
  return { ok: collisions.length === 0, changed, detail: notes.join(' — ') };
}

/** Surgical teardown of ak's opencode.json wiring — ONLY the recorded managed
 *  keys, and ONLY when ak wrote them (providers.opencodeMcp === 'ak'). For each
 *  managed key: when the current value still equals what ak wrote, the user's
 *  PRIOR value is restored (or the key removed if there was none); a value the
 *  user edited since is left and reported, never silently deleted. Scalar
 *  permission shorthand is restored to scalar when teardown empties the object
 *  but a prior '*' wildcard exists. Deployed artifacts are removed separately
 *  (removeArtifacts).
 *  @param {any} cfg @param {{ configFile?: string }} [opts] */
export function undoOpencode(cfg, { configFile = paths.opencodeConfigPath() } = {}) {
  if (cfg?.providers?.opencodeMcp !== 'ak') {
    return { ok: true, changed: false, detail: 'opencode.json left as-is (not ak-managed)' };
  }
  const managed = normalizeManaged(cfg.providers?.opencodeManaged);
  if (!fs.existsSync(configFile)) return { ok: true, changed: false, detail: 'opencode.json absent — nothing to strip' };
  const { ok: parsedOk, doc } = readJsonStrict(configFile);
  if (!parsedOk) return { ok: true, changed: false, detail: 'opencode.json unparseable — nothing to strip (refusing to touch JSONC)' };
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

  const hadScalarStar = typeof doc.permission === 'object' && doc.permission?.['*'] != null;
  for (const [k, rec] of Object.entries(managed.permissions)) restore(doc.permission, k, rec, `permission.${k}`);
  if (doc.permission && Object.keys(doc.permission).length === 0) delete doc.permission;
  else if (doc.permission && hadScalarStar && Object.keys(doc.permission).length === 1 && doc.permission['*'] != null) {
    doc.permission = doc.permission['*']; // restore the scalar shorthand we lifted
    changed = true;
  }

  if (changed) writeJsonWithBackup(configFile, doc);
  if (cfg.providers) { cfg.providers.opencodeMcp = null; cfg.providers.opencodeManaged = null; }
  const detail = [
    changed ? 'ak-managed opencode.json wiring stripped (user priors restored)' : 'nothing managed found in opencode.json',
    kept.length ? `left untouched: ${kept.join(', ')}` : null,
  ].filter(Boolean).join(' — ');
  return { ok: true, changed, detail };
}

// ── ruflo catalog source (agents + skills) ──────────────────────────────────

/** Resolve where ruflo's agent/skill catalog comes from. Order: explicit
 *  override (kit.json providers.opencodeCatalogDir) → $RUFLO_REPO → the claude
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
 *  @param {{ source: CatalogSource|null, destDir?: string, dryRun?: boolean }} opts */
export function syncAgents({ source, destDir = paths.opencodeAgentsDir(), dryRun = false }) {
  if (!source) return { ok: false, changed: false, detail: 'no ruflo catalog source (marketplace clone or @claude-flow/cli) found' };
  const { agents, scanned, skipped, renamed } = convertAgents(source.root);
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  let removed = 0, userOwned = 0;
  if (fs.existsSync(destDir)) {
    for (const f of fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
      const p = path.join(destDir, f);
      let isGenerated = false;
      try { isGenerated = isGeneratedContent(fs.readFileSync(p, 'utf8')); } catch { /* leave alone */ }
      const wanted = agents.some((a) => `${a.name}.md` === f);
      if (isGenerated && !wanted) { if (!dryRun) fs.rmSync(p); removed++; }
    }
  }
  let written = 0;
  const deployed = [];
  for (const a of agents) {
    const p = path.join(destDir, `${a.name}.md`);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (cur !== null && cur !== a.content && !isGeneratedContent(cur)) { userOwned++; continue; }
    deployed.push(`${a.name}.md`);
    if (cur !== a.content) {
      written++;
      if (!dryRun) fs.writeFileSync(p, a.content);
    }
  }
  const changed = written > 0 || removed > 0;
  // The stamp records what was ACTUALLY deployed (a user-owned file occupying
  // a slot is never in it) — otherwise status would diverge forever.
  const stamp = { source: source.id, count: deployed.length, files: deployed.sort() };
  const priorStamp = readJson(path.join(destDir, STAMP_FILE), null);
  if (!dryRun && (changed || !priorStamp || JSON.stringify(priorStamp) !== JSON.stringify(stamp))) {
    fs.writeFileSync(path.join(destDir, STAMP_FILE), JSON.stringify(stamp, null, 2) + '\n');
  }
  return {
    ok: true,
    changed,
    detail: `${agents.length} agents from ${source.id} (${written} written, ${removed} removed, ${skipped} skipped, ${renamed} collision-renamed${userOwned ? `, ${userOwned} user-owned preserved` : ''}; scanned ${scanned})`,
  };
}

/** Agent-set drift, honestly: stale when the stamp is missing, the catalog
 *  source id diverged (upgrade/marketplace pull), or the on-disk generated
 *  file set differs from the stamp (deleted/extra/edited-then-removed files).
 *  Count reports GENERATED (marker-bearing) agents — user files are not ak's
 *  to count. Content edits to an existing generated file are detected as
 *  'modified' only by name-set comparison's complement, so those surface via
 *  sync's content-diff rewrite rather than here (documented asymmetry: status
 *  catches structural drift; sync fixes content drift when it runs).
 *  @param {{ source?: CatalogSource|null, destDir?: string }} [opts] */
export function agentsStatus({ source, destDir = paths.opencodeAgentsDir() } = {}) {
  const stamp = readJson(path.join(destDir, STAMP_FILE), null);
  let generatedCount = 0;
  if (fs.existsSync(destDir)) {
    for (const f of fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
      try { if (isGeneratedContent(fs.readFileSync(path.join(destDir, f), 'utf8'))) generatedCount++; } catch { /* skip */ }
    }
  }
  const onDisk = fs.existsSync(destDir)
    ? fs.readdirSync(destDir).filter((f) => {
        if (!f.endsWith('.md')) return false;
        try { return isGeneratedContent(fs.readFileSync(path.join(destDir, f), 'utf8')); } catch { return false; }
      }).sort()
    : [];
  const stampFiles = Array.isArray(stamp?.files) ? [...stamp.files].sort() : null;
  const filesDiverged = stampFiles != null && JSON.stringify(stampFiles) !== JSON.stringify(onDisk);
  return {
    count: generatedCount,
    stampedId: stamp?.source ?? null,
    currentId: source?.id ?? null,
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
 *  @param {{ pkgRoot: string, pluginsDir?: string, dryRun?: boolean }} opts */
export function deployPlugin({ pkgRoot, pluginsDir = paths.opencodePluginsDir(), dryRun = false }) {
  const tpl = pluginTemplate(pkgRoot);
  if (!fs.existsSync(tpl)) return { ok: false, changed: false, detail: `template missing: ${tpl}` };
  const want = fs.readFileSync(tpl, 'utf8');
  const dest = path.join(pluginsDir, PLUGIN_NAME);
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  if (cur === want) return { ok: true, changed: false, detail: 'lifecycle plugin current' };
  if (cur !== null && !cur.includes(PLUGIN_MARKER)) {
    return { ok: true, changed: false, detail: `⚠ ${dest} exists without the ak marker (user-owned) — left untouched` };
  }
  if (!dryRun) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(dest, want);
  }
  return { ok: true, changed: true, detail: cur == null ? 'lifecycle plugin deployed (ruflo-hooks.js)' : 'lifecycle plugin updated (ruflo-hooks.js)' };
}

/** Plugin presence/currency against the kit template. `foreign` flags a
 *  user-owned file occupying the destination (status must not nag to
 *  overwrite it — deploy will leave it alone). */
export function pluginStatus({ pkgRoot, pluginsDir = paths.opencodePluginsDir() }) {
  const dest = path.join(pluginsDir, PLUGIN_NAME);
  const present = fs.existsSync(dest);
  const foreign = present && !fs.readFileSync(dest, 'utf8').includes(PLUGIN_MARKER);
  const tpl = pluginTemplate(pkgRoot);
  const current = present && !foreign && fs.existsSync(tpl) && fs.readFileSync(dest, 'utf8') === fs.readFileSync(tpl, 'utf8');
  return { present, current, foreign };
}

// ── platform skill ───────────────────────────────────────────────────────────

const SKILL_DEPLOYED_MARKER = '<!-- deployed by agentic-kit -->';

/** Deploy ruflo's platform SKILL.md (from the catalog source) into opencode's
 *  global skills dir, stamped with the source id for drift detection. A
 *  destination SKILL.md without the ak marker is user-owned: preserved.
 *  @param {{ source: CatalogSource|null, skillsDir?: string, dryRun?: boolean }} opts */
export function deploySkill({ source, skillsDir = paths.opencodeSkillsDir(), dryRun = false }) {
  if (!source?.hasPlatformSkill) return { ok: true, changed: false, detail: `no platform SKILL.md in catalog source${source ? ` (${source.id})` : ''}` };
  const src = path.join(source.root, 'SKILL.md');
  const dest = path.join(skillsDir, 'ruflo', 'SKILL.md');
  const want = `${fs.readFileSync(src, 'utf8').replace(/\s*$/, '')}\n\n${SKILL_DEPLOYED_MARKER} from ${source.id} — re-synced by \`ak sync\`\n`;
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  if (cur === want) return { ok: true, changed: false, detail: 'platform skill current' };
  if (cur !== null && !cur.includes(SKILL_DEPLOYED_MARKER)) {
    return { ok: true, changed: false, detail: `⚠ ${dest} exists without the ak marker (user-owned) — left untouched` };
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
  }
  return { ok: true, changed: true, detail: `platform skill deployed (skills/ruflo/SKILL.md, ${source.id})` };
}

/** Platform skill presence/currency against the catalog source id. `foreign`
 *  flags a user-owned SKILL.md at the destination.
 *  @param {{ source?: CatalogSource|null, skillsDir?: string }} [opts] */
export function skillStatus({ source, skillsDir = paths.opencodeSkillsDir() } = {}) {
  const dest = path.join(skillsDir, 'ruflo', 'SKILL.md');
  const present = fs.existsSync(dest);
  const foreign = present && !fs.readFileSync(dest, 'utf8').includes(SKILL_DEPLOYED_MARKER);
  return {
    present,
    foreign,
    current: present && !foreign && !!source?.hasPlatformSkill
      && fs.readFileSync(dest, 'utf8').includes(`from ${source.id}`),
  };
}

/** Remove ak-deployed artifacts (marker-gated — user files are never touched):
 *  the lifecycle plugin, generated agents (+ stamp), the platform skill's
 *  SKILL.md. Directories are pruned only when EMPTY after the managed files
 *  are gone — user resources placed beside them survive.
 *  @param {{ pluginsDir?: string, agentsDir?: string, skillsDir?: string }} [opts] */
export function removeArtifacts({ pluginsDir = paths.opencodePluginsDir(), agentsDir = paths.opencodeAgentsDir(), skillsDir = paths.opencodeSkillsDir() } = {}) {
  const removed = [];
  const rmdirIfEmpty = (dir) => {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* absent or not empty */ }
  };
  const plugin = path.join(pluginsDir, PLUGIN_NAME);
  if (fs.existsSync(plugin) && fs.readFileSync(plugin, 'utf8').includes(PLUGIN_MARKER)) {
    fs.rmSync(plugin, { force: true });
    removed.push('plugin ruflo-hooks.js');
  }
  if (fs.existsSync(agentsDir)) {
    let n = 0;
    for (const f of fs.readdirSync(agentsDir)) {
      const p = path.join(agentsDir, f);
      if (f === STAMP_FILE) { fs.rmSync(p, { force: true }); continue; }
      if (f.endsWith('.md') && AGENT_MARKERS.some((m) => fs.readFileSync(p, 'utf8').includes(m))) {
        fs.rmSync(p, { force: true });
        n++;
      }
    }
    if (n) removed.push(`${n} generated agents`);
  }
  const skillDir = path.join(skillsDir, 'ruflo');
  const skill = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skill) && fs.readFileSync(skill, 'utf8').includes(SKILL_DEPLOYED_MARKER)) {
    fs.rmSync(skill, { force: true });
    rmdirIfEmpty(skillDir);
    removed.push('platform skill');
  }
  return { ok: true, changed: removed.length > 0, detail: removed.length ? `removed: ${removed.join(', ')}` : 'no ak-deployed artifacts found' };
}
