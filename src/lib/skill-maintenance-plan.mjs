// Read-only skill remediation planning for #198. This module classifies exact
// project occurrences and describes a potential change set; it never writes,
// deletes, stages, or invokes a mutating command.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function digestOf(presence) {
  return presence?.digest?.status === 'measured' && presence.digest.partial !== true
    ? presence.digest.value
    : null;
}

function normalizeReceipt(receipt) {
  if (!receipt || typeof receipt.path !== 'string') return null;
  return {
    path: path.resolve(receipt.path), digest: typeof receipt.digest === 'string' ? receipt.digest : null,
    desired: receipt.desired !== false, sourceRef: receipt.sourceRef ?? null,
    sourceVersion: receipt.sourceVersion ?? null,
  };
}

const gitPath = (project, artifact) => path.relative(project, artifact).split(path.sep).join('/');

function gitProjectFacts(project, artifacts, run) {
  const relatives = [...new Set(artifacts.map((artifact) => gitPath(project, artifact.path))
    .filter((relative) => relative && !relative.startsWith('../') && !path.isAbsolute(relative)))];
  const probe = run('git', ['-C', project, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe?.status !== 0 || probe?.stdout?.trim() !== 'true') {
    return new Map(relatives.map((relative) => [relative,
      { repository: false, tracked: null, dirty: null, reason: 'project is not a readable git worktree', relative }]));
  }
  const trackedResult = run('git', ['-C', project, 'ls-files', '-z', '--', ...relatives], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const status = run('git', ['-C', project, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...relatives], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tracked = new Set(trackedResult?.status === 0 ? String(trackedResult.stdout).split('\0').filter(Boolean) : []);
  const dirty = new Set();
  if (status?.status === 0) {
    const records = String(status.stdout).split('\0').filter(Boolean);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      dirty.add(record.slice(3));
      if (/^[RC]/.test(record) && records[index + 1]) dirty.add(records[++index]);
    }
  }
  return new Map(relatives.map((relative) => [relative, {
    repository: true,
    tracked: trackedResult?.status === 0 ? tracked.has(relative) : null,
    dirty: status?.status === 0 ? dirty.has(relative) : null,
    reason: status?.status === 0 && trackedResult?.status === 0 ? null : 'git evidence incomplete',
    relative,
  }]));
}

function sharedSkillDigests(catalog, capabilityName) {
  const values = new Set();
  for (const item of catalog.items ?? []) {
    if (item.kind !== 'skill' || item.capabilityName?.toLowerCase() !== capabilityName.toLowerCase()) continue;
    for (const presence of item.presence ?? []) {
      if (!['user', 'plugin'].includes(presence.scope)) continue;
      const digest = digestOf(presence);
      if (digest) values.add(digest);
    }
  }
  return values;
}

function classify(presence, item, receipt, catalog) {
  const digest = digestOf(presence);
  if (!digest) {
    return { classification: 'unmeasured-artifact', recommendation: 'preserve-and-review', safeToPrune: false };
  }
  if (receipt) {
    if (!receipt.digest || receipt.digest !== digest) {
      return { classification: 'receipt-drifted-or-modified', recommendation: 'preserve-and-review', safeToPrune: false };
    }
    if (receipt.desired) {
      return { classification: 'current-desired', recommendation: 'retain', safeToPrune: false };
    }
    return { classification: 'receipt-owned-unchanged', recommendation: 'safe-prune-candidate', safeToPrune: true };
  }
  if (sharedSkillDigests(catalog, item.capabilityName).has(digest)) {
    return { classification: 'exact-known-upstream-revision', recommendation: 'review-project-copy', safeToPrune: false };
  }
  return { classification: 'modified-ambiguous-or-unreceipted', recommendation: 'preserve-and-review', safeToPrune: false };
}

function projectSkillArtifacts(catalog, projectPath, receiptByPath) {
  const artifacts = new Map();
  for (const item of catalog?.items ?? []) {
    if (item.kind !== 'skill') continue;
    for (const presence of item.presence ?? []) {
      if (presence.scope !== 'project' || path.resolve(presence.project ?? '') !== projectPath) continue;
      const artifact = presence.sourceFile ?? presence.itemPath;
      if (!artifact) continue;
      const artifactPath = path.resolve(artifact);
      const previous = artifacts.get(artifactPath);
      if (previous) {
        if (!previous.hosts.includes(presence.host)) previous.hosts.push(presence.host);
        continue;
      }
      const receipt = receiptByPath.get(artifactPath) ?? null;
      artifacts.set(artifactPath, {
        name: item.capabilityName ?? item.name, displayName: item.name,
        path: artifactPath, digest: digestOf(presence), hosts: [presence.host],
        ...classify(presence, item, receipt, catalog),
        receipt: receipt ? { desired: receipt.desired, sourceRef: receipt.sourceRef, sourceVersion: receipt.sourceVersion } : null,
      });
    }
  }
  return [...artifacts.values()];
}

/** Build a credential-free, read-only plan from a fresh CatalogInventory.
 * @param {{ catalog?: any, project?: string, receipts?: any[], now?: () => number,
 *           run?: typeof spawnSync }} options */
export function buildSkillMaintenancePlan({
  catalog, project, receipts = [], now = Date.now, run = spawnSync,
} = {}) {
  const projectPath = path.resolve(project ?? process.cwd());
  const receiptByPath = new Map(receipts.map(normalizeReceipt).filter(Boolean)
    .map((receipt) => [receipt.path, receipt]));
  const artifacts = projectSkillArtifacts(catalog, projectPath, receiptByPath);
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const gitByPath = gitProjectFacts(projectPath, artifacts, run);
  const projectEvidence = catalog?.projects?.find((row) => path.resolve(row.project ?? '') === projectPath);
  for (const artifact of artifacts) {
    const relative = gitPath(projectPath, artifact.path);
    artifact.git = gitByPath.get(relative)
      ?? { repository: false, tracked: null, dirty: null, reason: 'artifact is outside project' };
    if (artifact.safeToPrune && (catalog?.complete !== true
        || projectEvidence?.complete !== true
        || artifact.git.repository !== true
        || artifact.git.dirty !== false
        || artifact.git.tracked === null
        || artifact.git.reason !== null)) {
      artifact.classification = 'receipt-owned-evidence-incomplete';
      artifact.recommendation = 'preserve-and-review';
      artifact.safeToPrune = false;
    }
  }
  const uniquePaths = [...new Set(artifacts.map((artifact) => artifact.path))];
  const prunePaths = [...new Set(artifacts.filter((artifact) => artifact.safeToPrune)
    .map((artifact) => artifact.path))];
  const projection = {
    currentProjectSkillPaths: uniquePaths.length,
    safePruneCandidates: prunePaths.length,
    projectedProjectSkillPaths: uniquePaths.length - prunePaths.length,
  };
  const stable = { schemaVersion: 1, project: projectPath, artifacts, projection, affectedPaths: prunePaths };
  const planDigest = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return {
    ...stable, planId: `skills-plan-${planDigest.slice(0, 16)}`, planDigest,
    generatedAt: new Date(now()).toISOString(), mode: 'read-only',
    contextInclusion: catalog?.projects?.find((row) => row.project === projectPath)?.contextInclusion
      ?? { status: 'unknown', reason: 'host-owned context inclusion is not exposed' },
    rollback: {
      requiredForApply: true,
      note: 'No apply exists in #198. A future #200 transaction must back up untracked paths and preserve source-control recovery.',
    },
  };
}
