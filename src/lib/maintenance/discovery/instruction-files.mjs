// ADR-0048 instruction-file evidence — the ONE bounded, non-recursive file
// probe shared by project-detection.mjs (per-discovered-project files) and
// configuration.mjs (user-level automatic-source files), kept dependency-free
// so neither of those two modules — which already import from each other —
// forms an import cycle by sharing this.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** A digest is offered only up to this size; content is read once and never
 *  retained past computing it. */
export const MAX_INSTRUCTION_DIGEST_BYTES = 256 * 1024;

/** Bounded, non-recursive evidence for one candidate file: present, and (when
 *  it is a regular file no larger than the digest ceiling) its sha256. A
 *  symlink is never followed — it reports absent, matching the walker's own
 *  never-follow-symlinks rule. */
export function readInstructionFileEvidence(file, { fsImpl = fs } = {}) {
  let stat;
  try { stat = fsImpl.lstatSync(file); } catch { return { present: false }; }
  if (!stat.isFile()) return { present: false };
  if (stat.size > MAX_INSTRUCTION_DIGEST_BYTES) return { present: true };
  let buffer;
  try { buffer = fsImpl.readFileSync(file); } catch { return { present: true }; }
  return { present: true, digest: createHash('sha256').update(buffer).digest('hex') };
}
