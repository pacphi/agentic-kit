#!/usr/bin/env node

// Read-only benchmark for the composed Machine Footprint deep collectors.
// It intentionally does not use createSystemCollector: that facade persists a
// snapshot, while a benchmark must not replace the operator's last good report.
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { loadKitConfig } from '../src/lib/config.mjs';
import { collectCatalog } from '../src/lib/footprint/catalog.mjs';
import { collectConsumers } from '../src/lib/footprint/consumers.mjs';
import { collectInstall } from '../src/lib/footprint/install.mjs';
import { discoverProjectSources } from '../src/lib/footprint/project-sources.mjs';
import { collectProjects } from '../src/lib/footprint/projects.mjs';
import { collectStorage } from '../src/lib/footprint/storage.mjs';
import { walkTree } from '../src/lib/footprint/walk.mjs';

const usage = `Usage: node scripts/benchmark-footprint.mjs [options]

Options:
  --runs N       measured runs (default: 1)
  --warmups N    unreported warmup runs (default: 0)
  --trees        include project working trees in Consumers
  --json         emit one JSON document
  --help         show this help
`;

function positiveInteger(value, flag, { zero = false } = {}) {
  if (!/^[0-9]+$/.test(value ?? '')) throw new TypeError(`${flag} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (zero ? parsed < 0 : parsed < 1) || parsed > 100) {
    throw new RangeError(`${flag} must be ${zero ? 'between 0' : 'between 1'} and 100`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { runs: 1, warmups: 0, trees: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help') return { ...options, help: true };
    if (arg === '--json') options.json = true;
    else if (arg === '--trees') options.trees = true;
    else if (arg === '--runs') options.runs = positiveInteger(argv[++index], arg);
    else if (arg === '--warmups') options.warmups = positiveInteger(argv[++index], arg, { zero: true });
    else throw new TypeError(`unknown option: ${arg}`);
  }
  return options;
}

function aggregateWork(rows) {
  return rows.reduce((summary, row) => ({
    walkCalls: summary.walkCalls + 1,
    walkMs: summary.walkMs + row.durationMs,
    entriesSeen: summary.entriesSeen + (Number(row.entriesSeen) || 0),
    files: summary.files + (Number(row.files) || 0),
    directories: summary.directories + (Number(row.directories) || 0),
    incompleteWalks: summary.incompleteWalks + (row.complete ? 0 : 1),
  }), {
    walkCalls: 0, walkMs: 0, entriesSeen: 0, files: 0, directories: 0, incompleteWalks: 0,
  });
}

function runBenchmark({ trees }) {
  const walkRows = [];
  const phases = [];
  let phase = 'discovery';
  const walk = (root, options) => {
    const started = performance.now();
    const result = walkTree(root, options);
    walkRows.push({
      phase,
      root,
      durationMs: performance.now() - started,
      entriesSeen: result.entriesSeen,
      files: result.files,
      directories: result.dirs,
      complete: result.complete === true,
    });
    return result;
  };
  const measure = (name, operation) => {
    phase = name;
    const started = performance.now();
    const value = operation();
    phases.push({ name, durationMs: performance.now() - started });
    return value;
  };

  const started = performance.now();
  const discovered = measure('discovery', () => discoverProjectSources({ walk }));
  const onDisk = discovered.projects.filter((project) => project.exists);
  const projectPaths = onDisk.map((project) => project.path);
  let cfg = {};
  try { cfg = loadKitConfig() ?? {}; } catch { cfg = {}; }
  const install = measure('install', () => collectInstall({ walk }));
  const projects = measure('projects', () => collectProjects({
    sources: discovered, projects: discovered, walk,
  }));
  const consumers = measure('consumers', () => collectConsumers({
    install, projects: projects.projects, includeProjectTrees: trees, walk,
  }));
  const storage = measure('storage', () => collectStorage({
    projects: projectPaths, install, consumers, projectFootprints: projects.projects,
    now: () => install.asOf, walk,
  }));
  const catalog = measure('catalog', () => collectCatalog({
    cwd: process.cwd(), cfg, projects: projectPaths, walk,
  }));

  const workByPhase = Object.fromEntries(phases.map(({ name }) => {
    const rows = walkRows.filter((row) => row.phase === name);
    return [name, {
      ...aggregateWork(rows),
      topWalks: [...rows]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 10)
        .map((row) => ({
          root: row.root,
          durationMs: rounded(row.durationMs),
          entriesSeen: row.entriesSeen,
          complete: row.complete,
        })),
    }];
  }));
  return {
    durationMs: performance.now() - started,
    phases: phases.map((entry) => ({
      name: entry.name,
      durationMs: entry.durationMs,
      ...workByPhase[entry.name],
    })),
    work: aggregateWork(walkRows),
    workload: {
      projectsDiscovered: discovered.projects.length,
      projectsOnDisk: onDisk.length,
      catalogItems: catalog.items.length,
      consumerProjectTrees: trees,
      storageComplete: storage.complete === true,
    },
  };
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function summarize(samples, options) {
  const ordered = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  return {
    schemaVersion: 1,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    options: { runs: options.runs, warmups: options.warmups, trees: options.trees },
    summary: {
      medianMs: rounded(median),
      minMs: rounded(ordered[0]),
      maxMs: rounded(ordered.at(-1)),
    },
    samples: samples.map((sample) => ({
      ...sample,
      durationMs: rounded(sample.durationMs),
      phases: sample.phases.map((phase) => ({ ...phase, durationMs: rounded(phase.durationMs), walkMs: rounded(phase.walkMs) })),
      work: { ...sample.work, walkMs: rounded(sample.work.walkMs) },
    })),
  };
}

function printHuman(result) {
  console.log(`deep scan median ${Math.round(result.summary.medianMs)} ms `
    + `(range ${Math.round(result.summary.minMs)}–${Math.round(result.summary.maxMs)} ms)`);
  for (const phase of result.samples.at(-1).phases) {
    console.log(`${phase.name.padEnd(10)} ${String(Math.round(phase.durationMs)).padStart(8)} ms  `
      + `${String(phase.walkCalls).padStart(4)} walks  ${String(phase.entriesSeen).padStart(9)} entries`);
    for (const walk of phase.topWalks.slice(0, 3)) {
      console.log(`  ${String(Math.round(walk.durationMs)).padStart(8)} ms  `
        + `${String(walk.entriesSeen).padStart(9)} entries  ${walk.complete ? 'complete' : 'partial'}  ${walk.root}`);
    }
  }
  const work = result.samples.at(-1).work;
  console.log(`total work ${work.walkCalls} walks · ${work.entriesSeen} entries · ${work.incompleteWalks} incomplete`);
}

let options;
try { options = parseArgs(process.argv.slice(2)); }
catch (error) {
  console.error(error.message);
  console.error(usage.trimEnd());
  process.exitCode = 2;
}
if (options?.help) console.log(usage.trimEnd());
else if (options) {
  for (let index = 0; index < options.warmups; index += 1) runBenchmark(options);
  const samples = Array.from({ length: options.runs }, () => runBenchmark(options));
  const result = summarize(samples, options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}
