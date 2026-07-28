// qe-court (ADR-124, agentic-qe >= 3.13.0) — read-only awareness + opt-in
// defaulting of its per-role provider routing, a third configuration surface
// alongside ruflo's host env and aqe's global fallback chain (see issue #36).
//
// vendorOf/validatePanel are ported 1:1 from qe-court's own referee.js (the
// falsifiable, dependency-free core of the court's invariants) so ak can
// report pass/fail without shelling out to aqe. Do not reimplement the court
// protocol itself here — this module only reads/defaults the `routing` block
// of an EXISTING .claude/skills/qe-court/config.json; it never creates the
// file and never touches any other key in it.
import path from 'node:path';
import { readJson } from './settings.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';

const QE_COURT_MIN_VERSION = '3.13.0';

/** Is the installed agentic-qe new enough to have shipped qe-court (ADR-124)? */
export function qeCourtShipped() {
  const v = installedVersion('agentic-qe');
  return !!v && cmpVersions(v, QE_COURT_MIN_VERSION) >= 0;
}

/** Map a provider id to its coarse vendor — ported from qe-court's referee.js. */
export function vendorOf(providerId) {
  const p = String(providerId).toLowerCase();
  if (p.startsWith('claude')) return 'claude';
  if (p.startsWith('cognitum')) return 'cognitum';
  if (p === 'codex' || p === 'openai' || p.startsWith('gpt') || p.startsWith('o3') || p.startsWith('o4')) return 'gpt';
  if (p.startsWith('openrouter')) return 'openrouter';
  if (p === 'ollama' || p === 'local') return 'local';
  return 'unknown';
}

/** Flatten config.json's `routing` map (role -> {provider, model?}) into the
 *  {role, provider} panel shape validatePanel() expects. */
export function panelFromRouting(routing) {
  return Object.entries(routing ?? {})
    .filter(([role]) => role !== '_note')
    .map(([role, entry]) => ({ role, provider: entry?.provider }));
}

/** Validate a seated panel against the court's anti-collusion invariants.
 *  Returns a list of violation codes (empty == valid) — ported from
 *  qe-court's referee.js validatePanel(). */
export function validatePanel(panel, policy = {}) {
  const minVendors = policy.minVendors ?? 2;
  const violations = [];
  const vendorsSeated = new Set(panel.map((s) => vendorOf(s.provider)));
  if (vendorsSeated.size < minVendors) violations.push('vendor-diversity');
  const jury = panel.find((s) => s.role === 'jury');
  const writerLike = panel.filter((s) => s.role === 'defense' || s.role === 'writer');
  if (jury) {
    const juryVendor = vendorOf(jury.provider);
    if (writerLike.some((w) => vendorOf(w.provider) === juryVendor)) violations.push('writerIsNeverJuror');
  }
  return violations;
}

// TEMPORARY (remove once fixed upstream): agentic-qe's own shipped default
// config.json violates its own writerIsNeverJuror invariant — defense:
// cognitum-low and jury: cognitum-high resolve to the same vendor per
// vendorOf() above, so a brand-new project fails validation before any user
// touches the file. Filed: proffesor-for-testing/agentic-qe#576.
export const UPSTREAM_JURY_VENDOR_ISSUE = 'https://github.com/proffesor-for-testing/agentic-qe/issues/576';

/** Compute a minimal fix for a writerIsNeverJuror violation: reassign `jury`
 *  to an already-configured provider whose vendor differs from every
 *  writer/defense vendor. Prefers `deeperReviewer`'s provider (already a
 *  second-look role) before falling back to the first other distinct-vendor
 *  seat. Returns null when the panel doesn't have the collision, or when no
 *  distinct-vendor seat exists to borrow from — this never invents a vendor
 *  the project hasn't already configured. Pure; touches nothing. */
export function healJuryVendorCollision(routing) {
  const panel = panelFromRouting(routing);
  const writerVendors = new Set(
    panel.filter((s) => s.role === 'defense' || s.role === 'writer').map((s) => vendorOf(s.provider)),
  );
  const jury = panel.find((s) => s.role === 'jury');
  if (!jury || !writerVendors.has(vendorOf(jury.provider))) return null;

  const candidates = panel.filter((s) => s.role !== 'jury' && !writerVendors.has(vendorOf(s.provider)));
  const preferred = candidates.find((s) => s.role === 'deeperReviewer') ?? candidates[0];
  if (!preferred) return null;

  return { role: 'jury', from: jury.provider, to: preferred.provider };
}

export function qeCourtConfigPath(root) {
  return path.join(root, '.claude', 'skills', 'qe-court', 'config.json');
}

/** Read qe-court's config.json, or null if it hasn't been created yet
 *  (auto-created by the skill on its first run — ak never creates it). */
export function readQeCourtConfig(root) {
  return readJson(qeCourtConfigPath(root), null);
}
