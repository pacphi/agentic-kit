// ADR-0048 discovery preview — "nothing is saved until the preview identifies
// ..." (discovery-and-scan-policy.md "Add-source preview"). Every export here
// is a pure, bounded, read-only probe: it never writes kit.json or owner-
// private state. The bounded in-memory preview cache below is what lets a
// later `confirm` reuse the exact previewed root/policy rather than a mutable
// project list (MNT-DSC-003).
import fs from 'node:fs';
import path from 'node:path';

import { observeWalkForest } from '../../footprint/observation-forest.mjs';
import { walkTree } from '../../footprint/walk.mjs';
import { opaqueId } from '../management/model.mjs';
import { validateRoot } from './configuration.mjs';
import {
  CURATED_SKIP_DIRS, projectDetectionSpec as sharedDetectionSpec, projectIdentity,
} from './project-detection.mjs';

const PREVIEW_CEILINGS = Object.freeze({ maxDepth: 8, maxEntries: 20_000 });

/** The preview's own recording shape: a FULL relative breadcrumb (never
 *  shortened — this is an advisory listing of everything found, not the
 *  curated display list `orchestrator.projects()` produces once a whole
 *  source's collisions are known). Detection itself is the shared, once-
 *  written skipDir walk in project-detection.mjs, so preview and the real
 *  scan can never disagree about what counts as a project. */
function previewProjectSpec({ fsImpl, exclusions, projects, root, installationKey }) {
  return sharedDetectionSpec({
    fsImpl,
    exclusions,
    onProject({ absoluteRoot, worktree }) {
      projects.push({
        projectId: projectIdentity(absoluteRoot, installationKey),
        breadcrumb: path.relative(root, absoluteRoot).split(path.sep).filter(Boolean),
        worktree: worktree || undefined,
      });
    },
  });
}

function estimateSpec() {
  return { acceptFile: () => true, onFile: () => {} };
}

function permissionsDenied(results) {
  return results.reduce((count, result) => count
    + (result.degraded ?? []).filter((entry) => entry.reason === 'EACCES' || entry.reason === 'EPERM').length, 0);
}

/**
 * Advisory, bounded preview of adding `root` as an exact project or
 * collection root. Nothing is persisted. `configuration` (from
 * `readDiscoveryConfiguration`) supplies the exclusions already configured so
 * the preview reflects what a saved source would actually see.
 *
 * @param {{ kind: string, root: string,
 *   configuration?: {exclusions?: Array<{path:string, recursive:boolean}>},
 *   fsImpl?: typeof fs, walk?: Function, ceilings?: {maxDepth:number, maxEntries:number},
 *   installationKey: string, now?: () => number }} options
 */
export function previewSource({
  kind, root, configuration = { exclusions: [] }, fsImpl = fs, walk = walkTree,
  ceilings = PREVIEW_CEILINGS, installationKey, now = Date.now,
}) {
  const validation = validateRoot(root, { fsImpl, includeNetwork: true });
  const projects = [];
  const specs = [
    previewProjectSpec({
      fsImpl, exclusions: configuration.exclusions ?? [], projects, root, installationKey,
    }),
    estimateSpec(),
  ];
  const previewId = opaqueId('prv', { kind, root, at: now() }, installationKey);
  if (!validation.valid) {
    return {
      previewId, kind, root, boundary: validation.boundary,
      projectsFound: [], exclusions: { automatic: [], exact: [], recursive: [] },
      depth: 0, symlinksSkipped: 0, boundaries: validation.boundary ? [validation.boundary] : [],
      estimate: null, estimateReason: validation.reason,
      permissions: { denied: 0 }, ceilings, valid: false, reason: validation.reason,
    };
  }
  const bounded = specs.map((spec) => ({ maxDepth: ceilings.maxDepth, maxEntries: ceilings.maxEntries, ...spec }));
  const [projectResult, estimateResult] = observeWalkForest(root, bounded, { walk, fsImpl });

  const exact = (configuration.exclusions ?? []).filter((entry) => !entry.recursive && entry.path.startsWith(root));
  const recursive = (configuration.exclusions ?? []).filter((entry) => entry.recursive && (entry.path === root || entry.path.startsWith(`${root}${path.sep}`) || root.startsWith(`${entry.path}${path.sep}`)));

  return {
    previewId, kind, root, boundary: validation.boundary,
    projectsFound: projects,
    exclusions: { automatic: [...CURATED_SKIP_DIRS], exact, recursive },
    depth: ceilings.maxDepth,
    symlinksSkipped: projectResult.symlinksSkipped + estimateResult.symlinksSkipped,
    boundaries: validation.boundary ? [validation.boundary] : [],
    estimate: estimateResult.complete
      ? { entries: estimateResult.entriesSeen, bytes: estimateResult.bytes, timeRange: null }
      : null,
    estimateReason: estimateResult.complete ? null : 'the bounded preview walk did not finish; the estimate is incomplete',
    permissions: { denied: permissionsDenied([projectResult, estimateResult]) },
    ceilings,
    valid: true,
    reason: null,
  };
}

/** Projects affected by adding an exclusion at `targetPath`. `recursive`
 *  previews every project under it; a non-recursive exclusion previews only
 *  an exact match.
 *
 * @param {{ path: string, recursive?: boolean, fsImpl?: typeof fs, walk?: Function,
 *   ceilings?: {maxDepth:number, maxEntries:number}, installationKey: string,
 *   now?: () => number }} options
 */
export function previewExclusion({
  path: targetPath, recursive = false, fsImpl = fs, walk = walkTree, ceilings = PREVIEW_CEILINGS,
  installationKey, now = Date.now,
}) {
  const validation = validateRoot(targetPath, { fsImpl, includeNetwork: true });
  const exclusionId = opaqueId('exc', { path: targetPath, recursive, at: now() }, installationKey);
  if (!validation.valid || !recursive) {
    return { exclusionId, path: targetPath, recursive, affectedProjects: [], valid: validation.valid, reason: validation.reason };
  }
  const projects = [];
  const spec = previewProjectSpec({
    fsImpl, exclusions: [], projects, root: targetPath, installationKey,
  });
  observeWalkForest(targetPath, [{ maxDepth: ceilings.maxDepth, maxEntries: ceilings.maxEntries, ...spec }], { walk, fsImpl });
  return { exclusionId, path: targetPath, recursive, affectedProjects: projects, valid: true, reason: null };
}

/** A bounded, TTL-expiring in-memory cache from previewId to preview payload,
 *  so a later `confirm` step reuses the exact previewed root/policy rather
 *  than trusting a client-supplied one (MNT-DSC-003's "not a mutable list"). */
export function createPreviewCache({ now = Date.now, ttlMs = 10 * 60_000, maxEntries = 200 } = {}) {
  const entries = new Map();
  function prune() {
    const cutoff = now();
    for (const [id, entry] of entries) if (entry.expiresAt <= cutoff) entries.delete(id);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  return {
    remember(preview) {
      prune();
      entries.set(preview.previewId, { preview, expiresAt: now() + ttlMs });
      return preview;
    },
    get(previewId) {
      prune();
      return entries.get(previewId)?.preview ?? null;
    },
    size: () => entries.size,
  };
}
