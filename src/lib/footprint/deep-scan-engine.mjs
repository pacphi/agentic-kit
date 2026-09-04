// Main-thread transport for a production deep scan. The worker owns the
// synchronous collectors and the snapshot write; the caller owns single-flight
// policy and public progress state.
import { Worker } from 'node:worker_threads';
import { summarizeCompleteness } from './snapshot.mjs';

const WORKER_URL = new URL('./deep-scan-worker.mjs', import.meta.url);

function reasonOf(error) {
  return String(error?.code || error?.message || error || 'deep scan worker failed');
}

/**
 * @param {{
 *   startedAt: number, cwd: string, includeProjectTrees?: boolean,
 *   snapshotFile?: string|null, onActivity?: (activity: object) => void,
 *   now?: () => number, WorkerImpl?: typeof Worker, workerUrl?: URL,
 * }} options
 */
export function runDeepScanInWorker({
  startedAt,
  cwd,
  includeProjectTrees = false,
  snapshotFile = null,
  onActivity = null,
  now = Date.now,
  WorkerImpl = Worker,
  workerUrl = WORKER_URL,
}) {
  return new Promise((resolve) => {
    /** Sections reported before an abnormal worker exit remain useful lower-
     *  level evidence, just as sections before a throwing collector do inline. */
    const sections = {};
    let settled = false;
    let worker;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      const finishedAt = now();
      const reason = reasonOf(error);
      resolve({
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
      });
    };

    try {
      worker = new WorkerImpl(workerUrl, {
        workerData: { startedAt, cwd, includeProjectTrees, snapshotFile },
      });
    } catch (error) {
      fail(error);
      return;
    }

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'activity') {
        if (typeof onActivity === 'function') {
          try { onActivity(message.activity ?? {}); } catch { /* Progress is non-authoritative. */ }
        }
        return;
      }
      if (message.type === 'section' && typeof message.name === 'string') {
        sections[message.name] = message.value;
        return;
      }
      if (message.type === 'result') {
        if (settled) return;
        if (!message.result || typeof message.result !== 'object') {
          fail('deep scan worker returned an invalid result');
          return;
        }
        settled = true;
        resolve({ ...message.result, sections });
      }
    });
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (!settled) fail(`deep scan worker exited ${code} before returning a result`);
    });
  });
}
