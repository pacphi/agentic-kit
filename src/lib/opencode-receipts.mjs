// opencode-receipts.mjs — shared receipt/comparison primitives for the
// opencode host adapter's config-wiring, agent-conversion, and artifact
// modules (opencode.mjs, opencode-agents.mjs, opencode-artifacts.mjs,
// opencode-lifecycle.mjs). Extracted so all four share ONE definition
// instead of re-deriving content hashing / deep-equality independently.
import { createHash } from 'node:crypto';

/** Order-insensitive deep compare (JSON with sorted keys). */
export function deepEqual(a, b) {
  const stable = (v) => JSON.stringify(v, (k, x) => (
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)))
      : x
  ));
  return stable(a) === stable(b);
}

export const contentHash = (text) => createHash('sha256').update(text).digest('hex');
export const hasReceiptValue = (value) => value !== null && value !== undefined;
export const receiptMatches = (text, receipt) =>
  typeof receipt === 'string' && contentHash(text) === receipt;

/** Tolerate a legacy/malformed `receipts` value (array, non-object) by
 *  treating it as an empty ledger — shared by syncAgents and agentsStatus. */
export const asReceiptMap = (receipts) => (
  receipts && typeof receipts === 'object' && !Array.isArray(receipts) ? receipts : {}
);
