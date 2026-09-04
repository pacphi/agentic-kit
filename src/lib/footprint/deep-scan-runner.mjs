// The deep machine-footprint scan as one transport-neutral operation.
//
// Production executes this runner in deep-scan-worker.mjs so synchronous tree
// walks cannot monopolize the dashboard's event loop. Tests and embedders that
// inject filesystem or collector collaborators execute the same runner inline:
// functions are intentionally never serialized across the worker boundary.
import fs from 'node:fs';
import { loadKitConfig } from '../config.mjs';
import { collectInstall } from './install.mjs';
import { collectStorage } from './storage.mjs';
import { collectCatalog } from './catalog.mjs';
import { collectProjects } from './projects.mjs';
import { collectConsumers } from './consumers.mjs';
import { discoverProjectSources } from './project-sources.mjs';
import { summarizeCompleteness, writeSnapshot } from './snapshot.mjs';

export const DEEP_SCAN_PHASES = Object.freeze([
  'idle', 'install', 'storage', 'catalog', 'projects', 'consumers', 'persist', 'done', 'failed',
]);

export const DEFAULT_DEEP_COLLECTORS = Object.freeze({
  install: collectInstall,
  storage: collectStorage,
  catalog: collectCatalog,
  projects: collectProjects,
  consumers: collectConsumers,
});

const breathe = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Normalize either supported project-discovery shape without deciding what a
 * missing discovery means for a downstream collector.
 *
 * @param {any} result
 * @returns {{ sources: object|null, catalog: Array|null, onDisk: Array }}
 */
function readDiscovery(result) {
  if (Array.isArray(result)) {
    return { sources: null, catalog: result, onDisk: result.filter((project) => project?.path) };
  }
  if (!result || typeof result !== 'object' || !Array.isArray(result.projects)) {
    return { sources: null, catalog: null, onDisk: [] };
  }
  return {
    sources: result,
    catalog: null,
    onDisk: result.projects.filter((project) => project?.path && project.exists !== false),
  };
}

function notify(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(value); } catch { /* Observability cannot change scan evidence. */ }
}

function defaulted(value, fallback) {
  return value === undefined ? fallback : value;
}

/**
 * Run the deep collectors in evidence order and persist only a fully executed
 * scan. A collector failure returns every section that completed before it and
 * never rejects, preserving the composed collector's fail-soft contract.
 *
 * @param {{
 *   startedAt: number, cwd: string, includeProjectTrees?: boolean,
 *   fsImpl?: typeof fs, loadConfig?: () => object,
 *   discoverProjects?: (options?: object) => any,
 *   collectors?: Record<string, Function>, collectorOptions?: Record<string, object>,
 *   snapshotOpts?: object, writeSnapshotImpl?: typeof writeSnapshot,
 *   now?: () => number, onActivity?: (activity: object) => void,
 *   onSection?: (section: { name: string, value: any }) => void,
 * }} options
 */
export async function runDeepScan(options) {
  const { startedAt, cwd, onActivity, onSection } = options;
  const includeProjectTrees = options.includeProjectTrees === true;
  const fsImpl = defaulted(options.fsImpl, fs);
  const loadConfig = defaulted(options.loadConfig, loadKitConfig);
  const discoverProjects = defaulted(options.discoverProjects, discoverProjectSources);
  const collectors = defaulted(options.collectors, DEFAULT_DEEP_COLLECTORS);
  const collectorOptions = defaulted(options.collectorOptions, {});
  const snapshotOpts = defaulted(options.snapshotOpts, {});
  const writeSnapshotImpl = defaulted(options.writeSnapshotImpl, writeSnapshot);
  const now = defaulted(options.now, Date.now);
  /** @type {Record<string, any>} */
  const sections = {};
  const publish = (name, value) => {
    sections[name] = value;
    notify(onSection, { name, value });
  };
  const phase = (name, extra = {}) => notify(onActivity, { phase: name, ...extra });

  try {
    // Inline execution must yield before its first synchronous collector so a
    // start-or-attach HTTP request can return. In a worker this is harmless.
    await breathe();

    let discovered = null;
    try { discovered = discoverProjects({ fsImpl }); } catch { discovered = null; }
    const { sources, catalog, onDisk } = readDiscovery(discovered);
    const projectPaths = discovered ? onDisk.map((project) => project.path) : null;

    let cfg = {};
    try { cfg = loadConfig() ?? {}; } catch { cfg = {}; }

    publish('install', collectors.install({
      now: () => startedAt, fsImpl, ...(collectorOptions.install ?? {}),
    }));
    await breathe();

    phase('storage');
    publish('storage', collectors.storage({
      projects: projectPaths, now: () => startedAt, fsImpl, ...(collectorOptions.storage ?? {}),
    }));
    await breathe();

    phase('catalog');
    publish('catalog', collectors.catalog({
      cwd, cfg, projects: projectPaths ?? [], now: () => startedAt, fsImpl,
      ...(collectorOptions.catalog ?? {}),
    }));
    await breathe();

    phase('projects', { scanned: 0, total: onDisk.length, path: null });
    publish('projects', collectors.projects({
      sources,
      projects: catalog,
      now: () => startedAt,
      fsImpl,
      onProgress: ({ scanned, total, path: at }) => {
        phase('projects', { scanned, total, path: at ?? null });
      },
      ...(collectorOptions.projects ?? {}),
    }));
    await breathe();

    phase('consumers');
    const measuredProjects = sections.projects?.projects;
    publish('consumers', collectors.consumers({
      now: () => startedAt,
      fsImpl,
      install: sections.install ?? null,
      projects: Array.isArray(measuredProjects) && measuredProjects.length
        ? measuredProjects
        : projectPaths,
      includeProjectTrees,
      ...(collectorOptions.consumers ?? {}),
    }));
    await breathe();

    phase('persist');
    const persisted = writeSnapshotImpl(sections, {
      ...snapshotOpts, now: now(), asOf: startedAt,
    });
    const finishedAt = now();
    const error = persisted.ok ? null : `snapshot not persisted: ${persisted.error}`;
    return {
      ok: true,
      asOf: startedAt,
      sections,
      completeness: summarizeCompleteness(sections),
      persisted,
      error,
      terminal: {
        running: false, phase: 'done', finishedAt,
        durationMs: finishedAt - startedAt, error,
      },
    };
  } catch (error) {
    const finishedAt = now();
    const reason = String(error?.code || error?.message || error);
    return {
      ok: false,
      asOf: startedAt,
      sections,
      completeness: summarizeCompleteness(sections),
      persisted: null,
      error: reason,
      terminal: {
        running: false, phase: 'failed', finishedAt,
        durationMs: finishedAt - startedAt, error: reason,
      },
    };
  }
}
