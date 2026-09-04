// Scan-local multi-query filesystem acquisition (ADR-0047 pilot).
//
// Every virtual query keeps walkTree's own budgets, pruning, acceptance, and
// failure state. The physical traversal is their lexical union: one readdir and
// one lstat may feed several queries, but no query inherits another's truth.
// Results remain WalkResult-compatible so the portable independent walker is an
// executable oracle and fallback.
import fs from 'node:fs';
import path from 'node:path';

import {
  MEASURED, UNKNOWN, WALK_LIMITS, runWalkTreeInstrumentation, statNode,
} from './walk.mjs';

function resultFor(root) {
  return {
    root,
    status: MEASURED,
    reason: null,
    bytes: 0,
    files: 0,
    dirs: 0,
    newestMtimeMs: null,
    entriesSeen: 0,
    symlinksSkipped: 0,
    truncated: false,
    truncatedBy: null,
    degradedCount: 0,
    degraded: [],
    complete: true,
  };
}

function queryFor(root, options) {
  return {
    options: {
      maxDepth: options.maxDepth ?? WALK_LIMITS.maxDepth,
      maxEntries: options.maxEntries ?? WALK_LIMITS.maxEntries,
      maxDegraded: options.maxDegraded ?? WALK_LIMITS.maxDegraded,
      skipDir: options.skipDir ?? null,
      acceptFile: options.acceptFile ?? null,
      onFile: options.onFile ?? null,
    },
    result: resultFor(root),
    stopped: false,
  };
}

function truncate(query, by) {
  if (!query.result.truncated) {
    query.result.truncated = true;
    query.result.truncatedBy = by;
  }
  query.result.complete = false;
}

function degrade(query, target, reason) {
  query.result.degradedCount += 1;
  query.result.complete = false;
  if (query.result.degraded.length < query.options.maxDegraded) {
    query.result.degraded.push({ path: target, reason });
  }
}

function countFile(query, file, name, stat, depth) {
  const result = query.result;
  result.files += 1;
  result.bytes += stat.size;
  if (result.newestMtimeMs === null || stat.mtimeMs > result.newestMtimeMs) {
    result.newestMtimeMs = stat.mtimeMs;
  }
  query.options.onFile?.({
    file, name, bytes: stat.size, blocks: stat.blocks, mtimeMs: stat.mtimeMs, depth,
  });
}

function unknownRoot(query, reason) {
  query.result = {
    ...query.result, status: UNKNOWN, reason, bytes: null, files: null, complete: false,
  };
  query.stopped = true;
}

function rootFile(queries, root, head) {
  for (const query of queries) {
    const name = path.basename(root);
    if (!query.options.acceptFile || query.options.acceptFile(name, root, 0)) {
      countFile(query, root, name, { size: head.bytes ?? 0, blocks: undefined,
        mtimeMs: head.mtimeMs }, 0);
    }
  }
}

function activeAtDirectory(queries, indexes) {
  const active = [];
  for (const index of indexes) {
    const query = queries[index];
    if (query.stopped) continue;
    if (query.result.entriesSeen >= query.options.maxEntries) {
      truncate(query, 'entries');
      query.stopped = true;
      continue;
    }
    active.push(index);
  }
  return active;
}

function queriesSeeingEntry(queries, indexes) {
  const seeing = [];
  for (const index of indexes) {
    const query = queries[index];
    if (query.stopped) continue;
    if (query.result.entriesSeen >= query.options.maxEntries) {
      truncate(query, 'entries');
      query.stopped = true;
      continue;
    }
    query.result.entriesSeen += 1;
    seeing.push(index);
  }
  return seeing;
}

function directoryQueries(queries, indexes, file, name, depth) {
  const child = [];
  for (const index of indexes) {
    const query = queries[index];
    if (depth > query.options.maxDepth) {
      truncate(query, 'depth');
      continue;
    }
    if (query.options.skipDir?.(file, name, depth)) continue;
    child.push(index);
  }
  return child;
}

function acceptedQueries(queries, indexes, name, file, depth) {
  return indexes.filter((index) => {
    const accept = queries[index].options.acceptFile;
    return !accept || accept(name, file, depth);
  });
}

