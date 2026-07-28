// Safe JSON-file editing for Claude Code settings files. Always backup-first
// (one .bak per calling site, never overwritten within a run), always
// merge-not-clobber, trailing newline preserved.
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonWithBackup(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const bak = `${file}.bak`;
    try { if (!fs.existsSync(bak)) fs.copyFileSync(file, bak); } catch { /* best-effort */ }
  }
  // write-tmp-then-rename: rename(2) is atomic within a filesystem, so a
  // reader (including Claude Code itself, on every startup) always sees
  // either the complete old file or the complete new one — never a
  // truncated one from an interrupt (Ctrl-C, OOM kill) landing mid-write.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
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
