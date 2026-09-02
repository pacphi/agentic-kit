// CLAUDE.md managed sentinel blocks — the port of _ruflo_block_upsert/_strip/
// _prepend and the conditional registry (_ruflo_cond_blocks). Sentinel format is
// UNCHANGED (`<!-- BEGIN <slug> -->` … `<!-- END <slug> -->`) so files written by
// the shell kit upgrade in place. Detectors are declarative (no eval'd shell —
// Windows-safe): {type: 'always'|'command'|'dir'|'file'|'glob-dir', target}.
// Built-ins may additionally compose those primitives with `enabled` (persisted
// flag first, legacy detector fallback) and `all` (logical conjunction).
// Built-in rows ship here; custom rows come from kit.json `customBlocks`.
//
// A `flag` detector ({type:'flag', target:'dualMode'}) gates a block on a
// caller-supplied boolean rather than the filesystem/PATH — the caller passes
// `syncBlocks(..., { context: { flags: { dualMode: <bool> } } })`. This is how
// we gate on kit.json enablement (both hosts on) instead of merely `codex` being
// on PATH. Absent context => false, so every legacy caller is unaffected.
//
// Rows may carry `guidanceFiles` (logical names, default ['claude']) declaring
// which guidance files they belong in — the caller loops targets via
// `blocksForTarget(rows, name)`. Logical names only; paths stay a caller concern.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, claudeMdPath, codexDir, opencodeDir, home } from './paths.mjs';
import { have } from './exec.mjs';
import { writeFileWithBackup } from './file-write.mjs';
import { HOST_REGISTRY } from './adapters/index.mjs';

export const BEGIN = (slug) => `<!-- BEGIN ${slug} -->`;
export const END = (slug) => `<!-- END ${slug} -->`;

// A deliberately pessimistic planning estimate. English prose often averages
// closer to four UTF-8 bytes/token, but three keeps the budget conservative
// without pretending that byte counts are tokenizer observations.
export const CONSERVATIVE_BYTES_PER_TOKEN = 3;

// Budgets cover agentic-kit-owned managed blocks only. User/project text and
// custom blocks remain visible in the footprint report but are not silently
// truncated. Unknown external guidance targets use the small fallback budget.
export const GUIDANCE_TARGET_BUDGETS = Object.freeze({
  claude: Object.freeze({ maxBytes: 12_000, maxConservativeTokens: 4_000 }),
  agents: Object.freeze({ maxBytes: 0, maxConservativeTokens: 0 }),
  'agents-user': Object.freeze({ maxBytes: 2_200, maxConservativeTokens: 734 }),
  'agents-opencode': Object.freeze({ maxBytes: 6_000, maxConservativeTokens: 2_000 }),
  external: Object.freeze({ maxBytes: 2_048, maxConservativeTokens: 683 }),
});

/** Built-in registry. templatePath is package-relative (resolved by caller
 *  against the kit's own claude/ dir or the staged config dir). `position` is
 *  where the block lands when it is NOT already present in the file. */
