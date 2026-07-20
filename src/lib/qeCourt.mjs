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

export function qeCourtConfigPath(root) {
  return path.join(root, '.claude', 'skills', 'qe-court', 'config.json');
}

/** Read qe-court's config.json, or null if it hasn't been created yet
 *  (auto-created by the skill on its first run — ak never creates it). */
export function readQeCourtConfig(root) {
  return readJson(qeCourtConfigPath(root), null);
}
