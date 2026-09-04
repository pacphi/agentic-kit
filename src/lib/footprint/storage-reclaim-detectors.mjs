// Reclaimable-candidate DETECTORS — one function per third-party accumulation
// pattern: superseded dated snapshot copies, whole regenerable cache roots,
// superseded browser installer revisions, installed runtime-manager versions,
// transcripts for projects that no longer exist, and orphaned/idle git
// worktrees. Split out of storage.mjs (2026-08 complexity program, ADR-0037)
// purely by natural seam — each detector already took a shared `ctx` and
// returned `ReclaimableCandidate[]`, so nothing here changes shape or
// behavior. `collectReclaimables` in storage-reclaim.mjs is the orchestrator
// that calls every export below and owns the safety/advisory-only contract
// documented in storage.mjs's header; read that file first.
//
// Third-party cache conventions are spelled out here rather than in paths.mjs
// for the reason consumers.mjs states: that module owns the kit's own path
// contract, and fifty foreign tools' cache layouts would make it harder to
// audit. Platform variants are listed side by side instead of switched on
// process.platform, so the wrong-platform root simply reads absent and a machine
// carrying both (a tool that moved its cache) reports both.
import path from 'node:path';
import { home, isWindows } from '../paths.mjs';
import { decodeClaudeProjectDir } from './project-sources.mjs';
import {
  rootMeasurements, measured, unknown, statNode, sumMeasurements, hasValue,
} from './walk.mjs';
import { candidate } from './storage-reclaim.mjs';

const xdgCache = (env) => env.XDG_CACHE_HOME || path.join(home, '.cache');
const xdgData = (env) => env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const macCache = () => path.join(home, 'Library', 'Caches');
const winLocalAppData = (env) => env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

// ── shared detector plumbing ──────────────────────────────────────────────────

/** One node's figures: the already-measured answer when the consumers view has
 *  one for this exact path, otherwise one bounded walk. */
function measureNode(target, ctx) {
  const adopted = ctx.adopt?.(target);
  if (adopted) return adopted;
  const result = ctx.walk(target, { ...ctx.limits, fsImpl: ctx.fsImpl });
  return {
    ...rootMeasurements(result, { asOf: ctx.asOf }),
    newestMtimeMs: result.newestMtimeMs ?? null,
  };
}

/** Immediate entries of a directory. ENOENT is an ABSENCE — that tool is not
 *  installed here, which is not a failed measurement — and every other errno is
 *  a degradation the caller must report rather than swallow. Symlinked entries
 *  are classified but never followed or measured. */
function listMembers(dir, fsImpl) {
  try {
    return { status: 'ok', reason: null, entries: fsImpl.readdirSync(dir, { withFileTypes: true }) };
  } catch (err) {
    const code = err?.code || 'io';
    return { status: code === 'ENOENT' ? 'absent' : 'degraded', reason: code, entries: [] };
  }
}

/** A root that exists but could not be listed. Reported rather than dropped:
 *  "there is nothing to reclaim here" and "we could not look" are different
 *  answers, and only one of them is a measurement (invariant 2). */
function unreadableCandidate({ id, kind, label, target, reason, safety, cleanupHint = null }) {
  return candidate({
    id: `${id}:unreadable`,
    kind,
    label: `${label} (unreadable)`,
    path: target,
    bytes: unknown(reason),
    files: unknown(reason),
    safety,
    rationale: `${target} could not be listed (${reason}), so whether anything here is `
      + 'reclaimable is unknown rather than none.',
    cleanupHint,
  });
}

/** Walk a family's members under a walk budget. A cap makes the sum a floor and
 *  says so through `partial`, which is what "≥ N" renders from; a budget already
 *  spent before this family was reached yields unknown, because zero members
 *  measured is not a measurement of zero bytes. */
