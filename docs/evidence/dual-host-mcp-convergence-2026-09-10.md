# Dual-host MCP provisioning and recurrence evidence

Date: 2026-09-10. Baseline agentic-kit commit: `2fffecd`.
Initial validation branch: `fix/dual-host-mcp-convergence`.
Environment: macOS, Node 26.4.0; installed Ruflo and underlying CLI 3.41.1.

## Upstream findings

- Claude CLI initialization uses `claude-flow`; Codex uses `ruflo`. These are
  separate host bindings, not two independent capabilities.
- Ruflo's normal Claude MCP initializer avoids adding either alias when one is
  already present. `--force` deliberately bypasses that guard.
- The installed Codex registration function recognizes the name `ruflo` only;
  an inventory containing `claude-flow` running Ruflo triggers another add.
  The check also exists in upstream main
  `a64f8b1ad89035c8b204f8b6e0893a2288551e06`.
- Upstream [#2612](https://github.com/ruvnet/ruflo/issues/2612) tracks the closed
  Claude alias issue. [#2640](https://github.com/ruvnet/ruflo/issues/2640) remains
  the related plugin-versus-standalone duplication report.

The upstream characterization called unmodified installed provisioning functions
in a temporary directory. Host configuration reads and Codex subprocess responses
were controlled fixtures; no real MCP server was launched. It establishes the
registration decision, not an end-to-end fresh package installation.

## Agentic-kit findings

Current setup suppresses upstream Codex autodetection and separately provisions
`ruflo` through `ak x ruflo-mcp`. No inspected setup, sync, native executable
wrapper, or current npm postinstall was shown to create Codex's historical
`claude-flow` entry. Its original writer remains unidentified.

Two repeatable local defects were established before the fix: final sync could
report convergence despite an unresolved duplicate warning, and no repair pass
covered a duplicate restored by later provisioning. Setup had the same missing
final verification. The tests failed against baseline for those behaviors.

## Executable regression evidence

`tests/kit/codex-mcp-convergence.test.mjs` exercises real setup/sync orchestration,
topology detection, backup/fingerprint repair, consent persistence, and provider
registration using temporary files. Native host commands and package/initializer
side effects are replaced only at external boundaries.

Scenarios cover fresh and repeated provisioning, explicit consent, later
restoration of the same alias, declined repair, custom environment preservation,
same-run initializer restoration, missing replacements, failed removals,
machine-only setup, upstream npx recognition, unresolved recursion, and mismatched
Codex home. Recreated aliases are injected faults, not evidence identifying a
real-world writer. No blanket protection against outside configuration writers
is claimed.

## Validation results

- New convergence suite: 14 passed; focused integration/repair/setup/sync suites:
  86 passed before the final fresh-host fixture extension, which also passed.
- Full `pnpm test`: 3,928 passed, six existing skips, zero failures in the
  coverage-enforced suite; all subsequent legacy suites passed.
- Coverage: 92.01% lines, 80.91% branches, 91.55% functions.
- Typecheck, lint, complexity gate, Markdown lint, and build passed. Lint emitted
  warnings but no errors.
- Integrated source matched the tested isolated worktree; 31 convergence and
  repair tests passed again in the working checkout.
- Native correction removed the inspected user-scope legacy alias after a
  current-state backup. Codex's native inventory then showed only the enabled
  `ruflo` connection using `ak x ruflo-mcp`. A second reconciliation made no
  change and asked no question. The current session's already-loaded tool
  inventory is separate from this on-disk result.

The local configuration correction did not submit an upstream issue or publish a
package. Implementation integration follows the separately authorized PR workflow.
