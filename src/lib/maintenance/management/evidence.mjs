// ADR-0048 evidence model (domain-model.md "EvidenceAssertion"). Every primary
// claim is field-local and independently graded; there is no aggregate
// numeric confidence that could launder a weak field through strong unrelated
// evidence. This module only shapes and summarizes assertions — it never
// decides what grade a fact deserves; the caller (projection.mjs and its
// mapping helpers) supplies that from what it actually observed.
import { EVIDENCE_COMPLETENESS, EVIDENCE_FIELDS, EVIDENCE_FRESHNESS, EVIDENCE_GRADES } from './model.mjs';

/**
 * Build one EvidenceAssertion. Throws on a malformed assertion rather than
 * silently dropping a field, so a mapping bug surfaces at build time instead
 * of as a missing scorecard entry downstream.
 *
 * @param {{ subjectId: string, field: string, value?: *, grade: string,
 *           authority: string, sourceRef: string, capturedAt: string,
 *           freshness?: string, completeness?: string, scope?: string|null }} input
 */
export function assertion({
  subjectId, field, value = null, grade, authority, sourceRef, capturedAt,
  freshness = 'fresh', completeness = 'complete', scope = null,
}) {
  if (!subjectId) throw new TypeError('assertion requires a subjectId');
  if (!EVIDENCE_FIELDS.includes(field)) throw new TypeError(`assertion.field must be one of ${EVIDENCE_FIELDS.join(', ')}`);
  if (!EVIDENCE_GRADES.includes(grade)) throw new TypeError(`assertion.grade must be one of ${EVIDENCE_GRADES.join(', ')}`);
  if (!authority) throw new TypeError('assertion requires an authority');
  if (!sourceRef) throw new TypeError('assertion requires a sourceRef');
  if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) throw new TypeError('assertion requires an ISO capturedAt');
  if (!EVIDENCE_FRESHNESS.includes(freshness)) throw new TypeError('assertion.freshness must be fresh or stale');
  if (!EVIDENCE_COMPLETENESS.includes(completeness)) throw new TypeError('assertion.completeness must be complete or partial');
  return { subjectId, field, value, grade, authority, sourceRef, capturedAt, freshness, completeness, scope };
}

const GRADE_RANK = Object.freeze({ inferred: 0, 'provider-declared': 1, verified: 2 });

/** The strongest grade recorded per field, for one subject's assertions. A
 *  field absent from `assertions` is omitted from the scorecard — never
 *  defaulted to a grade nobody observed. */
export function scorecardFor(assertions = []) {
  const scorecard = {};
  for (const entry of assertions) {
    const current = scorecard[entry.field];
    if (!current || GRADE_RANK[entry.grade] > GRADE_RANK[current]) scorecard[entry.field] = entry.grade;
  }
  return scorecard;
}

/** Assertions belonging to one subject, in the order given. */
export function assertionsFor(assertions, subjectId) {
  return assertions.filter((entry) => entry.subjectId === subjectId);
}

/** The strongest assertion for one subject+field, or `undefined` when the
 *  field was never asserted for that subject. */
export function strongestAssertion(assertions, subjectId, field) {
  let best;
  for (const entry of assertions) {
    if (entry.subjectId !== subjectId || entry.field !== field) continue;
    if (!best || GRADE_RANK[entry.grade] > GRADE_RANK[best.grade]) best = entry;
  }
  return best;
}

/** True only when a subject's field carries verified evidence — the sole
 *  grade permitted to support a primary label or an action premise
 *  (ADR-0048 §5, MNT-EVD-002). */
export function isVerified(assertions, subjectId, field) {
  return strongestAssertion(assertions, subjectId, field)?.grade === 'verified';
}

/** A short, allowlisted technical-detail sentence for inferred-only evidence.
 *  Returns null when the field carries verified or provider-declared
 *  evidence (inferred detail is redundant once a stronger grade exists) or no
 *  evidence at all. */
export function inferredDetail(assertions, subjectId, field, describe) {
  const strongest = strongestAssertion(assertions, subjectId, field);
  if (!strongest || strongest.grade !== 'inferred') return null;
  return typeof describe === 'function' ? describe(strongest) : null;
}