function measureMembers(members, ctx, limit = ctx.opts.maxFamilyWalks) {
  const walked = members.slice(0, Math.max(0, limit))
    .map((member) => ({ ...member, ...measureNode(member.path, ctx) }));
  const capped = members.length > walked.length;
  if (members.length && !walked.length) {
    const reason = 'the walk budget for this root was spent before this node was reached';
    return { walked, capped, bytes: unknown(reason), files: unknown(reason) };
  }
  const bytes = sumMeasurements(walked.map((m) => m.bytes), { asOf: ctx.asOf });
  const files = sumMeasurements(walked.map((m) => m.files), { asOf: ctx.asOf });
  return {
    walked,
    capped,
    bytes: capped && hasValue(bytes) ? { ...bytes, partial: true } : bytes,
    files: capped && hasValue(files) ? { ...files, partial: true } : files,
  };
}

/** Is there anything to advise about? A measured zero is a real zero, and a real
 *  zero is not a candidate — an "0 B reclaimable" row is an unknown wearing a
 *  number. An unmeasured figure still earns its row, because not knowing is
 *  itself the finding. */
const worthListing = (bytes) => !hasValue(bytes) || bytes.value > 0;

// ── superseded snapshot copies ────────────────────────────────────────────────

/**
 * Families of dated copies an installer leaves beside the copy in use. The
 * RuvNet Brain is the one on this machine and the largest safe win on it: five
 * `kb.bak-<date>` directories totalling ~11 GB beside a 1.9 GB active `kb/`.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function snapshotFamilies({ env = process.env } = {}) {
  const brain = path.join(xdgCache(env), 'ruvnet-brain');
  return [{
    id: 'brain-kb-snapshots',
    label: 'RuvNet Brain superseded KB copies',
    dir: brain,
    // `kb.bak` cannot match `kb`, so the active KB can never be enumerated as
    // one of its own backups.
    prefix: 'kb.bak',
    active: path.join(brain, 'kb'),
    activeLabel: 'active KB (kb/)',
    what: 'The brain installer copies the knowledge base aside before each update and never '
      + 'removes the copy, so one accumulates per update.',
    reproducible: 'A knowledge base is rebuilt by re-running the installer '
      + '(npx ruvnet-brain --doctor).',
    cleanupHint: 'remove the dated kb.bak-* directories (npx ruvnet-brain --doctor rebuilds)',
  }];
}

/** The `YYYY-MM-DD` a dated copy names, when it names one. Used only for the
 *  rationale's range; a member whose name carries no date is still counted. */
const datePart = (name) => name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

/**
 * Dated, superseded copies beside an active one — the single largest safe win
 * measured on this machine. The active copy is measured too and reported in
 * `keeps`, never inside the candidate figure: the row's whole credibility is
 * that it can say what it is NOT proposing to touch.
 */
