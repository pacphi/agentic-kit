// Safe JSON-file editing for Claude Code settings files. Always backup-first
// (one .bak per calling site, never overwritten within a run), always
// merge-not-clobber, trailing newline preserved.
import fs from 'node:fs';
import { writeFileWithBackup } from './file-write.mjs';

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonWithBackup(file, data, options) {
  // Serialize before touching the filesystem: circular/unsupported values fail
  // without even creating a backup or temporary file.
  const content = JSON.stringify(data, null, 2) + '\n';
  writeFileWithBackup(file, content, options);
}

/** Add deny rules (deduped, sorted); returns count actually added. */
export function addDenyRules(file, rules) {
  const d = readJson(file, {}) ?? {};
  d.permissions ??= {};
  const deny = new Set(d.permissions.deny ?? []);
  const before = deny.size;
  for (const r of rules) deny.add(r);
  d.permissions.deny = [...deny].sort();
  writeJsonWithBackup(file, d);
  return deny.size - before;
}

/** Remove deny rules matching a predicate; returns count removed. */
export function removeDenyRules(file, predicate) {
  const d = readJson(file);
  const deny = d?.permissions?.deny;
  if (!Array.isArray(deny)) return 0;
  const kept = deny.filter((r) => !predicate(r));
  const removed = deny.length - kept.length;
  if (removed > 0) {
    d.permissions.deny = kept;
    writeJsonWithBackup(file, d);
  }
  return removed;
}