export const BUILTIN_BLOCKS = [
  {
    // Host-agnostic operating rules — shared by the claude + opencode machine
    // guidance files (the opencode file exists BECAUSE opencode prefers it over
    // falling back to ~/.claude/CLAUDE.md, so it needs its own copy).
    slug: 'ruflo-preamble',
    template: 'ruflo-preamble.md',
    position: 'prepend',
    detector: { type: 'always' },
    guidanceFiles: ['claude', 'agents-opencode'],
  },
  {
    slug: 'ruflo-reference',
    template: 'ruflo-reference.md',
    position: 'append',
    detector: {
      type: 'enabled', target: 'claudeEnabled', fallback: { type: 'always' },
    },
  },
  {
    // opencode's ruflo surface: MCP tools are `claude-flow_*` (not
    // `mcp__claude-flow__*`), hooks arrive via the plugins/ bridge, and agents
    // are converted subagents — a different enough story to warrant its own
    // template rather than reusing ruflo-reference. Gated on ENABLEMENT (the
    // opencodeEnabled flag, same mechanism as dualMode) — the template asserts
    // active wiring, so an installed-but-disabled host must not receive it
    // (codex-review r2; and `x provider off` → next sync strips it).
    slug: 'ruflo-opencode-reference',
    template: 'ruflo-opencode-reference.md',
    position: 'append',
    detector: { type: 'flag', target: 'opencodeEnabled' },
    guidanceFiles: ['agents-opencode'],
  },
  {
    // opencode twin of ruvnet-brain-reference (that slug stays claude-only):
    // same ground-before-assert rule, but the tool name is the opencode-style
    // `ruvnet-brain_search_ruvnet` and updates ride the stable-spine shim.
    // Likewise enablement-gated: the tool exists in opencode only when wired.
    slug: 'ruvnet-brain-opencode-reference',
    template: 'ruvnet-brain-opencode-reference.md',
    position: 'append',
    detector: {
      type: 'all', detectors: [
        { type: 'flag', target: 'opencodeEnabled' },
        {
          type: 'enabled', target: 'ruvnetBrainEnabled',
          fallback: { type: 'dir', target: '~/.cache/ruvnet-brain/kb' },
        },
      ],
    },
    guidanceFiles: ['agents-opencode'],
  },
  {
    slug: 'ruflo-aqe-reference',
    template: 'aqe-reference.md',
    position: 'append',
    detector: {
      type: 'all', detectors: [
        { type: 'enabled', target: 'claudeEnabled', fallback: { type: 'always' } },
        {
          type: 'enabled', target: 'aqeEnabled',
          fallback: { type: 'command', target: 'aqe' },
        },
      ],
    },
  },
  {
    slug: 'ruflo-superpowers-reference',
    template: 'superpowers-reference.md',
    position: 'append',
    // shell impl: find ~/.claude/plugins/cache -maxdepth 4 -type d -name superpowers
    detector: {
      type: 'all', detectors: [
        { type: 'enabled', target: 'claudeEnabled', fallback: { type: 'always' } },
        {
          type: 'enabled', target: 'superpowersEnabled',
          fallback: { type: 'glob-dir', target: 'superpowers', root: 'plugins/cache', maxDepth: 4 },
        },
      ],
    },
  },
  {
    // Persisted host intent is authoritative during setup/sync. PATH is only a
    // compatibility fallback for legacy direct callers that have no kit config.
    slug: 'ruflo-providers-reference',
    template: 'providers-reference.md',
    position: 'append',
    detector: {
      type: 'all', detectors: [
        { type: 'enabled', target: 'claudeEnabled', fallback: { type: 'always' } },
        {
          type: 'enabled', target: 'codexEnabled',
          fallback: { type: 'command', target: 'codex' },
        },
      ],
    },
  },
  {
    // Surfaces only when BOTH hosts are enabled in kit.json (dual mode) — gated
    // on a caller flag, not PATH, so it does not fire just because `codex` is
    // installed. Its content is MACHINE state (both hosts enabled in kit.json),
    // so it lands in the two MACHINE-scoped guidance files — ~/.claude/CLAUDE.md
    // (claude) and ~/.codex/AGENTS.md (agents-user) — never a repo's checked-in
    // AGENTS.md, which would leak machine truths into shared git history (ADR-0008).
    // Documents `ak run`, shared Ruflo/AQE access, and per-activity routing.
    slug: 'ruflo-dual-mode-reference',
    template: 'dual-mode-reference.md',
    position: 'append',
    detector: { type: 'flag', target: 'dualMode' },
    guidanceFiles: ['claude', 'agents-user'],
  },
  {
    // Persisted management intent is authoritative during setup/sync. The KB
    // directory remains a compatibility fallback for direct legacy callers.
    slug: 'ruvnet-brain-reference',
    template: 'ruvnet-brain-reference.md',
    position: 'append',
    detector: {
      type: 'all', detectors: [
        { type: 'enabled', target: 'claudeEnabled', fallback: { type: 'always' } },
        {
          type: 'enabled', target: 'ruvnetBrainEnabled',
          fallback: { type: 'dir', target: '~/.cache/ruvnet-brain/kb' },
        },
      ],
    },
  },
];

/** Evaluate a declarative detector. Returns boolean. `context` carries
 *  caller-supplied signals the filesystem can't provide (e.g. kit.json
 *  enablement) — currently `context.flags` for the `flag` detector. Defaulted
 *  so `detect(detector)` keeps working for every existing caller. */