export function supersededSnapshotReclaimables(ctx, families) {
  const rows = [];
  for (const family of families ?? []) {
    const listing = listMembers(family.dir, ctx.fsImpl);
    if (listing.status === 'absent') continue;
    if (listing.status === 'degraded') {
      rows.push(unreadableCandidate({
        id: family.id, kind: 'superseded-snapshots', label: family.label,
        target: family.dir, reason: listing.reason, safety: 'regenerable',
        cleanupHint: family.cleanupHint,
      }));
      continue;
    }
    const members = listing.entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && entry.name.startsWith(family.prefix))
      .map((entry) => ({ name: entry.name, path: path.join(family.dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!members.length) continue;

    const { walked, capped, bytes, files } = measureMembers(members, ctx);
    if (!worthListing(bytes)) continue;
    const dates = members.map((m) => datePart(m.name)).filter(Boolean);
    const span = dates.length >= 2 ? ` (${dates[0]} through ${dates[dates.length - 1]})`
      : (dates.length === 1 ? ` (${dates[0]})` : '');
    const active = measureNode(family.active, ctx);
    rows.push(candidate({
      id: family.id,
      kind: 'superseded-snapshots',
      label: `${members.length} superseded copies of ${path.basename(family.active)}`,
      path: family.dir,
      samplePaths: walked.slice(0, ctx.opts.samplePaths).map((m) => m.path),
      matchedCount: members.length,
      bytes,
      files,
      safety: 'regenerable',
      keeps: [{
        path: family.active,
        label: family.activeLabel,
        bytes: active.presence === 'absent'
          ? unknown('the active copy is not on disk')
          : active.bytes,
      }],
      rationale: `${members.length} dated copies${span}${capped ? ', of which only '
        + `${walked.length} were measured` : ''}. ${family.what} Nothing reads them: `
        + `the ${family.activeLabel} is measured separately, is excluded from this figure, and `
        + `is not a candidate. ${family.reproducible}`,
      cleanupHint: family.cleanupHint,
    }));
  }
  return rows;
}

// ── regenerable caches ────────────────────────────────────────────────────────

/**
 * Whole cache roots whose owner refetches them on demand. These are the biggest
 * genuinely-safe rows on a developer machine — the npm content-addressable cache
 * alone measures ~22 GB here — and they are invisible in the per-host storage
 * tree because they belong to no host.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function regenerableCacheRoots({ env = process.env } = {}) {
  const cache = xdgCache(env);
  const roots = [
    {
      id: 'npm-cacache',
      kind: 'regenerable-cache',
      label: 'npm content-addressable cache',
      path: path.join(home, '.npm', '_cacache'),
      what: 'Every package tarball and registry response npm has downloaded, keyed by content '
        + 'hash. It grows monotonically: npm adds to it and never prunes it.',
      cleanupHint: 'npm cache clean --force',
    },
    {
      id: 'homebrew-downloads',
      kind: 'regenerable-cache',
      label: 'Homebrew download cache',
      path: path.join(macCache(), 'Homebrew'),
      what: 'Bottles, source tarballs and the formula API responses brew downloaded, kept after '
        + 'the install they were for.',
      cleanupHint: 'brew cleanup',
    },
    {
      id: 'homebrew-downloads-xdg',
      kind: 'regenerable-cache',
      label: 'Homebrew download cache',
      path: path.join(cache, 'Homebrew'),
      what: 'Bottles, source tarballs and the formula API responses brew downloaded, kept after '
        + 'the install they were for.',
      cleanupHint: 'brew cleanup',
    },
  ];
  if (isWindows) {
    roots.push({
      id: 'npm-cacache-win',
      kind: 'regenerable-cache',
      label: 'npm content-addressable cache',
      path: path.join(winLocalAppData(env), 'npm-cache', '_cacache'),
      what: 'Every package tarball and registry response npm has downloaded, keyed by content '
        + 'hash. It grows monotonically: npm adds to it and never prunes it.',
      cleanupHint: 'npm cache clean --force',
    });
  }
  return roots;
}

/** One row per present cache root. An absent root produces nothing at all —
 *  a tool that is not installed is not a reclaimable zero. */
export function regenerableCacheReclaimables(ctx, roots) {
  const rows = [];
  for (const root of roots ?? []) {
    const node = measureNode(root.path, ctx);
    if (node.presence === 'absent') continue;
    if (!worthListing(node.bytes)) continue;
    rows.push(candidate({
      id: root.id,
      kind: root.kind,
      label: root.label,
      path: root.path,
      bytes: node.bytes,
      files: node.files,
      safety: 'regenerable',
      rationale: `${root.what} Nothing here is unique: the tool refetches what it needs on the `
        + 'next install, so the cost of clearing it is download time, not data.',
      cleanupHint: root.cleanupHint,
    }));
  }
  return rows;
}

// ── superseded browser downloads ──────────────────────────────────────────────

/**
 * Roots where a browser installer keeps one directory per revision and adds a
 * new one on every version bump, never removing the old. `depth` is where the
 * revision directories live: Playwright keeps them at the root
 * (`chromium-1223`), Puppeteer one level down (`chrome/mac_arm-149.0.7827.22`).
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function browserRevisionRoots({ env = process.env } = {}) {
  const cache = xdgCache(env);
  const playwright = {
    kind: 'superseded-browser-revisions',
    label: 'Playwright browser builds',
    depth: 1,
    installer: 'npx playwright install',
  };
  const roots = [
    { ...playwright, id: 'playwright-mac', path: path.join(macCache(), 'ms-playwright') },
    { ...playwright, id: 'playwright-xdg', path: path.join(cache, 'ms-playwright') },
    { ...playwright, id: 'playwright-win', path: path.join(winLocalAppData(env), 'ms-playwright') },
    {
      kind: 'superseded-browser-revisions',
      id: 'puppeteer',
      label: 'Puppeteer browser builds',
      path: path.join(cache, 'puppeteer'),
      depth: 2,
      installer: 'npx puppeteer browsers install',
    },
    {
      kind: 'superseded-browser-revisions',
      id: 'agent-browser',
      label: 'agent-browser Chrome builds',
      path: path.join(home, '.agent-browser', 'browsers'),
      depth: 1,
      installer: 'agent-browser install',
    },
    {
      kind: 'superseded-browser-revisions',
      id: 'vibium-mac',
      label: 'Vibium Chrome builds',
      path: path.join(macCache(), 'vibium', 'chrome-for-testing'),
      depth: 1,
      revisionShape: 'bare-version',
      installer: 'vibium install',
    },
    {
      kind: 'superseded-browser-revisions',
      id: 'vibium-xdg',
      label: 'Vibium Chrome builds',
      path: path.join(cache, 'vibium', 'chrome-for-testing'),
      depth: 1,
      revisionShape: 'bare-version',
      installer: 'vibium install',
    },
    {
      kind: 'superseded-browser-revisions',
      id: 'vibium-win',
      label: 'Vibium Chrome builds',
      path: path.join(winLocalAppData(env), 'vibium', 'chrome-for-testing'),
      depth: 1,
      revisionShape: 'bare-version',
      installer: 'vibium install',
    },
  ];
  if (env.VIBIUM_CACHE_DIR) {
    const override = path.join(env.VIBIUM_CACHE_DIR, 'chrome-for-testing');
    if (!roots.some((root) => root.path === override)) {
      roots.push({
        kind: 'superseded-browser-revisions',
        id: 'vibium-override',
        label: 'Vibium Chrome builds',
        path: override,
        depth: 1,
        revisionShape: 'bare-version',
        installer: 'vibium install',
      });
    }
  }
  return roots;
}

/** Split `chromium_headless_shell-1223` into its family and its revision. The
 *  revision must contain a digit, which is what keeps Playwright's
 *  `mcp-chrome-profile` — a browser PROFILE, not a revision — out of the
 *  families entirely. */
function splitRevision(name) {
  const cut = name.lastIndexOf('-');
  if (cut <= 0 || cut === name.length - 1) return null;
  const revision = name.slice(cut + 1);
  if (!/\d/.test(revision)) return null;
  return { family: name.slice(0, cut), revision };
}

/** Revision directories under a root, at the root itself (`depth` 1) or one
 *  level down (`depth` 2). Never recursive: a browser build's own contents are
 *  not revisions. */
function revisionMembers(root, ctx) {
  const listing = listMembers(root.path, ctx.fsImpl);
  if (listing.status !== 'ok') return { status: listing.status, reason: listing.reason, members: [] };
  const holders = root.depth === 2
    ? listing.entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ dir: path.join(root.path, entry.name), scope: entry.name }))
    : [{ dir: root.path, scope: '' }];
  const members = [];
  for (const holder of holders) {
    const inner = root.depth === 2 ? listMembers(holder.dir, ctx.fsImpl) : listing;
    if (inner.status !== 'ok') continue;
    for (const entry of inner.entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const split = root.revisionShape === 'bare-version'
        ? (/^\d+(?:\.\d+)+/.test(entry.name)
          ? { family: 'chrome-for-testing', revision: entry.name } : null)
        : splitRevision(entry.name);
      if (!split) continue;
      const target = path.join(holder.dir, entry.name);
      members.push({
        name: entry.name,
        path: target,
        family: holder.scope ? `${holder.scope}/${split.family}` : split.family,
        revision: split.revision,
        mtimeMs: statNode(target, { fsImpl: ctx.fsImpl }).mtimeMs ?? 0,
      });
    }
  }
  return { status: 'ok', reason: null, members };
}

