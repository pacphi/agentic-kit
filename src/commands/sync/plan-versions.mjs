// Plan-time version lookups for `ak sync` (ADR-0063, "The `record` parameter").
// A real sync forces the online lookups before it reads its plan, so a cache
// stamped before an upstream release cannot hide the upgrade; the plan read and
// the converge proof then read the cache those lookups just wrote. A dry run
// makes the same lookups and records nothing: the results reach the plan read
// through `versionEvidence`, and its `npm view` calls keep their cache in a
// temporary folder. A part that --skip names is not looked up at all: both
// reads get what kit.json recorded for it, with no network and no write. The
// parts are versions (managed npm packages and Ruflo's release dates), self
// (the kit's own package), ruvnet-brain (the Brain's GitHub release) and
// ruvector (a registered ruvector CLI).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../lib/exec.mjs';
import { describeAge } from '../../lib/evidence.mjs';
import { info } from '../../lib/output.mjs';
import { driftReport, selfDrift, cachedOnlyLatest, latestVersion } from '../../lib/versions.mjs';
import { recordRufloReleaseDates } from '../../lib/ruflo-support-window.mjs';
import { drift as ruvnetBrainDrift } from '../../lib/ruvnet-brain.mjs';
import { drift as ruvectorDrift, managed as ruvectorManaged } from '../../lib/ruvector.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';

const withFetch = (fetchLatest) => (fetchLatest ? { fetchLatest } : {});

/** Every part with a version lookup. */
const VERSION_PARTS = new Set(['versions', 'self', 'ruvnet-brain', 'ruvector']);

/** The Brain has a version lookup only while ak manages it. */
const brainManaged = () => !!loadKitConfig().ruvnetBrain;

/** Remember each Ruflo minor's first publish so `ak status` can compute the
 *  support window without a network call (ADR-0041 §7). A failed lookup keeps
 *  the old dates. */
async function refreshRufloReleaseDates(releaseDatesRunner) {
  const cfg = loadKitConfig();
  if (await recordRufloReleaseDates({ cfg, ...(releaseDatesRunner ? { runner: releaseDatesRunner } : {}) })) {
    try { saveKitConfig(cfg); } catch { /* read-only envs: the next sync records them */ }
  }
}

/**
 * Cache-only results (no network, no write) for the parts --skip names. Sync
 * recomputes them for the converge proof, so `installed` is read after the
 * apply phase.
 * @param {{ skip: Set<string>, pkgRoot?: string }} input
 * @returns {Promise<{ drift?: any[], self?: any, brain?: any, ruvector?: any }>}
 */
export async function skippedVersionEvidence({ skip, pkgRoot }) {
  const evidence = {};
  if (skip.has('versions')) evidence.drift = await driftReport({ fetchLatest: cachedOnlyLatest });
  if (skip.has('self')) evidence.self = await selfDrift({ pkgRoot, fetchLatest: cachedOnlyLatest });
  if (skip.has('ruvnet-brain') && brainManaged()) evidence.brain = await ruvnetBrainDrift({ cacheOnly: true });
  if (skip.has('ruvector') && ruvectorManaged()) evidence.ruvector = await ruvectorDrift({ cacheOnly: true });
  return evidence;
}

/**
 * Real sync: the forced lookups for every part --skip does not name (versions:
 * driftReport + Ruflo release dates; self: selfDrift; ruvnet-brain: brainDrift
 * while ak manages the Brain). Sequential, because each lookup saves kit.json.
 * --no-upgrade makes no forced lookup, and --dry-run previews them instead
 * (previewPlanVersions). Returns versionEvidence for the skipped parts only;
 * with nothing skipped it is empty and the sections read the cache the forced
 * lookups just wrote.
 * @param {{ flags: Record<string, any>, skip?: Set<string>, pkgRoot?: string,
 *   fetchLatest?: (pkg: string, tag?: string) => Promise<string | null>,
 *   releaseDatesRunner?: Function, brainDrift?: typeof ruvnetBrainDrift }} input
 * @returns {Promise<{ versionEvidence: { drift?: any[], self?: any, brain?: any, ruvector?: any, cfg?: any } }>}
 */
export async function refreshPlanVersions({
  flags, skip = new Set(), pkgRoot, fetchLatest, releaseDatesRunner, brainDrift = ruvnetBrainDrift,
}) {
  const versionEvidence = await skippedVersionEvidence({ skip, pkgRoot });
  if (flags['dry-run'] || flags['no-upgrade']) return { versionEvidence };
  if (!skip.has('versions')) {
    await driftReport({ force: true, ...withFetch(fetchLatest) });
    await refreshRufloReleaseDates(releaseDatesRunner);
  }
  // Self-update has its own TTL cache; refresh it before the plan decides
  // whether a self action exists. An apply-time refresh cannot open that gate.
  if (!skip.has('self')) await selfDrift({ pkgRoot, force: true, ...withFetch(fetchLatest) });
  // Brain releases have a second executability fact beyond the tag: the
  // required ruvnet-brain.zip asset. A tag-only release is not actionable.
  if (!skip.has('ruvnet-brain') && brainManaged()) await brainDrift({ force: true });
  return { versionEvidence };
}