export async function detect(detector, context = {}) {
  switch (detector?.type) {
    case 'always': return true;
    case 'command': return have(detector.target);
    case 'flag': return !!context?.flags?.[detector.target];
    case 'enabled': {
      if (Object.hasOwn(context?.flags ?? {}, detector.target)) {
        return context.flags[detector.target] === true;
      }
      return detector.fallback ? detect(detector.fallback, context) : false;
    }
    case 'all': {
      for (const part of detector.detectors ?? []) {
        if (!await detect(part, context)) return false;
      }
      return true;
    }
    case 'file': return fs.existsSync(expand(detector.target));
    case 'dir': {
      const p = expand(detector.target);
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    }
    case 'glob-dir': {
      const root = path.join(claudeDir(), detector.root ?? '');
      return dirNamed(root, detector.target, detector.maxDepth ?? 4);
    }
    default: return false;
  }
}

function expand(p) {
  return p?.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function dirNamed(root, name, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(root)) return false;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === name) return true;
    if (dirNamed(path.join(root, e.name), name, maxDepth, depth + 1)) return true;
  }
  return false;
}

/** Detect the file's dominant line ending so patched output round-trips on
 *  Windows checkouts. */
const eol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const normalize = (s) => s.replace(/\r\n/g, '\n');
const denormalize = (s, ending) => (ending === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

/** Is the block present in content? */
export function hasBlock(content, slug) {
  return normalize(content ?? '').includes(BEGIN(slug));
}

/** Upsert: replace in place when present (preserving everything outside the
 *  sentinels); otherwise append (or prepend, for position:'prepend') — exact
 *  port of _ruflo_block_upsert/_ruflo_block_prepend. Pure function on strings. */
export function upsertBlock(content, slug, blockText, position = 'append') {
  const block = normalize(blockText).replace(/\n+$/, '') + '\n';
  if (content == null || content === '') return block;
  const ending = eol(content);
  const text = normalize(content);
  const b = BEGIN(slug);
  const e = END(slug);
  let out;
  const bi = text.indexOf(b);
  const afterEndLine = bi !== -1 ? endOfSentinelLine(text, e, bi) : null;
  if (bi !== -1 && afterEndLine !== null) {
    out = text.slice(0, lineStart(text, bi)) + block + text.slice(afterEndLine);
  } else if (bi !== -1) {
    // Orphaned BEGIN (no END): append a fresh block instead of replacing "to
    // end-of-file" — the orphan stays visible for the user to clean up, and
    // nothing below it is destroyed.
    out = text.replace(/\n*$/, '\n') + '\n' + block;
  } else if (position === 'prepend') {
    out = block + '\n' + text;
  } else {
    out = text.replace(/\n*$/, '\n') + '\n' + block;
  }
  return denormalize(out, ending);
}

/** Strip the BEGIN..END block (inclusive, plus one trailing blank line). */
export function stripBlock(content, slug) {
  if (content == null) return content;
  const ending = eol(content);
  const text = normalize(content);
  const b = BEGIN(slug);
  const e = END(slug);
  const bi = text.indexOf(b);
  if (bi === -1) return content;
  const afterEndLine = endOfSentinelLine(text, e, bi);
  if (afterEndLine === null) return content; // orphaned BEGIN — never strip to EOF
  const tail = text.slice(afterEndLine).replace(/^\n/, '');
  // Collapse the blank separator line upsert added before the block.
  const head = text.slice(0, lineStart(text, bi)).replace(/\n+$/, '\n');
  return denormalize(head + tail, ending);
}

function lineStart(text, index) {
  const nl = text.lastIndexOf('\n', index - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Index just past the newline that terminates the sentinel `e`'s line, or
 *  NULL when the END sentinel is missing. Callers must treat null as "no
 *  well-formed block here" — the old fallback (run to end-of-file) meant an
 *  orphaned BEGIN silently deleted everything below it on the next upsert:
 *  irreversible loss of the user's global CLAUDE.md content. */
function endOfSentinelLine(text, e, from) {
  const ei = text.indexOf(e, from);
  if (ei === -1) return null;
  const nl = text.indexOf('\n', ei);
  return nl === -1 ? text.length : nl + 1;
}

/** Full registry = built-ins + kit.json custom rows (already-validated shape). */
export function registry(customBlocks = []) {
  const custom = customBlocks
    .filter((r) => r && r.slug && r.templatePath && r.detector)
    .map((r) => ({
      slug: r.slug,
      template: r.templatePath,
      position: r.position ?? 'append',
      detector: r.detector,
      guidanceFiles: Array.isArray(r.guidanceFiles) ? r.guidanceFiles : ['claude'],
      custom: true,
    }));
  return [...BUILTIN_BLOCKS, ...custom];
}

/** Filter rows to those belonging in a given logical guidance file (default
 *  membership is ['claude'] when a row omits `guidanceFiles`). Pure — lets a
 *  caller loop guidance-file targets (claude → CLAUDE.md, agents → AGENTS.md)
 *  without hardcoding paths in this module. */
export function blocksForTarget(rows, targetName) {
  return rows.filter((r) => (r.guidanceFiles ?? ['claude']).includes(targetName));
}

/** Merge persisted agentic-kit intent into detector context. Explicit kit
 *  configuration wins over incidental executable/directory presence; caller
 *  flags unrelated to these managed selectors are preserved. */
export function guidanceContextFromConfig(cfg, context = {}) {
  if (!cfg || typeof cfg !== 'object') return context;
  const hosts = cfg.integrations?.hosts ?? {};
  const derived = {
    claudeEnabled: hosts.claude === true,
    codexEnabled: hosts.codex === true,
    opencodeEnabled: hosts.opencode === true,
    dualMode: hosts.claude === true && hosts.codex === true,
    aqeEnabled: cfg.aqe !== false,
    ruvnetBrainEnabled: cfg.ruvnetBrain !== false,
  };
  return { ...context, flags: { ...(context.flags ?? {}), ...derived } };
}

/** Measure the exact managed-only text assembled by the block merger. Missing
 *  templates are reported as unknown and make compliance indeterminate; false
 *  detectors are explicit omissions rather than zero-cost observations. */
export async function guidanceFootprint(rows, targetName, resolveTemplate, { context = {} } = {}) {
  const included = [];
  const omitted = [];
  const unknown = [];
  let assembled = '';

  for (const row of blocksForTarget(rows, targetName)) {
    if (!await detect(row.detector, context)) {
      omitted.push({ slug: row.slug, reason: 'detector-false' });
      continue;
    }
    const template = resolveTemplate(row);
    if (!template || !fs.existsSync(template)) {
      unknown.push({ slug: row.slug, reason: 'missing-template' });
      continue;
    }
    const text = fs.readFileSync(template, 'utf8');
    included.push({ slug: row.slug, bytes: Buffer.byteLength(text, 'utf8') });
    assembled = upsertBlock(assembled, row.slug, text, row.position);
  }

  const bytes = Buffer.byteLength(assembled, 'utf8');
  const conservativeTokens = Math.ceil(bytes / CONSERVATIVE_BYTES_PER_TOKEN);
  const budget = GUIDANCE_TARGET_BUDGETS[targetName] ?? GUIDANCE_TARGET_BUDGETS.external;
  return {
    target: targetName,
    bytes,
    conservativeTokens,
    budget,
    withinBudget: unknown.length > 0 ? null
      : bytes <= budget.maxBytes && conservativeTokens <= budget.maxConservativeTokens,
    included,
    omitted,
    unknown,
  };
}

/** Registry rows whose sentinel might linger in a target's file but which no
 *  longer belong there (they don't list `targetName` in guidanceFiles). This is
 *  the migration path for a RE-SCOPED block: pass these to `syncBlocks` alongside
 *  `blocksForTarget` and they are force-stripped when present. Each returned row
 *  carries a detector that never fires (`{type:'retired'}` → detect() falls to
 *  its default false), so a present block is stripped and an absent one is a
 *  no-op — the original detector (e.g. a live `flag`) can never re-upsert it into
 *  a file it must stay out of. Absent from the file → nothing happens (no write).
 *
 *  `knownTargets` (optional) is the full universe of REAL target names — e.g.
 *  `guidanceTargets().map(t => t.name)`. When supplied, a row is only force-
 *  stripped when it names at least one target from that universe: it was
 *  legitimately re-scoped AWAY from `targetName` to some other real target
 *  (F-17's original migration case — see the dual-mode-reference tests). A row
 *  whose `guidanceFiles` name NOTHING in `knownTargets` (a typo, or a target no
 *  currently-registered host produces) is left alone instead of being force-
 *  stripped from every real file — this module has no basis for treating an
 *  unrecognized target as "retired from here." Omitting `knownTargets`
 *  preserves the original unconditional behavior for every existing 2-arg call
 *  site (status.mjs, nudge.mjs, opencode.mjs — this refactor's edit boundary
 *  doesn't cover them; only `reconcileGuidance` below opts into the 3-arg
 *  form). For the registry as it ships today every row's `guidanceFiles` are
 *  already within the known-target universe, so this is a no-observable-change
 *  refinement, not a behavior change. */
export function retiredForTarget(rows, targetName, knownTargets) {
  return rows
    .filter((r) => {
      const files = r.guidanceFiles ?? ['claude'];
      if (files.includes(targetName)) return false;
      if (!knownTargets) return true;
      return files.some((f) => knownTargets.includes(f));
    })
    .map((r) => ({ ...r, detector: { type: 'retired' } }));
}

/** Per-host guidance-target construction (F-17). Every host in `hosts` that
 *  declares `capabilities.nativeGuidance` contributes a target named after its
 *  `legacy.guidanceFile` — the logical name HOST_REGISTRY already carries but
 *  which nothing consumed before this. Paths/labels/presence-gating stay a
 *  caller concern (see the module header comment: "Logical names only; paths
 *  stay a caller concern"), so this module still owns the bespoke mapping for
 *  the three hosts it knows about:
 *    - claude → 'claude': machine-wide `~/.claude/CLAUDE.md`, always included.
 *    - codex  → 'agents': the project's own `<cwd>/AGENTS.md`, always included
 *      (the AGENTS.md convention is host-neutral, not gated on codex being
 *      installed). codex ALSO contributes a companion machine-scoped target,
 *      'agents-user' (`~/.codex/AGENTS.md`) — included only when `~/.codex`
 *      already exists (codex's presence signal) and NEVER created by this
 *      discovery (dir-exists gate, no mkdir: a momentarily single-host codex
 *      machine still gets the target so a stale block can be stripped; a
 *      codex-less machine never grows a ~/.codex). This companion has no
 *      `guidanceFile` entry of its own in HOST_REGISTRY — the registry models
 *      one logical guidance file per host today, and adding a second field is
 *      outside blocks.mjs's edit boundary — so it stays keyed off the codex
 *      host id rather than being independently derived.
 *    - opencode → 'agents-opencode': `~/.config/opencode/AGENTS.md`, included
 *      only when opencode's config home already exists (identical presence
 *      rule to agents-user; opencode prefers this file over
 *      ~/.claude/CLAUDE.md, so it needs its own managed copy).
 *  A host id this module has no bespoke mapping for still joins the loop (it is
 *  not silently dropped the way the old hardcoded array would drop it): it gets
 *  a generic, always-on target named after its own `guidanceFile`. This is what
 *  makes the list "derived" rather than closed — see the synthetic-host test in
 *  tests/kit/guidance-targets.test.mjs.
 *  `cfg` is accepted for call-site symmetry/forward-compat; the target set is
 *  cfg-independent today. `codexRoot`/`opencodeRoot`/`hosts` are test seams
 *  (default to the real dirs / the real registry).
 *  @param {{ cwd?: string, cfg?: object, codexRoot?: string, opencodeRoot?: string, hosts?: Array<any> }} opts */
export function guidanceTargets({
  cwd = process.cwd(), codexRoot = codexDir(), opencodeRoot = opencodeDir(), hosts = HOST_REGISTRY,
} = {}) {
  const targets = [];
  for (const host of hosts) {
    if (!host?.capabilities?.nativeGuidance) continue;
    const name = host.legacy?.guidanceFile;
    if (!name) continue;
    switch (host.id) {
      case 'claude':
        targets.push({ name, label: 'CLAUDE.md', file: claudeMdPath() });
        break;
      case 'codex':
        targets.push({ name, label: 'AGENTS.md', file: path.join(cwd, 'AGENTS.md') });
        if (fs.existsSync(codexRoot)) {
          targets.push({ name: 'agents-user', label: '~/.codex/AGENTS.md', file: path.join(codexRoot, 'AGENTS.md') });
        }
        break;
      case 'opencode':
        if (fs.existsSync(opencodeRoot)) {
          targets.push({ name, label: 'opencode AGENTS.md', file: path.join(opencodeRoot, 'AGENTS.md') });
        }
        break;
      default:
        // Generic fallback so an unrecognized-but-nativeGuidance host still
        // joins the reconciliation loop instead of being silently unlooped.
        // Id-shaped names only: path.join normalizes '..' so a hostile
        // guidanceFile could escape cwd into a real write primitive
        // (reconcileGuidance → syncBlocks). A non-conforming name is skipped
        // entirely — excluded-and-safe beats sanitized-and-surprising.
        // Schema-level validation of legacy.guidanceFile is the wave-4
        // admission gate's job, deliberately not duplicated here.
        if (/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
          targets.push({ name, label: name, file: path.join(cwd, `${name}.md`) });
        }
        break;
    }
  }
  return targets;
}

/** Package-relative template resolution shared by setup and sync: custom rows
 *  are absolute or ~-expanded paths; built-ins resolve against the kit's own
 *  claude/ dir. */
export function templateResolver(pkgRoot) {
  return (r) => (r.custom
    ? (r.template.startsWith('~/') ? path.join(home, r.template.slice(2)) : r.template)
    : path.join(pkgRoot, 'claude', r.template));
}

/** Reconcile EVERY guidance target against the registry — the one loop
 *  `sync` (apply) and `setup`'s final pass both run, so the two commands can
 *  never drift. Per target: active rows upsert/strip per detector, and
 *  re-scoped rows are force-stripped (retiredForTarget). `context` carries the
 *  caller's flag signals for `flag` detectors (dualMode, opencodeEnabled).
 *  Returns [{name, label, changed}] where `changed` is a human-readable action
 *  summary ('' when the target was already in sync). */
export async function reconcileGuidance({ cwd, cfg, pkgRoot, context = {}, dryRun = false }) {
  const rows = registry(cfg.customBlocks);
  const resolve = templateResolver(pkgRoot);
  const selectionContext = guidanceContextFromConfig(cfg, context);
  const out = [];
  const targets = guidanceTargets({ cwd, cfg });
  const knownTargets = targets.map((t) => t.name);
  for (const t of targets) {
    const treg = [...blocksForTarget(rows, t.name), ...retiredForTarget(rows, t.name, knownTargets)];
    const res = await syncBlocks(t.file, treg, resolve, { context: selectionContext, dryRun });
    const changed = res.filter((r) => r.action !== 'unchanged' && r.action !== 'skipped')
      .map((r) => `${r.slug} ${r.action}`).join(', ');
    out.push({ name: t.name, label: t.label, changed });
  }
  return out;
}

/** Reconcile every registry row against its detector on a file.
 *  resolveTemplate(row) → absolute template path (built-ins resolve against the
 *  package's claude/ dir; custom rows are absolute or ~-expanded already).
 *  Returns [{slug, action: 'upserted'|'stripped'|'unchanged'|'missing-template', present}] —
 *  dryRun skips writes but reports the same actions. `context` is forwarded to
 *  every detector (see detect) so `flag`-gated rows can read caller signals such
 *  as `{ flags: { dualMode: <bool> } }`; omitting it preserves prior behavior.
 * @param {string} file
 * @param {Array<any>} rows
 * @param {(row: any) => string} resolveTemplate
 * @param {{dryRun?: boolean, context?: object, fileWriteOptions?: {fsImpl?: typeof fs}}} [options]
 */
export async function syncBlocks(file, rows, resolveTemplate, {
  dryRun = false, context = {}, fileWriteOptions,
} = {}) {
  const results = [];
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let changed = false;
  for (const row of rows) {
    const present = hasBlock(content, row.slug);
    const wanted = await detect(row.detector, context);
    if (wanted) {
      const tpl = resolveTemplate(row);
      if (!tpl || !fs.existsSync(tpl)) {
        results.push({ slug: row.slug, action: 'missing-template', present });
        continue;
      }
      const blockText = fs.readFileSync(tpl, 'utf8');
      const next = upsertBlock(content, row.slug, blockText, row.position);
      const action = next === content ? 'unchanged' : 'upserted';
      if (action === 'upserted') { content = next; changed = true; }
      results.push({ slug: row.slug, action, present: true });
    } else if (present) {
      content = stripBlock(content, row.slug);
      changed = true;
      results.push({ slug: row.slug, action: 'stripped', present: false });
    } else {
      results.push({ slug: row.slug, action: 'unchanged', present: false });
    }
  }
  if (changed && !dryRun) {
    writeFileWithBackup(file, content, fileWriteOptions);
  }
  return results;
}