/**
 * Older revisions in each browser family — everything except the most recently
 * installed one. Ordering is by directory mtime rather than by parsing the
 * revision, because the revisions are not comparable across installers
 * (Playwright's `1223` is a counter, its `mcp-chrome-5b42311` is a hex build id,
 * Puppeteer's is a four-part Chrome version).
 *
 * REVIEW tier, not regenerable, even though the installer would refetch them: a
 * project's pinned playwright/puppeteer version resolves to a specific revision,
 * and this module cannot see which package pins what. The row's job is to say
 * "these accumulated, look at them", not "delete N GB".
 */
export function browserRevisionReclaimables(ctx, roots) {
  const rows = [];
  for (const root of roots ?? []) {
    const { status, reason, members } = revisionMembers(root, ctx);
    if (status === 'absent') continue;
    if (status === 'degraded') {
      rows.push(unreadableCandidate({
        id: root.id, kind: root.kind, label: root.label,
        target: root.path, reason, safety: 'review',
      }));
      continue;
    }
    const families = new Map();
    for (const member of members) {
      const list = families.get(member.family) ?? [];
      list.push(member);
      families.set(member.family, list);
    }
    const superseded = [];
    const keeps = [];
    for (const [family, list] of families) {
      if (list.length < 2) continue;
      const ordered = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
      keeps.push({ family, ...ordered[0] });
      superseded.push(...ordered.slice(1));
    }
    if (!superseded.length) continue;
    const { walked, capped, bytes, files } = measureMembers(superseded, ctx);
    if (!worthListing(bytes)) continue;
    rows.push(candidate({
      id: `${root.id}:superseded`,
      kind: root.kind,
      label: `${superseded.length} superseded ${root.label.toLowerCase()}`,
      path: root.path,
      samplePaths: walked.slice(0, ctx.opts.samplePaths).map((m) => m.path),
      matchedCount: superseded.length,
      bytes,
      files,
      safety: 'review',
      keeps: keeps.map((keep) => ({
        path: keep.path,
        label: `newest ${keep.family} revision (${keep.revision})`,
        bytes: unknown('the retained revision is not part of this figure'),
      })),
      rationale: `${keeps.length} browser famil(ies) here carry more than one revision; this `
        + `figure covers the ${superseded.length} older one(s)${capped
          ? `, of which ${walked.length} were measured` : ''}, and excludes the newest of each. `
        + 'Review rather than sweep: an installed package can pin an older revision, and this '
        + 'row cannot see which package pins what. '
        + `${root.installer} refetches whatever is missing.`,
      cleanupHint: `${root.installer} (confirm no project pins the older revision first)`,
    }));
  }
  return rows;
}

