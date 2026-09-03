import {
  MAINTENANCE_CAPABILITIES, MAINTENANCE_SCHEMA_VERSION, deepFreeze, emptySummary,
} from './model.mjs';
import { scanMaintenanceFindings } from './scanner.mjs';

/** Build the versioned Maintenance DTO shared by CLI and future dashboard work. */
export function buildMaintenanceReadModel({ footprint = {}, now = Date.now } = {}) {
  const scan = scanMaintenanceFindings({ footprint, now });
  const summary = emptySummary();
  for (const finding of scan.findings) summary[finding.bucket] += 1;
  return deepFreeze({
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    mode: 'read-only',
    capabilities: MAINTENANCE_CAPABILITIES,
    asOf: scan.evidence.asOf,
    freshness: scan.evidence,
    sourceFingerprint: scan.sourceFingerprint,
    summary,
    findings: scan.findings,
    receipts: [],
  });
}
