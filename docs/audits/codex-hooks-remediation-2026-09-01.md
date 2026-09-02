# Codex Hooks Remediation Plan — 2026-09-01

Related: [audit](codex-hooks-audit-2026-09-01.md),
[inventory](codex-hooks-inventory-2026-09-01.json), and
[ADR-0040](../adr/0040-codex-hook-audit-and-conservative-remediation.md).

## Safety envelope

Every action starts as a preview. `--yes` may confirm disclosed actions but must never
expand them. No action may modify Codex project or hook trust, write plugin cache, infer an
authoritative source from a generated copy, or run an uninspected hook command.

## Action plan

| ID | Priority | Action | Target owner | Class | Completion proof |
|---|---:|---|---|---|---|
| H01 | P0 | Add manifest/action compatibility preflight so every Brain manifest action exists in the selected active runtime | RuvNet Brain installer/runtime | approval required upstream | 4.2.2 manifest + active runtime agree; unknown action fails visibly; decision-gate/snapshot integration tests pass |
| H02 | P0 | Stop describing project `pre-bash` as enforcement; replace with a Codex-native fail-closed result only if a reviewed owner still needs it | historic Ruflo generator/current canonical owner | approval required | malicious fixture is blocked using documented contract; advisory failures cannot claim enforcement |
| H03 | P1 | Keep the OpenAI Companion SessionEnd timeout fix in its authoritative Claude Code plugin source; locally disable that companion if it is mistakenly enabled inside Codex | openai/codex-plugin-cc / machine owner | upstream fix plus approval-required local placement repair; cache never automatic | Claude Code keeps the companion; Codex config says `enabled = false`; fresh Codex session emits no clamp |
| H04 | P1 | Resolve the historical project copier, then preview retirement of obsolete Ruflo project groups in nine projects | Ruflo/AQE generator and each project owner | approval required per project | transaction backup, exact diff, current plugin behavior retained, second audit removes duplication/clamp |
| H05 | P1 | Remove Emailibrium's local Beads projection or disable the plugin for that project, after choosing one owner | Emailibrium owner / Beads | approval required | one occurrence per Beads lifecycle event; behavior smoke test passes |
| H06 | P1 | Replace `CLAUDE_PROJECT_DIR`/`$HOME` shell fallback with a stable validated repository-root contract | authoritative generator | approval required | subdirectory fixture resolves the same regular in-repo helper; path escape/symlink tests fail closed |
| H07 | P1 | Convert every generated Codex timeout from the source host's units to seconds and validate event-specific bounds | Ruflo/AQE Codex generator | approval required upstream | schema tests cover every generated event; no millisecond-style seconds remain |
| H08 | P2 | Remove or implement the five unknown-success project actions | canonical Ruflo owner | approval required | no no-op process launches; manifest and handler tables have bidirectional coverage |
| H09 | P2 | Remove unpinned `npx ... ruflo@latest` fallback from hook-time execution or pin/verify an installer-owned executable | ruflo-core | approval required upstream | offline/missing-CLI case fails visibly without network/package execution |
| H10 | P2 | Give Agentic-QE's Codex installer transaction backups, ownership receipts, verify, and undo | Agentic-QE / agentic-kit integration | approval required upstream | failure injection proves no silent partial merge; rollback preserves later user drift |
| H11 | P2 | Align Desktop and shell Codex CLI versions for reproducible diagnostics | machine owner | approval required | `PATH` and bundled versions are intentionally documented/aligned |

## What agentic-kit may do automatically

Only a semantics-preserving change to a proven agentic-kit-owned canonical source, under
a verified version schema and exact preimage receipt, may be automatic. No current
finding qualifies.

## What always requires approval

- modify any user-owned authoritative hook definition;
- change a command, matcher, order, environment, side effect, or timeout in a way that
  changes the reviewed definition;
- remove a duplicate or stale behavior;
- run a benchmark whose implementation can write, use network/credentials, spawn a
  model/background job, or control processes;
- apply across more than one project;
- modify an upstream Ruflo, Agentic-QE, Brain, Beads, or OpenAI source/installer.

## What is never automatic

- edit `~/.codex/plugins/cache` or marketplace staging copies;
- edit `[hooks.state]`, `trusted_hash`, project trust, or use a trust bypass;
- rewrite generated copies while an authoritative source exists;
- guess ownership from similar content;
- heal against an unknown/future schema;
- follow symlinks or touch special files;
- delete behavior merely because it is slow, duplicated, stale-looking, or untrusted.

## Transaction and rollback design

Each approved apply operation must record target path, canonical owner, action ID,
expected preimage digest, desired digest, file mode, unified diff, trust impact, and
verification. Before the first write, copy exact bytes/mode into a unique transaction
directory under agentic-kit's config directory. Recheck all preimages, use random
exclusive temporary files and atomic rename, then verify schema/effective behavior.

Rollback is allowed only when the current digest still equals the transaction postimage.
If a user or another generator changed the file afterward, preserve that drift and stop.

## Implemented wave

Wave 1 adds only the read-only `ak audit hooks` command and durable baseline artifacts.
It never executes a hook or exposes an apply flag. It validates version confidence,
nested syntax, exact occurrence IDs, plugin-cache containment, and symlink boundaries;
hook-discovery failures are distinct from unrelated plugin skill diagnostics.
At publication on 2026-09-01, transactional apply/rollback was deferred pending
independent architecture review and resolution of the canonical owners for H01–H10.
The 2026-09-02 follow-up implements that bounded transaction engine and adds an
exact-identity H03 placement repair. It mutates only the reviewed Codex `config.toml`
scalar, never the companion's cache, installation, Claude Code state, or upstream source.