// ── installed runtime versions ────────────────────────────────────────────────

/**
 * Version-manager install roots — one directory per installed runtime version,
 * plus alias entries pointing into them.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function runtimeVersionRoots({ env = process.env } = {}) {
  return [{
    id: 'mise-installs',
    kind: 'installed-runtime-versions',
    label: 'mise',
    path: path.join(xdgData(env), 'mise', 'installs'),
    manager: 'mise',
    cleanupHint: 'mise ls, then mise uninstall <tool>@<version> (nothing may pin it)',
  }];
}

/**
 * Installed runtime versions, one row per managed tool that has more than one.
 *
 * REVIEW tier and `bytesMeaning: 'installed'`, both deliberately. On this
 * machine `mise/installs/node` holds eight entries — 22, 22.22, 22.22.3, 26,
 * 26.4, 26.4.0, latest, lts-jod — of which only two are real directories and six
 * are ALIAS SYMLINKS resolving into them. Removing a version silently breaks
 * every alias that points at it, and any `mise.toml` or `.tool-versions` on the
 * machine can pin any of them, so there is no subset this module can honestly
 * call reclaimable. What it can do is show what is installed and say that out
 * loud; recommending the deletion of a live runtime would be worse than saying
 * nothing.
 *
 * The alias links are counted, never followed — the walker's rule, and also the
 * only reason the byte figure is not multiplied by every alias.
 */
