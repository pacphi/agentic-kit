import { cmpVersions } from '../../../src/lib/versions.mjs';

// This is the stock gateway test window, not an updater constraint. Expanding
// it requires the gateway behavior test to pass against the new release line.
export const STOCK_OPENCODE_MIN_VERSION = '1.18.18';
export const STOCK_OPENCODE_MAX_EXCLUSIVE = '1.19.0';
export const STOCK_OPENCODE_VERSION_RANGE =
  `>=${STOCK_OPENCODE_MIN_VERSION} <${STOCK_OPENCODE_MAX_EXCLUSIVE}`;

const VERSION_IN_OUTPUT = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;

export function extractStockOpenCodeVersion(output) {
  const match = String(output).match(VERSION_IN_OUTPUT);
  return match?.[1] ?? null;
}

export function isSupportedStockOpenCodeVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) return false;
  return cmpVersions(version, STOCK_OPENCODE_MIN_VERSION) >= 0
    && cmpVersions(version, STOCK_OPENCODE_MAX_EXCLUSIVE) < 0;
}
