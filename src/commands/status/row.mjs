// Shared row constructor for every `ak status` section. One row = one
// subsystem fact: a level (ok/info/warn/fail), a human message, an optional
// `fix` (what would make it healthy), and — whenever there is a fix — its
// repair contract (#237):
//   repair: 'sync'   an `ak sync` step performs this fix (the default);
//           'manual' a human must do it (a command to run, a file to edit, a
//                    login); sync never plans it and never claims it.
// Load-bearing: sync builds its plan from rows whose fix is a 'sync' repair,
// the dashboard and text status label manual fixes, and `ak status --json`
// carries the field. A 'sync' fix MUST have a SYNC_STEPS step whose `when`
// fires for its subsystem (tests/kit/status-repair-contract.test.mjs).
const REPAIRS = new Set(['sync', 'manual']);

/**
 * @param {string} subsystem
 * @param {string} level
 * @param {string} message
 * @param {string | null} [fix]
 * @param {{ repair?: 'sync' | 'manual' }} [options]
 */
export const row = (subsystem, level, message, fix = null, { repair } = {}) => {
  if (repair != null && !REPAIRS.has(repair)) {
    throw new TypeError(`status row repair must be 'sync' or 'manual', got ${JSON.stringify(repair)}`);
  }
  return { subsystem, level, message, fix, repair: fix ? (repair ?? 'sync') : null };
};
