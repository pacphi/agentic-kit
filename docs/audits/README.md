# Audit records and their authority

Dated audit reports and JSON inventories in this directory describe the source, installed
artifacts, local observations and limits named by each report. A statement such as “current,”
“implemented,” or “changes remain uncommitted” is relative to its recorded inspection, not a fresh
claim about this checkout or another machine. A proposed repair is not authorization to execute it.

Keep original findings, test totals, hashes and observations unchanged. Later reports may supersede
an earlier finding while preserving it as evidence. Current operator behavior lives in the relevant
[domain documentation](../ddd/README.md), [Maintenance guide](../MAINTENANCE.md), and ADRs.

The September 9 sequence is explicitly cumulative:

1. [Ruflo cross-host audit](2026-09-09-ruflo-cross-host-alignment.md)
2. [First remediation](2026-09-09-ruflo-remediation.md)
3. [Memory/Brain follow-up](2026-09-09-memory-brain-alignment.md)

[AQE integration repair](2026-09-09-aqe-integration-repair.md) has its own baseline and scope.
September 1–2 hook reports retain their then-verified host versions and exact-action boundaries;
a later installed host version does not inherit those conformance results automatically.

Machine-readable inventories here are observations, not executable policy, ownership receipts,
release capabilities or permission to read additional host history. Issue-specific matrices state
whether their review was semantic, structural, metadata-only, or actually reran executable checks.
See the [issue 211 historical/artifact inventory](211-history-matrix.md) for per-file review limits.
