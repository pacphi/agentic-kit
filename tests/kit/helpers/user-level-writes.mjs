// Shared by the scope contract tests (P0-08). A "user-level write" uses the scope gate's own
// vocabulary (src/lib/scope-gate.mjs): an OutOfScopeWrite is a change to a file outside the
// project root and the cache; an OutOfScopeCommand is a command that changes user-level state,
// named by its rule (checkCommand). The baseline in fixtures/user-level-write-baseline.json lists
// every one that exists today, as a named exception. A write not listed fails the test; so does a
// listed write that no longer happens (the list may only shrink, on purpose).
import fs from 'node:fs';
import path from 'node:path';
import { snapshot } from './home-sandbox.mjs';

export const BASELINE_FILE = new URL('./../fixtures/user-level-write-baseline.json', import.meta.url);
export const loadBaseline = () => JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));

/** A HOME-relative path in the form the baseline stores: POSIX separators, and the parts that
 *  differ on every run (a timestamp or a UUID in a backup name) replaced by `*`. */
export const normalizeRel = (rel) => rel.split(path.sep).join('/')
  .replace(/\.bak\.\d+$/, '.bak.*')
  .replace(/-backup\.[0-9a-f]{8}-[0-9a-f-]{27}$/, '-backup.*');

/**
 * The files (and innermost new or removed folders) that differ between two snapshots of `home`, minus anything
 * the `isAllowed` predicate accepts (the cache). A folder that holds another changed path
 * is implied by it and is not listed on its own.
 * @param {Map<string,string>} before @param {string} home
 * @param {(absolute: string, isFolder: boolean) => boolean} isAllowed
 * @returns {string[]} normalized HOME-relative paths, sorted
 */
export function changedPaths(before, home, isAllowed) {
  const after = snapshot(home);
  const changed = [];
  for (const [rel, hash] of after) if (!before.has(rel) || before.get(rel) !== hash) changed.push(rel);
  for (const rel of before.keys()) if (!after.has(rel)) changed.push(rel);
  const implied = (rel) => changed.some((other) => other !== rel && other.startsWith(rel));
  return changed
    .filter((rel) => !(rel.endsWith('/') && implied(rel)))
    .filter((rel) => !isAllowed(path.join(home, rel), rel.endsWith('/')))
    .map(normalizeRel).sort();
}

/**
 * Compare what was observed with the baseline section.
 * @param {Map<string, Set<string>>} observed key (path or rule) -> scenarios that produced it
 * @param {{ name: string, scenarios: string[] }[]} entries baseline entries; `key` names the field
 * @param {'path' | 'rule'} key
 * @returns {{ added: string[], stale: string[] }}
 */
export function compareToBaseline(observed, entries, key) {
  const expected = new Set(entries.flatMap((entry) => entry.scenarios.map((s) => `${entry[key]}  <=  ${s}`)));
  const seen = new Set([...observed].flatMap(([k, scenarios]) => [...scenarios].map((s) => `${k}  <=  ${s}`)));
  return {
    added: [...seen].filter((line) => !expected.has(line)).sort(),
    stale: [...expected].filter((line) => !seen.has(line)).sort(),
  };
}

/** The message a failing comparison prints: what to do about each side. */
export function explain(label, { added, stale }) {
  const lines = [];
  if (added.length) {
    lines.push(`NEW user-level ${label} (not in tests/kit/fixtures/user-level-write-baseline.json). Remove the write; do not add it to the baseline:`,
      ...added.map((line) => `  + ${line}`));
  }
  if (stale.length) {
    lines.push(`Baseline entries for ${label} that no longer happen. Delete them from the baseline (the list only shrinks):`,
      ...stale.map((line) => `  - ${line}`));
  }
  return lines.join('\n');
}

/** Add `scenario` to the set kept under `key`. */
export function note(map, key, scenario) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(scenario);
}
