# Plugin and memory status follow-up

Observed 2026-09-09. Scope: agentic-kit diagnostics and evidence only; no external
plugin edits, changes to existing memory stores, migrations, or consolidation.
Concurrent Ruflo workers continued writing during the memory inspection.

## Plugin compatibility

Installed Codex CLI: 0.153.4. A temporary stdio app-server client initialized,
called `skills/list` with `forceReload: true`, and terminated without starting
an inference turn. It returned no skill errors and enabled entries for
`spreadsheets:Spreadsheets`, `presentations:Presentations`, and
`spreadsheets:excel-live-control` from `openai-primary-runtime` 26.905.11957.

Agentic-kit's old validator emitted four issues: directory mismatch and
lowercase-name rejection for each of the first two entries. The repaired
validator accepts nonempty display names up to 64 Unicode characters. A live
recheck found 24 enabled plugins, zero skill issues, and zero hook issues.

Upstream source inspected at Codex revision
`2617ed2e1c4b9fb59a9058fe28a8f9e78bc81878`:
`codex-rs/ext/skills/src/loader/mod.rs` defines `MAX_NAME_LEN = 64`, and
`loader/metadata.rs` validates nonempty names by Unicode character length.
[Official skill documentation](https://learn.chatgpt.com/docs/build-skills)
describes required frontmatter and discovery. No plugin cache repair is needed.

## Memory routing

Installed Ruflo and `@claude-flow/cli`: 3.39.2. Read-only SQLite inspection
compared active `(namespace, key)` pairs, without emitting values:

| Observation | Count |
| --- | ---: |
| `memory.db` distinct active keys | 51 |
| `agentdb-memory.db` distinct active keys | 16,671 |
| Shared keys | 1 |
| Only in `memory.db` | 50 |
| Only in `agentdb-memory.db` | 16,670 |

Counts are observations from an active installation, not a frozen migration
snapshot. The second store grew during inspection. Both stores have compatible
`memory_entries` columns, including `status` and `provenance_type`. The known
synthetic audit-result key exists only in the sibling store. This establishes
separate corpora; it does not establish value equality for the shared key.

Installed CLI source, relative to `@claude-flow/cli/dist/src/`:

| Location | Evidence |
| --- | --- |
| `commands/memory.js:279` | CLI resolves and passes `dbPath` to retrieval. |
| `memory/memory-initializer.js:149` | Explicit path, then `CLAUDE_FLOW_DB_PATH`, then memory-root default. |
| `mcp-tools/memory-tools.js:383` | MCP calls retrieval without `dbPath`. |
| `memory/memory-initializer.js:3009` | Options pass to the native bridge. |
| `memory/memory-bridge.js:1228` | Bridge passes optional path to its registry. |
| `memory/memory-bridge.js:168` | Registry uses explicit path or `getAgentDbPath()`. |
| `memory/memory-bridge.js:127` | Default native filename is `agentdb-memory.db`. |
| `memory/memory-initializer.js:103` | Native root reads memory-path environment/JSON configuration, not the compatibility DB filename variable. |
| `memory/memory-bridge.js:1278` | Retrieval updates access metadata; it is not a read-only forensic probe. |

Agentic-kit's `src/lib/ruflo-memory.mjs` pins project cwd and the compatibility
path; changing that alone cannot repair upstream's conflicting path contracts.
The status fix uses filenames rather than claiming a backend from a filename,
and supplies explicit targeting/preservation guidance. The warning remains
because the underlying split remains unresolved.

Upstream remediation: centralize resolved path identity across CLI, MCP and
backend selection; key native registries by resolved path; test cross-process
CLI-to-MCP-to-CLI behavior with disjoint preexisting corpora, custom paths,
native-disabled mode, and encryption; expose a read-only route/peek operation.
Existing stores need separately reviewed migration, not an automatic rename.
The exact existing report is [Ruflo #3196](https://github.com/ruvnet/ruflo/issues/3196).
A [3.39.2 confirmation](https://github.com/ruvnet/ruflo/issues/3196#issuecomment-5606621769)
adds system versions, discovery details, the isolated reproduction, and proposed
acceptance criteria. No duplicate issue or upstream code patch was submitted.

## Validation

Regression tests cover accepted capitalized/different-directory names, Unicode
length boundaries, file-based memory labels, and preservation/targeting guidance.
Live Codex loader and repaired agentic-kit inspection agree for the reported
bundled skills. Memory facts came from read-only SQLite and installed source;
no CLI/MCP retrieval was used as a supposedly read-only probe.

## Follow-through

Agentic-kit tracking issue: [upstream integration plan](https://github.com/pacphi/agentic-kit/issues/213). It records
release verification, isolated candidate testing, path-identity regression cases,
existing-corpus preservation and rollback, and closure criteria. A closed upstream
issue is not sufficient evidence to remove this warning.

The [isolated reproduction](ruflo-memory-route-repro.mjs) and
[recorded result](ruflo-memory-route-results.jsonl) use fresh processes, real
installed MCP handlers and CLI-shaped storage calls. Both directional default
lookups miss the other store; an explicit sibling lookup succeeds. This tests
path selection independently of the singleton defect, without claiming full
stdio-transport coverage. All writes are to a disposable temporary corpus.

Final combined checks: 3,908 unit tests passed, six platform skips, zero failures;
coverage 92.02% lines, 80.89% branches, 91.58% functions. The earlier full browser
run passed 491 assertions and six suites. Subsequent changes affect backend
status text/plugin validation and documentation; focused status/plugin tests pass.
