// Poll-until-condition helper for tests that observe an async side effect
// (a file-tailer noticing an append, a timer firing). Test-quality review
// Finding 4: several tests slept a FIXED duration (e.g. 35ms) after
// triggering a tailer configured with an equally small interval (10ms) —
// only 3.5 poll ticks of headroom, a wall-clock bet on scheduler behavior
// that reads as a real regression the day CI is slow (a loaded Windows
// runner, a release day). This mirrors dashboard.test.cjs's `eventually()`,
// already proven in this codebase, generalized for reuse.
export function waitUntil(predicate, message, { timeout = 2000, interval = 5 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      let ok;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - started >= timeout) return reject(new Error(message || 'condition never became true'));
      setTimeout(check, interval);
    };
    check();
  });
}
