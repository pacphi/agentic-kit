import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */
const options = {
  encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
};

const relativePath = (project, file) => {
  const relative = path.relative(project, file).split(path.sep).join('/');
  return relative && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null;
};

/** Batch source-control evidence for the exact artifact files already measured
 * by Catalog. This observes repository state only; it does not claim ownership
 * or authorize a repository change. */
export function inspectProjectArtifacts(project, files, run = spawnSync) {
  const targets = [...new Set(files.map((file) => path.resolve(file)))];
  const relativeByFile = new Map(targets.map((file) => [file, relativePath(project, file)]));
  const relatives = [...new Set([...relativeByFile.values()].filter(Boolean))];
  const fallback = (repository, reason) => new Map(targets.map((file) => [file, {
    repository, tracked: null, workingTree: 'unknown', reason,
  }]));
  if (!relatives.length) return fallback(false, 'artifact is outside the project');

  let probe;
  try { probe = run('git', ['-C', project, 'rev-parse', '--is-inside-work-tree'], options); }
  catch { return fallback(false, 'project repository evidence unavailable'); }
  if (probe?.status !== 0 || String(probe.stdout).trim() !== 'true') {
    return fallback(false, 'project is not a readable Git worktree');
  }

  let trackedResult;
  let statusResult;
  try {
    trackedResult = run('git', ['-C', project, 'ls-files', '-z', '--', ...relatives], options);
    statusResult = run('git', ['-C', project, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...relatives], options);
  } catch {
    return fallback(true, 'Git artifact evidence unavailable');
  }
  const complete = trackedResult?.status === 0 && statusResult?.status === 0;
  if (!complete) return fallback(true, 'Git artifact evidence incomplete');

  const tracked = new Set(String(trackedResult.stdout).split('\0').filter(Boolean));
  const changed = new Set();
  const records = String(statusResult.stdout).split('\0').filter(Boolean);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    changed.add(record.slice(3));
    if (/^[RC]/.test(record) && records[index + 1]) changed.add(records[++index]);
  }
  return new Map(targets.map((file) => {
    const relative = relativeByFile.get(file);
    return [file, {
      repository: true,
      tracked: relative ? tracked.has(relative) : null,
      workingTree: relative && changed.has(relative) ? 'changed' : 'clean',
      reason: relative ? null : 'artifact is outside the project',
    }];
  }));
}

/** Collapse file facts into one conservative artifact fact. */
export function summarizeArtifactTracking(files, facts) {
  const rows = files.map((file) => facts.get(path.resolve(file))).filter(Boolean);
  if (!rows.length) return {
    repository: false, tracked: null, workingTree: 'unknown', reason: 'artifact files were not measured',
  };
  const repository = rows.every((row) => row.repository === true);
  const tracked = rows.every((row) => row.tracked === true)
    ? true : (rows.some((row) => row.tracked === false) ? false : null);
  const workingTree = rows.some((row) => row.workingTree === 'changed')
    ? 'changed' : (rows.every((row) => row.workingTree === 'clean') ? 'clean' : 'unknown');
  const reasons = [...new Set(rows.map((row) => row.reason).filter(Boolean))];
  return { repository, tracked, workingTree, reason: reasons.join('; ') || null };
}
