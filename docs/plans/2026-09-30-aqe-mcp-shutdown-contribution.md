# AQE MCP shutdown contribution

## Status

**Prepared, unpublished**, 2026-09-30. M1-only follow-up to the
[native receipt](../archive/2026-09-30-aqe-m1-mcp-lock-proof.md).
The maintainer must approve the exact public text and change before publication.
This document does not authorize a fork push, PR, additional dependency installation or dispatch.

Bounded GitHub searches for patterns.rvf shutdown, MCP shutdown and resetSharedRvfAdapter
returned no matching issues. Current upstream main entry blob equals tagged v3.14.6
`202a56d0611cd6b13efd768a6fdb29a3ab948bbc`; its shutdown still omits this reset.
Live npm latest remained 3.14.6 at the check. These are dated, bounded observations.

## Exact proposed issue title

fix: MCP EOF shutdown leaves the shared patterns.rvf lock marker

## Exact proposed issue body

### Summary

Published agentic-qe 3.14.6 on macOS/Node 26.4.0 leaves patterns.rvf.lock after
the real aqe-mcp process shuts down through stdin EOF. The process exits 0,
logs `[MCP] Server stopped`, and does not invoke the shutdown watchdog. The
remaining 104-byte FLVR record names the exited MCP PID.

This is an omitted explicit cleanup observation, not a claim that the PID remains
alive, an OS lock is still held, or data was lost. It requires later stale-lock recovery.

### Reproduction and evidence

1. Initialize a disposable project with the integrity-verified 3.14.6 package
   using aqe init --minimal --auto and private HOME/state/store paths.
2. Launch its actual aqe-mcp bin with piped stdin; complete initialize/tools-list.
3. Confirm patterns.rvf.lock names that MCP PID. Our native fixture was an empty
   162-byte RVF store; discovery exposed 91 tools, without tool/model execution.
4. Run aqe status and the packed kit's ak status --refresh=live --only aqe --json.
   Startup falls back successfully under the live owner, with no FsyncFailed; patterns.rvf and
   sidecar bytes stay unchanged. Semantic backend readiness is a separate result.
5. End stdin and await child close. Exit is 0, signal is null, server stopped
   is logged, no watchdog is logged, but the exited PID's marker remains.

The stock published MCP reproduced the shutdown-marker failure in three private
runs. A direct native shared-adapter holder that explicitly calls close removed
its own marker. All fixtures used private homes/stores and guarded child cleanup.

### Source and proposed correction

The shutdown in [src/mcp/entry.ts at v3.14.6](https://github.com/proffesor-for-testing/agentic-qe/blob/v3.14.6/src/mcp/entry.ts)
resets the shared dual writer but never resets the shared patterns adapter.
Shared pattern-store consumers deliberately leave singleton disposal to the
application lifecycle. The adapter's reset closes its native handle.

Proposed change: statically import resetSharedRvfAdapter and call it after server
drain, alongside the existing dual-writer cleanup. Preserve independent cleanup
attempts; do not manually unlink lock files or change kernel ownership.

Matched original/proposed source-module controls, using the same published module
graph and identical createRequire interoperability shim, reproduced the original
failure and passed with that added reset. These were transpiled source copies;
they were not a normal rebuilt release bundle. Source-mode fleet startup also
reported an unavailable optional attention module, so no general fleet verdict
is inferred. The installed published package was not patched.

Please validate the normal rebuilt package, Windows/Linux, repeated shutdown,
RVF-unavailable startup and unrelated live-owner preservation before treating
the correction as complete. The private control does not establish release readiness.

## Exact prepared source change

Target: tagged v3.14.6 src/mcp/entry.ts. Preserve the existing shared-dual-writer reset.

```diff
 import { initFeatureFlagsFromEnv } from '../integrations/ruvector/feature-flags.js';
+import { resetSharedRvfAdapter } from '../integrations/ruvector/shared-rvf-adapter.js';
@@
       try { const { resetSharedRvfDualWriter } = await import('../integrations/ruvector/shared-rvf-dual-writer.js'); resetSharedRvfDualWriter(); } catch { /* ignore */ }
+      // Shared pattern-store consumers deliberately leave disposal to this lifecycle.
+      // A static reference also closes the singleton in the normally built MCP bundle.
+      try { resetSharedRvfAdapter(); } catch { /* best-effort, retain independent cleanup */ }
```

The complete patch, tagged source and controls are retained in the ignored M1 evidence root.
Normal bundle rebuild, upstream durable regression tests and cross-platform validation
remain required for a fix PR. Approval to file this issue alone would not authorize that PR.
