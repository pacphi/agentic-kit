// Source coverage is independent of V1 listing, parsing and the selected window.
import { withDb } from './sqlite.mjs';
import { observeOpencodeStorageCoverage } from './usage-opencode-storage-coverage.mjs';

/** Observe only the selected store and its explicitly resolved legacy root.
 * Failed database access is unknown, never evidence that V2 storage is empty.
 * @param {{dbFile: string | null, legacyRoot: string | null}} selection */
export function opencodeStorageHealth({ dbFile, legacyRoot }) {
  const legacy = observeOpencodeStorageCoverage({ legacyRoot });
  if (!dbFile) return legacy;
  const observed = withDb(dbFile, (db) => {
    db.exec('PRAGMA query_only = ON');
    return observeOpencodeStorageCoverage({ db });
  });
  const v2 = observed.ok ? observed.value.v2 : { status: 'unknown' };
  const warnings = observed.ok ? observed.value.warnings : ['opencode-v2-observation-incomplete'];
  return { v2, legacy: legacy.legacy, warnings: [...warnings, ...legacy.warnings] };
}