/** An npm runner whose cache lives in `dir`, so a lookup writes nothing under
 *  ~/.npm; the user's .npmrc registry and proxy still apply. */
const npmCachedIn = (dir) => (cmd, args, opts = {}) => run(cmd, args, {
  ...opts,
  env: { ...opts.env, npm_config_cache: dir, npm_config_logs_max: '0', npm_config_update_notifier: 'false' },
});

/**
 * `ak sync --dry-run`: the lookups a real sync makes before it plans, in the
 * same order, recording nothing (`record: false`; Ruflo's release dates land
 * in a copy of kit.json). ruvector is read the way a real sync's plan read
 * does: looked up once its cache has expired. Every `npm view` keeps its cache
 * in a folder under `tmpRoot`, removed once the lookups are done. With
 * --no-upgrade a real sync makes no lookup, so every part is read from the
 * cache. `online` is true when a lookup answered, false when every lookup
 * made failed, and null when none was made.
 * @param {{ flags?: Record<string, any>, skip?: Set<string>, pkgRoot?: string,
 *   fetchLatest?: (pkg: string, tag?: string) => Promise<string | null>,
 *   releaseDatesRunner?: typeof run, brainDrift?: typeof ruvnetBrainDrift, tmpRoot?: string }} input
 * @returns {Promise<{ versionEvidence: { drift?: any[], self?: any, brain?: any, ruvector?: any, cfg?: any },
 *   online: boolean | null }>}
 */
export async function previewPlanVersions({
  flags = {}, skip = new Set(), pkgRoot, fetchLatest, releaseDatesRunner, brainDrift = ruvnetBrainDrift,
  tmpRoot = os.tmpdir(),
}) {
  if (flags['no-upgrade']) {
    return { versionEvidence: await skippedVersionEvidence({ skip: VERSION_PARTS, pkgRoot }), online: null };
  }
  /** @type {{ drift?: any[], self?: any, brain?: any, ruvector?: any, cfg?: any }} */
  const versionEvidence = await skippedVersionEvidence({ skip, pkgRoot });
  const tally = { asked: 0, answered: 0 };
  const count = (answered) => { tally.asked += 1; if (answered) tally.answered += 1; };
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'ak-sync-preview-npm-'));
  const npm = npmCachedIn(dir);
  const fetchOne = fetchLatest ?? ((pkg, tag) => latestVersion(pkg, tag, { runner: npm }));
  const lookUp = async (pkg, tag) => { const version = await fetchOne(pkg, tag); count(!!version); return version; };
  try {
    if (!skip.has('versions')) {
      versionEvidence.drift = await driftReport({ force: true, record: false, fetchLatest: lookUp });
      const cfg = structuredClone(loadKitConfig());
      count(await recordRufloReleaseDates({ cfg, runner: releaseDatesRunner ?? npm }));
      versionEvidence.cfg = cfg;
    }
    if (!skip.has('self')) versionEvidence.self = await selfDrift({ pkgRoot, force: true, record: false, fetchLatest: lookUp });
    if (!skip.has('ruvnet-brain') && brainManaged()) {
      versionEvidence.brain = await brainDrift({ force: true, record: false });
      count(versionEvidence.brain?.latestSource === 'live');
    }
    if (!skip.has('ruvector') && ruvectorManaged()) {
      versionEvidence.ruvector = await ruvectorDrift({ record: false, fetchLatest: lookUp });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  return { versionEvidence, online: tally.asked ? tally.answered > 0 : null };
}

/** The line a dry run prints when every lookup it made failed. */
function notCheckedOnlineNote(cfg = loadKitConfig(), now = Date.now()) {
  const last = cfg.versionCheck?.last;
  const plan = Number.isFinite(last) && last > 0
    ? `this plan uses the versions ak recorded ${describeAge(now - last)}`
    : 'ak has recorded none, so this plan shows no version upgrades';
  return `versions not checked online (offline or timed out); ${plan}`;
}

/**
 * The lookups `ak sync` makes before it plans: previewed under --dry-run,
 * forced otherwise. A dry run whose every lookup failed says so in one line.
 * @param {Parameters<typeof previewPlanVersions>[0] & { flags: Record<string, any> }} input
 * @returns {Promise<{ versionEvidence: { drift?: any[], self?: any, brain?: any, ruvector?: any, cfg?: any } }>}
 */
export async function lookUpPlanVersions(input) {
  if (!input.flags['dry-run']) return refreshPlanVersions(input);
  const preview = await previewPlanVersions(input);
  if (preview.online === false) info(notCheckedOnlineNote());
  return preview;
}
