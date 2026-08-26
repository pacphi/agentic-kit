// qe-court (ADR-124, agentic-qe >= 3.13.0) — read-only awareness + opt-in
// defaulting of its per-role provider routing, a third configuration surface
// alongside ruflo's host env and aqe's global fallback chain (see issue #36).
//
// The pure validation helpers mirror agentic-qe >=3.13.3's referee.ts (the
// falsifiable, dependency-free core of the court's invariants) so ak can
// report pass/fail without shelling out to aqe. Do not reimplement the court
// protocol itself here — this module only reads/defaults the `routing` block
// of an EXISTING .claude/skills/qe-court/config.json; it never creates the
// file and never touches any other key in it.
//
// Deliberate fail-closed divergence from upstream referee.ts (F-11):
// unregistered provider ids are never collapsed into one shared 'unknown'
// vendor — each keeps a distinct `unregistered:<id>` tag so two different
// unrecognized providers never spuriously "share" a vendor for the purpose
// of *counting* distinct vendors. validatePanel applies the same "can't
// prove independence" epistemics symmetrically to both checks it runs:
//   - vendor-diversity: unregistered vendors are excluded from the count
//     entirely, so they can never help satisfy minVendors.
//   - writerIsNeverJuror: an unregistered writer and an unregistered jury
//     are treated as COULD-BE-colluding (flagged) even when their tags
//     differ, because ak can't prove two ids it doesn't recognize are
//     actually different vendors.
// Net effect: ak is never looser than a model where every unrecognized id
// shared one 'unknown' vendor — it may flag stricter, but never the reverse.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './settings.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';

const QE_COURT_MIN_VERSION = '3.13.0';

/** Is the installed agentic-qe new enough to have shipped qe-court (ADR-124)? */
export function qeCourtShipped() {
  const v = installedVersion('agentic-qe');
  return !!v && cmpVersions(v, QE_COURT_MIN_VERSION) >= 0;
}

/** Map a provider id to its coarse vendor — ported from qe-court's referee.js.
 *  Known prefixes are byte-identical to upstream; an unrecognized id gets its
 *  own `unregistered:<id>` tag instead of collapsing into one 'unknown'
 *  bucket (F-11 — see module comment). */
export function vendorOf(providerId) {
  const p = String(providerId).toLowerCase();
  if (p.startsWith('claude')) return 'claude';
  if (p.startsWith('cognitum')) return 'cognitum';
  if (p === 'codex' || p === 'openai' || p.startsWith('gpt') || p.startsWith('o3') || p.startsWith('o4')) return 'gpt';
  if (p.startsWith('openrouter')) return 'openrouter';
  if (p === 'ollama' || p === 'local') return 'local';
  return `unregistered:${p}`;
}

/** Flatten config.json's `routing` map (role -> {provider, model?}) into the
 *  {role, provider} panel shape validatePanel() expects. */
export function panelFromRouting(routing) {
  return Object.entries(routing ?? {})
    .filter(([role]) => !role.startsWith('_'))
    .filter(([, seat]) => typeof seat?.provider === 'string' && seat.provider.length > 0)
    .map(([role, entry]) => ({ role, provider: entry?.provider }));
}

/** Validate a seated panel against the court's anti-collusion invariants.
 *  Returns a list of violation codes (empty == valid) — ported from
 *  qe-court's referee.ts validatePanel(). */
