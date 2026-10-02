// watch-errors.mjs — the onError the dashboard hands a project's IntelligenceWatch. A watcher used to
// swallow every failure, so a cache that could not be written was invisible. This reports each distinct
// failure once, so a persistent fault shows up without a line for every poll.
const MAX_REMEMBERED = 20;

/**
 * @param {string} label printed before the error, e.g. `[dashboard] intelligence watcher failed:`
 * @param {(...args: unknown[]) => void} [log]
 * @returns {(error: any) => void}
 */
export function distinctErrorReporter(label, log = (...args) => console.error(...args)) {
  const seen = new Set();
  return (error) => {
    const message = String(error?.message ?? error);
    if (seen.has(message)) return;
    if (seen.size >= MAX_REMEMBERED) seen.clear();
    seen.add(message);
    log(label, error);
  };
}
