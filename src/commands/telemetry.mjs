import fs from 'node:fs';
import path from 'node:path';
import { telemetryDir } from '../lib/paths.mjs';
import { SNAPSHOT_SCHEMA, METRIC_CATALOG, DERIVED_METRICS, MAX_FILE_BYTES } from '../lib/telemetry/schema.mjs';
import { validateSnapshot } from '../lib/telemetry/contract.mjs';
import { aggregateSnapshots, MAX_INPUT_FILES } from '../lib/telemetry/aggregate.mjs';
import { collectSnapshot } from '../lib/telemetry/collect.mjs';
import { readJsonDocument, readJsonFile, readOrCreateIdentity, writeNewJson } from '../lib/telemetry/store.mjs';

export const options = {
  days: { type: 'string' }, output: { type: 'string' },
  'as-of': { type: 'string' }, 'stale-after': { type: 'string' },
};
export const help = `ak telemetry — vendor-neutral, offline fleet evidence

Usage:
  ak telemetry export [--days 1..365] [--output NEW_FILE]
  ak telemetry validate FILE
  ak telemetry aggregate FILE... [--as-of UTC_ISO] [--stale-after SECONDS] [--output NEW_FILE]
  ak telemetry schema
  ak telemetry metrics

All successful output is JSON. --output creates a new owner-private file; never overwrites.
Export creates a private installation identity on first use, refreshes the local usage index,
and reads retained maintenance evidence. No upload, integration probe or maintenance scan.
--days defaults to 30. Whole retained sessions are selected by end time; their cumulative
usage can precede that lookback. Exports are snapshots, never additive time-window increments.
Aggregate selects the latest snapshot per installation and requires matching lookbacks.
--as-of defaults to now; use canonical UTC ISO (for example 2026-09-20T12:00:00.000Z).
--stale-after defaults to 86400 seconds. Stale data remains included and explicitly flagged.
No raw transcripts, private paths, hostnames, commands, secrets or configuration are exported.
Copied transcripts across installations are distinct observations; identity is installation-scoped.

Examples:
  ak telemetry export --days 30 --output ./machine-a.json
  ak telemetry validate ./machine-a.json
  ak telemetry aggregate ./machine-a.json ./machine-b.json --output ./fleet.json
  ak telemetry schema
  ak telemetry metrics`;

function integerOption(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError('Invalid telemetry numeric option');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) throw new TypeError('Invalid telemetry numeric option');
  return n;
}
function checkOptions(command, flags, files) {
  const allowed = { export: ['days', 'output'], validate: [], aggregate: ['as-of', 'stale-after', 'output'], schema: [], metrics: [] };
  if (!Object.hasOwn(allowed, command)) throw new TypeError('Unknown telemetry command');
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined && !allowed[command].includes(key)) throw new TypeError('Unsupported telemetry option');
  }
  if (command === 'validate' && files.length !== 1) throw new TypeError('Telemetry validate requires one file');
  if (command === 'aggregate' && (!files.length || files.length > MAX_INPUT_FILES)) throw new TypeError('Telemetry aggregate requires 1..256 files');
  if (!['validate', 'aggregate'].includes(command) && files.length) throw new TypeError('Unexpected telemetry arguments');
}

/** CLI owns transport to files/stdout; pure domain functions never print.
 * @param {{ flags: Record<string, any>, positionals: string[], pkgRoot: string,
 * deps?: { identityDir?: string, collect?: typeof collectSnapshot } }} input
 */
export async function run({ flags, positionals, pkgRoot, deps = {} }) {
  try {
    const [command, ...files] = positionals;
    checkOptions(command, flags, files);
    let result;
    if (command === 'schema') result = SNAPSHOT_SCHEMA;
    if (command === 'metrics') result = { schemaVersion: 1, metrics: METRIC_CATALOG, derived: DERIVED_METRICS };
    if (command === 'validate') {
      const snapshot = validateSnapshot(readJsonFile(files[0]));
      result = { valid: true, schemaVersion: snapshot.schemaVersion, snapshotId: snapshot.snapshotId };
    }
    if (command === 'aggregate') {
      const staleAfterSeconds = integerOption(flags['stale-after'], 86400, 31_536_000);
      // Bound the combined input as well as each individual file.
      let bytes = 0;
      const snapshots = files.map(file => {
        const document = readJsonDocument(file, MAX_FILE_BYTES - bytes);
        bytes += document.bytes;
        return document.value;
      });
      result = aggregateSnapshots(snapshots, { asOf: flags['as-of'], staleAfterSeconds });
    }
    if (command === 'export') {
      const days = integerOption(flags.days, 30, 365);
      const identity = readOrCreateIdentity(deps.identityDir ?? telemetryDir());
      const producerVersion = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
      result = await (deps.collect ?? collectSnapshot)({ identity, producerVersion, days });
      validateSnapshot(result);
    }
    if (flags.output) writeNewJson(flags.output, result);
    else {
      const text = JSON.stringify(result, null, 2);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Telemetry output exceeds safe bounds');
      console.log(text);
    }
    return 0;
  } catch {
    // Source failures and hostile input must not echo filenames or parser details.
    console.error('Telemetry failed: check command options, schema/digest, compatible snapshots, private identity, and readable input/new output files.');
    return 2;
  }
}