export function validatePanel(panel, policy = {}) {
  const minVendors = policy.minVendors ?? policy.minDistinctVendors ?? 2;
  const violations = [];
  // unregistered vendors can never help satisfy minVendors — ak can't prove
  // two unrecognized ids are independent vendors (F-11 fail-closed divergence).
  const vendorsSeated = new Set(
    panel.map((s) => vendorOf(s.provider)).filter((v) => !v.startsWith('unregistered:')),
  );
  if (vendorsSeated.size < minVendors) violations.push('vendor-diversity');
  const jury = panel.find((s) => s.role === 'jury');
  const writerLike = panel.filter((s) => s.role === 'defense' || s.role === 'writer');
  if (!jury) {
    violations.push('missing-jury');
  } else if (policy.writerIsNeverJuror !== false) {
    const juryVendor = vendorOf(jury.provider);
    const juryUnregistered = juryVendor.startsWith('unregistered:');
    // Same vendor tag always collides. Two DIFFERENT unregistered tags also
    // collide (fail closed) — ak can't prove an unrecognized writer id and
    // an unrecognized jury id are actually different vendors, so it must
    // assume they could be the same one rather than silently trust they
    // aren't (mirrors the vendor-diversity exclusion above).
    const collides = writerLike.some((w) => {
      const writerVendor = vendorOf(w.provider);
      return writerVendor === juryVendor || (juryUnregistered && writerVendor.startsWith('unregistered:'));
    });
    if (collides) violations.push('writerIsNeverJuror');
  }
  return violations;
}

/** Validate a whole qe-court config using the policy declared in its options. */
export function validateCourtConfig(config) {
  return validatePanel(panelFromRouting(config?.routing ?? {}), config?.options ?? {});
}

export function qeCourtConfigPath(root) {
  return path.join(root, '.claude', 'skills', 'qe-court', 'config.json');
}

/** Read qe-court's config.json, or null if it hasn't been created yet
 *  (auto-created by the skill on its first run — ak never creates it). */
export function readQeCourtConfig(root) {
  return readJson(qeCourtConfigPath(root), null);
}

function anyExists(files) {
  return files.some((file) => fs.existsSync(file));
}

/** Fail-closed consumer readiness for the upstream-owned court skill. This does
 * not implement or execute the court. It proves only that both host projections
 * are present, agree, and carry the schema/referee/oracle assets their own
 * metadata and evals reference. Provider-seat readiness is a separate live
 * proof. */
export function qeCourtReadiness(root) {
  const projections = [
    { host: 'Claude', dir: path.join(root, '.claude', 'skills', 'qe-court') },
    { host: 'Codex', dir: path.join(root, '.agents', 'skills', 'qe-court') },
  ];
  const artifactIssues = [];
  const configs = [];
  const required = [
    'SKILL.md', 'config.json', 'schemas/output.json',
    'scripts/validate-config.json', 'evals/qe-court.yaml',
  ];
  for (const projection of projections) {
    for (const rel of required) {
      if (!fs.existsSync(path.join(projection.dir, rel))) {
        artifactIssues.push(`${projection.host} projection missing ${rel}`);
      }
    }
    const config = readJson(path.join(projection.dir, 'config.json'), null);
    configs.push(config);
    const schemaRef = typeof config?.$schema === 'string' ? config.$schema : null;
    if (schemaRef && !fs.existsSync(path.resolve(projection.dir, schemaRef))) {
      artifactIssues.push(`${projection.host} projection missing referenced ${schemaRef.replace(/^\.\//, '')}`);
    }
  }
  if (configs.every(Boolean) && JSON.stringify(configs[0]) !== JSON.stringify(configs[1])) {
    artifactIssues.push('Claude and Codex qe-court config projections differ');
  }
  if (!anyExists(['.ts', '.js', '.mjs'].map((ext) => path.join(root, 'src', 'skills', 'qe-court', `referee${ext}`)))) {
    artifactIssues.push('consumer is missing the referenced qe-court referee implementation');
  }
  if (!anyExists(['.ts', '.js', '.mjs'].map((ext) => path.join(root, 'tests', 'unit', 'skills', 'qe-court', `referee.test${ext}`)))) {
    artifactIssues.push('consumer is missing the referenced qe-court referee oracle');
  }
  const routingViolations = configs[0] ? validateCourtConfig(configs[0]) : ['missing-config'];
  return {
    ready: routingViolations.length === 0 && artifactIssues.length === 0,
    routingViolations,
    artifactIssues,
  };
}