export function runtimeVersionReclaimables(ctx, roots) {
  const rows = [];
  for (const root of roots ?? []) {
    const listing = listMembers(root.path, ctx.fsImpl);
    if (listing.status === 'absent') continue;
    if (listing.status === 'degraded') {
      rows.push(unreadableCandidate({
        id: root.id, kind: root.kind, label: `${root.manager} installs`,
        target: root.path, reason: listing.reason, safety: 'review',
      }));
      continue;
    }
    // Every managed tool is examined — listing one is a readdir, and capping the
    // LIST would drop tools in alphabetical order, which is an invisible
    // truncation of exactly the kind this domain forbids. What is bounded is the
    // expensive part: the walks, under one budget shared across the root.
    let budget = ctx.opts.maxFamilyWalks;
    const tools = listing.entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && !entry.name.startsWith('.'));
    for (const tool of tools) {
      const dir = path.join(root.path, tool.name);
      const inner = listMembers(dir, ctx.fsImpl);
      if (inner.status !== 'ok') continue;
      const versions = [];
      let aliases = 0;
      for (const entry of inner.entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) { aliases += 1; continue; }
        if (entry.isDirectory()) versions.push({ name: entry.name, path: path.join(dir, entry.name) });
      }
      // One installed version is the toolchain working as intended, not sprawl.
      if (versions.length < 2) continue;
      const { walked, capped, bytes, files } = measureMembers(versions, ctx, budget);
      budget -= walked.length;
      if (!worthListing(bytes)) continue;
      rows.push(candidate({
        id: `${root.id}:${tool.name}`,
        kind: root.kind,
        label: `${versions.length} ${root.manager} ${tool.name} versions installed`,
        path: dir,
        samplePaths: walked.slice(0, ctx.opts.samplePaths).map((m) => m.path),
        matchedCount: versions.length,
        bytes,
        files,
        safety: 'review',
        bytesMeaning: 'installed',
        rationale: `${versions.length} installed version(s) of ${tool.name}`
          + `${aliases ? ` plus ${aliases} alias link(s) resolving into them` : ''}`
          + `${capped ? `, of which ${walked.length} were measured` : ''}. `
          + 'This is what is installed, not what is free: an alias points at a real version, '
          + `and any ${root.manager} config on this machine can pin any of them. Review with `
          + `\`${root.manager} ls ${tool.name}\` before removing anything.`,
        cleanupHint: root.cleanupHint,
      }));
    }
  }
  return rows;
}

// ── transcripts for projects that no longer exist ─────────────────────────────

