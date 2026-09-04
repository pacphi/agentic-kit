// Production worker entrypoint for the synchronous machine-footprint scan.
import { parentPort, workerData } from 'node:worker_threads';
import { runDeepScan } from './deep-scan-runner.mjs';

if (!parentPort) throw new Error('deep scan worker requires a parent port');

const snapshotOpts = workerData.snapshotFile ? { file: workerData.snapshotFile } : {};
const result = await runDeepScan({
  startedAt: workerData.startedAt,
  cwd: workerData.cwd,
  includeProjectTrees: workerData.includeProjectTrees === true,
  snapshotOpts,
  onActivity: (activity) => parentPort.postMessage({ type: 'activity', activity }),
  onSection: ({ name, value }) => parentPort.postMessage({ type: 'section', name, value }),
});
// Sections have already crossed as they completed. Do not clone the whole
// payload a second time at completion; the main-thread engine reassembles it.
const { sections: _sections, ...outcome } = result;
parentPort.postMessage({ type: 'result', result: outcome });
