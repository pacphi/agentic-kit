# Ruflo audit remediation: first pass

This follows the [cross-host audit](2026-09-09-ruflo-cross-host-alignment.md).
PR #207 was squash-merged as `8dc6924`; this work branched from that main revision.

## Repository changes

- Detect effective duplicate Codex Ruflo transports even with environment tables,
  aliases, or layered configuration. Automatic removal still requires the existing
  strict ownership match; detection does not grant deletion authority.
- Report release observations per package, distinguishing live, cached, and failed
  refresh fallback. Historical cache entries with no timestamp disclose that gap.
- Inspect Claude's selected user-scope Brain plugin, independently of its marketplace
  and KB versions. Report missing commands, ambiguous payloads, and hook declarations
  outside the audited 4.3.16 baseline. Static inspection does not prove execution.
- Bind the blocked Ruflo release constraint to actual release evidence, using schema 4
  rather than an unrelated issue reference.

## Machine remediation and evidence

Configuration preimages are retained under the local agentic-kit backups directory,
in `ruflo-audit-remediation-20260909`. No memory databases were reset or migrated.

| Action or proof | Result |
| --- | --- |
| Exact Ruflo upgrade | 3.39.0 to 3.39.2; resolved fast-uri 3.1.7 |
| `ak sync --no-upgrade --yes` | Exit 0; repaired aidefence and native bindings, refreshed OpenCode projection and Claude footer |
| Codex duplicate removal | Backed up config; removed user `claude-flow` with native CLI after confirming its sole browser environment setting matches the canonical launcher |
| Fresh canonical Ruflo MCP discovery | Ready, 356 tools; initialize 76 ms, total 80 ms |
| Isolated memory proof after healing | Store/retrieve exact value and on-disk compatibility-store row passed; temporary namespace purged |
| Existing native corpus proof | Known native AgentDB row present, but CLI retrieve returned exit 1; unresolved |
| Exact Brain installer | KB 4.3.16 installed with signature validation; source-grounded search verified in 121.8 seconds |
| Claude Brain plugin update | Native plugin update moved selected payload from 0.5.0-dev to 4.3.17 |
| Codex Brain plugin | Installer reported installed and enabled at 4.3.16; existing sessions require restart |

The Brain installer exited 1: the marketplace advanced to 4.3.17 during this work.
That payload explicitly declares bounded SessionStart and Stop continuity hooks,
while the 4.3.16 installer requires zero automatic registrations. The hooks were
preserved. This is a version-contract mismatch, not proof that the new hooks are
unintended. The selected 4.3.17 payload now includes `commands/rvbc.md`.

## Remaining work

1. Qualify Brain 4.3.17's continuity contract and align installer, KB, and both host
   projections. Release metadata was published at 2026-09-09T14:11:20Z:
   <https://github.com/stuinfla/ruvnet-brain/releases/tag/v4.3.17>.
2. Correct existing-corpus routing and strengthen memory health reporting. Native
   dependency presence and an isolated canary do not prove access to existing data.
   Windows split-store behavior still needs platform-specific validation.
3. Run fresh host execution checks after restarting Claude and Codex. A live session
   can retain an old tool catalog; no measured context-token reduction is claimed.
4. Retain the audit's unresolved upstream constraints and unrelated user plugin
   warnings. A fresh release check also observed OpenCode 1.18.30; this pass kept
   installed 1.18.29 rather than qualifying another runtime incidentally.

## Validation

Full suite at `5235721`: 3,772 tests, 3,766 passed, six skipped; coverage 91.88%
lines, 80.55% branches, 91.34% functions. Typecheck, Markdown lint, complexity
gate, and build passed. The final Brain warning wording was checked with its
seven focused tests. Independent source review found no remaining blockers.

Eight proven-merged local branches and 23 stale worktree metadata records were
removed. Existing worktree files, archives, and branches with uncertain merge
status were preserved. Dashboard project grouping remains queued and unstarted.
