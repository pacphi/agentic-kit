import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSystemCollector } from '../../src/lib/footprint/index.mjs';
import { runDeepScanInWorker } from '../../src/lib/footprint/deep-scan-engine.mjs';

const AS_OF = 1_800_000_000_000;

function section(name) {
  return { name, asOf: AS_OF, complete: true };
}

test('production composition keeps one worker-backed deep scan single-flight', async () => {
  let calls = 0;
  let measuredWithTrees = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runWorkerImpl = async ({ startedAt, includeProjectTrees, onActivity }) => {
    calls += 1;
    measuredWithTrees = includeProjectTrees;
    onActivity({ phase: 'projects', scanned: 2, total: 5, path: '/fixture/two' });
    await gate;
    return {
      ok: true,
      asOf: startedAt,
      sections: { install: section('install') },
      completeness: { complete: false, sections: {}, missing: ['storage'] },
      persisted: { ok: true, file: '/fixture/snapshot.json', asOf: startedAt, error: null },
      error: null,
      terminal: {
        running: false, phase: 'done', finishedAt: startedAt + 10,
        durationMs: 10, error: null,
      },
    };
  };
  // `cwd`, `snapshotFile`, and the project-tree toggle are production data,
  // not injected execution collaborators, so this composition uses the worker.
  const collector = createSystemCollector({
    cwd: '/fixture/project',
    snapshotFile: '/fixture/snapshot.json',
    includeProjectTrees: true,
    runWorkerImpl,
  });

  const first = collector.refreshDeep();
  const second = collector.refreshDeep({ includeProjectTrees: false });
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(collector.scanState(), {
    running: true,
    phase: 'projects',
    scanned: 2,
    total: 5,
    path: '/fixture/two',
    startedAt: collector.scanState().startedAt,
    finishedAt: null,
    durationMs: null,
    error: null,
    asOf: collector.scanState().asOf,
    includeProjectTrees: true,
  });

  release();
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(measuredWithTrees, true, 'an attached request cannot relabel the running measurement');
  assert.equal(collector.scanState().phase, 'done');
  assert.equal(collector.scanState().running, false);
});

test('an injected collector graph remains inline and preserves partial sections', async () => {
  const calls = [];
  let persisted = 0;
  const installSection = section('install');
  const collectors = {
    install() { calls.push('install'); return installSection; },
    storage(options) {
      calls.push('storage');
      assert.strictEqual(options.install, installSection,
        'Storage receives the exact Install observation from this scan');
      return section('storage');
    },
    catalog() { calls.push('catalog'); throw new Error('catalog refused'); },
    projects() { calls.push('projects'); return section('projects'); },
    consumers() { calls.push('consumers'); return section('consumers'); },
  };
  const collector = createSystemCollector({
    now: () => AS_OF,
    cwd: '/fixture/project',
    collectors,
    loadConfig: () => ({}),
    discoverProjects: () => [],
    writeSnapshotImpl: () => { persisted += 1; return { ok: true }; },
    runWorkerImpl: async () => { throw new Error('worker must not run'); },
  });

  const result = await collector.refreshDeep();
  assert.equal(result.ok, false);
  assert.match(result.error, /catalog refused/);
  assert.deepEqual(Object.keys(result.sections), ['install', 'storage']);
  assert.deepEqual(calls, ['install', 'storage', 'catalog']);
  assert.equal(persisted, 0);
  assert.equal(collector.scanState().phase, 'failed');
});

test('worker transport relays progress and retains completed sections on abnormal exit', async () => {
  class FixtureWorker extends EventEmitter {
    constructor(_url, options) {
      super();
      assert.equal(options.workerData.cwd, '/fixture/project');
      setImmediate(() => {
        this.emit('message', {
          type: 'activity', activity: { phase: 'storage', scanned: 0, total: 0, path: null },
        });
        this.emit('message', { type: 'section', name: 'install', value: section('install') });
        this.emit('exit', 9);
      });
    }
  }
  const activity = [];
  const result = await runDeepScanInWorker({
    startedAt: AS_OF,
    cwd: '/fixture/project',
    WorkerImpl: FixtureWorker,
    now: () => AS_OF + 25,
    onActivity: (value) => activity.push(value),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /exited 9/);
  assert.deepEqual(result.sections, { install: section('install') });
  assert.deepEqual(activity.map((value) => value.phase), ['storage']);
  assert.equal(result.terminal.durationMs, 25);
});

test('the real worker transport leaves the caller event loop responsive', async () => {
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    parentPort.postMessage({ type: 'activity', activity: { phase: 'storage' } });
    parentPort.postMessage({
      type: 'section', name: 'install',
      value: { name: 'install', asOf: workerData.startedAt, complete: true },
    });
    const until = Date.now() + 100;
    while (Date.now() < until) {}
    parentPort.postMessage({
      type: 'result',
      result: {
        ok: true, asOf: workerData.startedAt,
        completeness: { complete: false, sections: {}, missing: ['storage'] },
        persisted: { ok: true, file: '/fixture/snapshot.json', error: null },
        error: null,
        terminal: {
          running: false, phase: 'done', finishedAt: workerData.startedAt + 100,
          durationMs: 100, error: null,
        },
      },
    });
  `;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(source)}`);
  let settled = false;
  const resultPromise = runDeepScanInWorker({
    startedAt: AS_OF, cwd: '/fixture/project', workerUrl,
  }).then((result) => { settled = true; return result; });

  // A synchronous loop on this thread would prevent this timer from firing.
  // The worker's loop is still running, while the test thread remains usable.
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(settled, false);

  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.deepEqual(result.sections, { install: section('install') });
});