/**
 * Claude transcript directories whose project directory is gone.
 *
 * A `~/.claude/projects/` directory name is a LOSSY encoding of the project path
 * (`/`, `.` and a literal `-` all become `-`), so it cannot be decoded by string
 * manipulation; `decodeClaudeProjectDir` walks the candidate segments against the
 * real filesystem and returns a path only when the filesystem confirms one.
 * A directory that decodes to nothing is therefore a project that is no longer
 * on this machine — and that is exactly the evidence available, so the row says
 * so rather than claiming certainty.
 *
 * TWO GUARDS against the failure mode that would matter, flagging live projects:
 *   · only `-`-leading (POSIX-encoded) names are considered, because Windows
 *     names encode a drive letter that this decoder does not handle and would
 *     otherwise report every project on the machine as dead;
 *   · if NOTHING decoded, the finding is about the decoder or an unreadable home
 *     directory, not about the projects, so no row is emitted at all.
 *
 * The value here is hygiene and privacy, not space: measured on this machine
 * these are ~0.05 GB across 8 dead projects. The rationale says that plainly —
 * selling 50 MB as a disk win would be the same dishonesty as a fabricated zero,
 * just in the other direction.
 */
export function orphanedTranscriptReclaimables({
  asOf, opts, transcriptProjects, decodeDir = decodeClaudeProjectDir, fsImpl,
}) {
  const byHost = new Map();
  for (const entry of transcriptProjects?.values?.() ?? []) {
    if (!entry.dir.startsWith('-')) continue;
    const acc = byHost.get(entry.host)
      ?? { host: entry.host, root: entry.rootPath, alive: 0, dead: [] };
    if (decodeDir(entry.dir, { fsImpl })) acc.alive += 1;
    else acc.dead.push(entry);
    byHost.set(entry.host, acc);
  }

  const rows = [];
  for (const acc of byHost.values()) {
    if (!acc.dead.length || !acc.alive) continue;
    const bytes = acc.dead.reduce((total, entry) => total + entry.bytes, 0);
    const files = acc.dead.reduce((total, entry) => total + entry.files, 0);
    const newest = acc.dead.reduce((at, entry) => Math.max(at, entry.newestMtimeMs ?? 0), 0);
    rows.push(candidate({
      id: `orphaned-transcripts:${acc.host}`,
      kind: 'orphaned-transcripts',
      label: `${acc.host} transcripts for ${acc.dead.length} project(s) that no longer exist`,
      path: acc.root,
      samplePaths: acc.dead.slice(0, opts.samplePaths).map((entry) => entry.path),
      matchedCount: acc.dead.length,
      bytes: measured(bytes, { asOf }),
      files: measured(files, { asOf }),
      safety: 'review',
      rationale: `${files} transcript(s) belong to ${acc.dead.length} project director(ies) that `
        + `no longer resolve on this machine (${acc.alive} others still do; last activity `
        + `${newest ? `${Math.floor((asOf - newest) / 86_400_000)}d ago` : 'unknown'}). This row `
        + 'is here for hygiene and privacy, not as a space win: it is listed because those '
        + 'projects are gone, whatever the byte figure turns out to be. The transcripts are also '
        + 'the only copy of that history, and an unreadable parent directory looks identical to '
        + 'a deleted project — confirm the project is really gone before acting.',
      cleanupHint: null,
    }));
  }
  return rows;
}

/** Orphaned git worktrees, from each project's `.git/worktrees/<name>` admin
 *  records. Two honest verdicts, no git invocation:
 *    · the checkout the record points at no longer exists → the record is dead;
 *    · the checkout exists but nothing in it has been touched for the idle
 *      window → a candidate, with its real on-disk size.
 *  A record whose pointer cannot be read is reported as unverifiable rather
 *  than assumed dead. See storage.mjs's header for why the pointer read is in
 *  scope (the one deliberate content-read exception, bounded to 4 KB). */
function reusableProjectFootprints(rows, asOf) {
  const index = new Map();
  const keyOf = (target) => {
    const resolved = path.resolve(target);
    return process.platform === 'linux' ? resolved : resolved.toLowerCase();
  };
  for (const row of rows ?? []) {
    const facts = [row?.totalBytes, row?.totalFiles, row?.footprintMtime];
    if (!row?.path || row.complete === false
        || facts.some((fact) => !hasValue(fact) || fact.partial === true || fact.asOf !== asOf)) continue;
    index.set(keyOf(row.path), {
      bytes: row.totalBytes,
      files: row.totalFiles,
      newestMtimeMs: row.footprintMtime.value,
    });
  }
  return (target) => index.get(keyOf(target)) ?? null;
}

