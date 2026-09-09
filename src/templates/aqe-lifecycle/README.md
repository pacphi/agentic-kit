# AQE lifecycle compatibility artifacts

These MIT-licensed artifacts originate in `agentic-qe` 3.14.1. The runner is
copied from that released package. The checkpoint helper is a compatibility
patch to its packaged helper: it preserves existing RVF/sidecar files and calls
the installed `aqe` executable rather than resolving a package during a hook.
The neighboring LICENSE retains upstream attribution.

`legacy-handlers.json` records reviewed generated project handler signatures.
Claude replacements use native seconds: 3/5/10 seconds for lifecycle handlers
(internal budgets are 2.5/4.5 seconds), 5 seconds for verification, and 60 seconds
for export. Export uses a 55-second internal budget to report failure before the
host budget expires; the upstream mount-local disable switch is preserved.
Mixed hook groups retain their unrelated handlers and order.

The audit matches reviewed entire helper preimages by SHA-256. A banner, file
name, or installed package version cannot authorize replacement. Unknown
variants and user edits remain manual review findings. Migration uses the
existing hook-healing transaction engine, exact plan selection, backups,
postimage verification, idempotency checks, and conditional undo. Plugin caches
and upstream installations are never migration targets.

Upstream release evidence: <https://github.com/proffesor-for-testing/agentic-qe/pull/661>.
The packaged checkpoint discrepancy remains a separate upstream follow-up.
