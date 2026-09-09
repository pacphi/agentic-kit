# Existing-corpus routing and Brain continuity alignment

Follow-up to [the first remediation pass](2026-09-09-ruflo-remediation.md),
branched from squash merge `c7fee0a` of PR #208.

## Memory result

Ruflo 3.39.2's CLI resolves and passes `memory.db` explicitly to its bridge.
The bridge otherwise defaults to the native `agentdb-memory.db` sibling. Restoring
native bindings therefore does not make both invocation paths select one corpus.

A known existing native-store record was tested using SQLite backup snapshots of
both project stores. With explicit `memory.db`, retrieval exited 1 and did not
return the value. With explicit `agentdb-memory.db`, retrieval exited 0 and returned
the exact value. Temporary snapshots were removed. Live project databases were
opened read-only for this experiment; no records were migrated or rewritten.

Status now reports both observed stores without claiming an active writer. The
[troubleshooting guide](../TROUBLESHOOTING.md#existing-memory-corpus-routing)
documents explicit-path retrieval. This is a verified workaround, not a universal
writer-convergence fix. Shared MCP paths remain unchanged. Windows split-store
behavior and fresh execution across every host remain unverified.

## Brain result

The selected Claude plugin, KB/code bundle, and Codex plugin are now 4.3.17.
The exact-version installer exited 0 and verified the signed bundle
SHA-256 `f4c0109a83ac2d5788850559c4825e0d25df8a1f87535eced66271c64c59d93e`.
Its source-grounded search passed in 128.3 seconds. Previous generations remain
preserved by the installer; no automatic cleanup was performed.

The exact static continuity contract is pinned to
[upstream commit 3f7c3b8](https://github.com/stuinfla/ruvnet-brain/blob/3f7c3b8cd894e30090825322a2de0ac1ab12d9d1/plugin/hooks/hooks.json).
It includes precisely one SessionStart handler and one Stop handler with their
reviewed matchers, commands, and timeouts. Additional behavior, unknown versions,
or absent/unsafe shim paths do not pass qualification. Static registration does
not establish that host lifecycle behavior has executed correctly.

The independent `ruvnet-brain@4.3.17 --doctor --hooks` query passed in 121.5 seconds.
Its continuity policy reported zero legacy/invalid registrations and zero manifest
errors. Nevertheless the command exited 1: a separate Codex diagnostic still labels
the two supported hooks retired. This contradictory upstream check remains open;
the hooks were preserved. Existing Claude/Codex sessions require restart before
their loaded plugin generations can be considered aligned.

## Validation and scope

The final regression suite passed: 3,776 tests, 3,770 passed, six skipped. Coverage
was 91.88% lines, 80.58% branches, and 91.34% functions. Typecheck, complexity gate,
build, and Markdown lint passed. Independent read-only review found no blockers;
its recommended selected-shim integration test was added and passed.

No additional stale local branches were proven safe to delete after #208 cleanup.
Archives, existing worktrees, and uncertain branches remain intact. The separately
queued dashboard grouping and cross-host context-panel design remain unstarted.