function physicalResult(root, physical, queries) {
  return {
    root,
    status: queries.every((query) => query.result.status === UNKNOWN) ? UNKNOWN : MEASURED,
    reason: null,
    bytes: physical.bytes,
    files: physical.files,
    dirs: physical.dirs,
    newestMtimeMs: physical.newestMtimeMs,
    entriesSeen: physical.entriesSeen,
    symlinksSkipped: physical.symlinksSkipped,
    truncated: queries.some((query) => query.result.truncated),
    truncatedBy: null,
    degradedCount: queries.reduce((sum, query) => sum + query.result.degradedCount, 0),
    degraded: [],
    complete: queries.every((query) => query.result.complete),
  };
}

/**
 * Execute same-root virtual walks through one physical traversal.
 *
 * @param {string} root
 * @param {Array<Record<string, any>>} specs walkTree option objects
 * @param {{ walk: Function, fsImpl?: typeof fs }} options
 * @returns {Array<Record<string, any>>} one WalkResult per spec
 */
export function observeWalkForest(root, specs, { walk, fsImpl = fs }) {
  if (!Array.isArray(specs) || specs.length === 0) return [];
  return runWalkTreeInstrumentation(walk, { root, options: { forestQueries: specs.length } }, () => {
    const queries = specs.map((spec) => queryFor(root, spec));
    const physical = {
      bytes: 0, files: 0, dirs: 0, newestMtimeMs: null, entriesSeen: 0, symlinksSkipped: 0,
    };
    const head = statNode(root, { fsImpl });
    if (head.status === UNKNOWN) {
      for (const query of queries) unknownRoot(query, head.reason);
    } else if (head.kind === 'symlink') {
      for (const query of queries) unknownRoot(query, 'symlink (never followed)');
    } else if (head.kind !== 'dir') {
      rootFile(queries, root, head);
      physical.files = queries.some((query) => query.result.files > 0) ? 1 : 0;
      physical.bytes = head.bytes ?? 0;
      physical.newestMtimeMs = head.mtimeMs;
    } else {
      const stack = [{ dir: root, depth: 0, queries: queries.map((_, index) => index) }];
      while (stack.length) {
        const { dir, depth, queries: candidates } = stack.pop();
        const active = activeAtDirectory(queries, candidates);
        if (!active.length) continue;
        let entries;
        try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); }
        catch (error) {
          const reason = error?.code || 'io';
          for (const index of active) {
            if (dir === root) unknownRoot(queries[index], reason);
            else degrade(queries[index], dir, reason);
          }
          continue;
        }
        physical.dirs += 1;
        for (const index of active) queries[index].result.dirs += 1;
        for (const entry of entries) {
          const seeing = queriesSeeingEntry(queries, active);
          if (!seeing.length) break;
          physical.entriesSeen += 1;
          const file = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            physical.symlinksSkipped += 1;
            for (const index of seeing) queries[index].result.symlinksSkipped += 1;
            continue;
          }
          if (entry.isDirectory()) {
            const child = directoryQueries(queries, seeing, file, entry.name, depth + 1);
            if (child.length) stack.push({ dir: file, depth: depth + 1, queries: child });
            continue;
          }
          if (!entry.isFile()) continue;
          const accepting = acceptedQueries(queries, seeing, entry.name, file, depth + 1);
          if (!accepting.length) continue;
          let stat;
          try { stat = fsImpl.lstatSync(file); }
          catch (error) {
            for (const index of accepting) degrade(queries[index], file, error?.code || 'io');
            continue;
          }
          physical.files += 1;
          physical.bytes += stat.size;
          if (physical.newestMtimeMs === null || stat.mtimeMs > physical.newestMtimeMs) {
            physical.newestMtimeMs = stat.mtimeMs;
          }
          for (const index of accepting) countFile(queries[index], file, entry.name, stat, depth + 1);
        }
      }
    }
    return {
      value: queries.map((query) => query.result),
      result: physicalResult(root, physical, queries),
    };
  });
}
