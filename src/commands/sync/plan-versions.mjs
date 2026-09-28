// Plan-time version lookups for `ak sync` (ADR-0063, "The `record` parameter").
// A real sync forces the online lookups before it reads its plan, so a cache
// stamped before an upstream release cannot hide the upgrade; the plan read and
// the converge proof then read the cache those lookups just wrote. A part that
// --skip names is not looked up at all: both reads get what kit.json recorded
// for it, through `versionEvidence`, with no network and no write. The parts
// are versions (managed npm packages and Ruflo's release dates), self (the
// kit's own package) and ruvnet-brain (the Brain's GitHub release).
import { driftReport, selfDrift, cachedOnlyLatest } from '../../lib/versions.mjs';
import { recordRufloReleaseDates } from '../../lib/ruflo-support-window.mjs';
import { drift as ruvnetBrainDrift } from '../../lib/ruvnet-brain.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';

const withFetch = (fetchLatest) => (fetchLatest ? { fetchLatest } : {});

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
 * @returns {Promise<{ drift?: any[], self?: any, brain?: any }>}
 */
export async function skippedVersionEvidence({ skip, pkgRoot }) {
  const evidence = {};
  if (skip.has('versions')) evidence.drift = await driftReport({ fetchLatest: cachedOnlyLatest });
  if (skip.has('self')) evidence.self = await selfDrift({ pkgRoot, fetchLatest: cachedOnlyLatest });
  if (skip.has('ruvnet-brain') && brainManaged()) evidence.brain = await ruvnetBrainDrift({ cacheOnly: true });
  return evidence;
}

/**
 * Real sync: the forced lookups for every part --skip does not name (versions:
 * driftReport + Ruflo release dates; self: selfDrift; ruvnet-brain: brainDrift
 * while ak manages the Brain). Sequential, because each lookup saves kit.json.
 * --dry-run and --no-upgrade make no forced lookup. Returns versionEvidence for
 * the skipped parts only; with nothing skipped it is empty and the sections
 * read the cache the forced lookups just wrote.
 * @param {{ flags: Record<string, any>, skip?: Set<string>, pkgRoot?: string,
 *   fetchLatest?: (pkg: string, tag?: string) => Promise<string | null>,
 *   releaseDatesRunner?: Function, brainDrift?: typeof ruvnetBrainDrift }} input
 * @returns {Promise<{ versionEvidence: { drift?: any[], self?: any, brain?: any, cfg?: any } }>}
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