export function worktreeReclaimables({
  asOf, projects, opts, walk, limits, fsImpl, projectFootprints = null,
}) {
  const rows = [];
  let walks = 0;
  const projectObservation = reusableProjectFootprints(projectFootprints, asOf);
  for (const project of projects) {
    const adminRoot = path.join(project, '.git', 'worktrees');
    let entries;
    try {
      entries = fsImpl.readdirSync(adminRoot, { withFileTypes: true });
    } catch { continue; } // no worktrees here (or unreadable): nothing to claim
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = path.join(adminRoot, entry.name);
      const pointer = readGitdirPointer(path.join(record, 'gitdir'), fsImpl);
      if (!pointer) {
        rows.push(candidate({
          id: `orphaned-worktree:${record}`,
          kind: 'orphaned-worktree',
          label: `worktree record "${entry.name}" (unverifiable)`,
          path: record,
          bytes: unknown('worktree pointer unreadable'),
          files: unknown('worktree pointer unreadable'),
          safety: 'review',
          rationale: 'The admin record exists but its gitdir pointer could not be read, '
            + 'so whether the checkout still exists is unknown.',
          cleanupHint: 'git worktree prune (verify first)',
        }));
        continue;
      }
      // gitdir points at `<checkout>/.git`; the checkout is its parent.
      const checkout = path.dirname(pointer);
      const head = statNode(checkout, { fsImpl });
      if (head.status === 'unknown') {
        rows.push(candidate({
          id: `orphaned-worktree:${record}`,
          kind: 'orphaned-worktree',
          label: `orphaned worktree record "${entry.name}"`,
          path: record,
          samplePaths: [checkout],
          bytes: measured(0, { asOf }),
          files: measured(0, { asOf }),
          safety: 'review',
          rationale: `The checkout at ${checkout} no longer exists; only the administrative `
            + 'record remains.',
          cleanupHint: 'git worktree prune',
        }));
        continue;
      }
      const observed = projectObservation(checkout);
      if (!observed && walks >= opts.maxWorktreeWalks) continue;
      if (!observed) walks += 1;
      const result = observed ? null : walk(checkout, { ...limits, fsImpl });
      const { bytes, files, newestMtimeMs } = observed ?? {
        ...rootMeasurements(result, { asOf }),
        newestMtimeMs: result.newestMtimeMs,
      };
      const idleMs = newestMtimeMs === null ? null : asOf - newestMtimeMs;
      if (idleMs === null || idleMs < opts.worktreeIdleDays * 86_400_000) continue;
      rows.push(candidate({
        id: `idle-worktree:${record}`,
        kind: 'orphaned-worktree',
        label: `idle worktree "${entry.name}"`,
        path: checkout,
        samplePaths: [record],
        bytes,
        files,
        safety: 'review',
        rationale: `Nothing in the checkout has changed for ${Math.floor(idleMs / 86_400_000)}d. `
          + 'Merge state is not checked here — confirm the branch is landed before removing.',
        cleanupHint: 'git worktree remove (verify the branch is merged first)',
      }));
    }
  }
  return rows;
}

/** The single narrow non-metadata read in this module: a `gitdir` file holds
 *  one absolute path and nothing else. Bounded to 4 KB and validated as a path
 *  so a corrupt file yields null rather than a bogus candidate. */
function readGitdirPointer(file, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const read = fsImpl.readSync(fd, buf, 0, 4096, 0);
    const value = buf.toString('utf8', 0, read).trim();
    return value && path.isAbsolute(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* already gone */ }
    }
  }
}
