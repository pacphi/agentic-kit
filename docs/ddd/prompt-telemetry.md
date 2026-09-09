# Prompt telemetry

Prompt Telemetry is a subdomain of Historical Usage. It explains recurring patterns in what the
operator typed without retaining prompt text or turning observation into coaching.

## Model

- `PromptFingerprint` contains a normalized-text hash, token count, bounded token-hash sketch,
  provenance, question/persona shape evidence, and optional controlled intent/topic codes.
- `RecurringPromptCluster` groups exact or near-duplicate human fingerprints across the configured
  session/day thresholds.
- `SemanticFacet` is one code from a release-versioned closed intent or topic vocabulary.
- `PatternName` is a deterministic presentation derived from direct persona evidence, qualifying
  cluster semantic evidence, or an honest structural fallback.

## Invariants

1. No prompt text, excerpt, proper noun or unbounded extracted vocabulary enters the index or
   dashboard projection.
2. Semantic extraction is local, deterministic and network-free.
3. A cluster facet needs at least two supporting members, at least 60% coverage, and no tie.
4. An intent/topic name may be composed only when that exact pair clears the same support rule.
5. Persona evidence takes precedence because the fingerprint records it directly.
6. Token length, punctuation and hash shape do not establish subject matter.
7. Unknown vocabulary stays `Unclassified`; it is never forced into `other` as a user-facing type.
8. The legacy binary `class` field may remain in compatibility JSON but does not define the
   dashboard taxonomy.
9. Input ordering cannot change cluster identity, facet selection or label.
10. No presentation name creates a recommendation, action, draft or mutable coaching state.

## Evidence flow

```text
Native transcript turn -> provenance gate -> privacy-bounded fingerprint
    -> deterministic repeat clustering -> cluster-majority facets -> read-only CLI/dashboard name
```

Parser-time extraction is required because the fingerprint/cluster projection deliberately has
no prompt text. Existing selected-session transcript access remains a separate content plane.
Changing the closed facet contract therefore bumps the usage cache schema and reparses retained
sources. Dashboard Delivery receives only fingerprints and aggregates; the explicit local `--deep`
CLI remains ADR-0039's explicit text-bearing prompt-analysis path; it does not replace the
existing authenticated transcript reader.

The intent/topic facet contract was introduced by cache schema v18. Current usage schema v20
retains it alongside later repository/origin evidence; a facet change still requires reparsing.

## Ownership

- Historical Usage owns parsing, cache invalidation, clustering and counts.
- Prompt Telemetry owns controlled vocabularies, majority rules and presentation names.
- Dashboard Delivery owns accessible tables and visible evidence boundaries.
- Coaching, model enrichment, saved labels and mutation remain outside current mainline scope.
