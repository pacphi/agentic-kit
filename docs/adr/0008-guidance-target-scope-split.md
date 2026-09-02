# ADR-0008 — Machine-scoped guidance blocks land in machine files, not a repo's AGENTS.md

- **Status:** Implemented
- **Date:** 2026-07-24
- **Updated:** 2026-09-02
- **Update note:** ADR-0023 made machine-guidance backups fail-closed and replacement atomic. Project
  setup now also preserves user-authored guidance, migrates the old unsentineled lean stub, and
  converges duplicate agentic-kit sentinels idempotently.
- **Deciders:** agentic-kit maintainers

## Context

`ak` renders managed sentinel blocks into guidance files via the registry in
`src/lib/blocks.mjs`. Each registry row carries `guidanceFiles` — logical target names —
and `sync`/`status` loop those targets, resolving each to a path. Until now there were two
targets, and both `src/commands/sync.mjs` and `src/commands/status.mjs` carried the **same
literal list**:

- `claude` → machine-wide `~/.claude/CLAUDE.md`
- `agents` → the **project's** `<cwd>/AGENTS.md`

Exactly one row targeted `agents`: `ruflo-dual-mode-reference`, gated on
`bothHostsEnabled(cfg)` (both `claude` and `codex` enabled in `kit.json`). Its content is
**machine state** — "this machine runs dual-host, here is the bridge and the routing." A
project's `AGENTS.md` is checked into git. So `ak sync` on a dual-host machine wrote a
machine truth into a repo's shared history — and it did: commit `371da30` committed the
dual-mode block into this repo's own `AGENTS.md`. The leak is invisible from the repo root
and rides along in every clone.

Codex reads a **user-level** guidance file at `~/.codex/AGENTS.md` (ak's host adapter
already models codex's guidance surface, `src/lib/hosts.mjs`). That is the correct home for
machine-scoped guidance destined for the codex host: same scope (the machine), same
lifecycle (`kit.json` enablement), never in a repo. `~/.codex` exists on machines where
codex is installed and **must never be created by ak** — its existence is itself the signal
that codex is present.

## Decision

### 1. A third logical target: `agents-user` → `~/.codex/AGENTS.md`

Machine-scoped guidance for the codex host lands in codex's **machine-wide** file, mirroring
how `claude` guidance lands in `~/.claude/CLAUDE.md`. The `ruflo-dual-mode-reference` row
moves to `guidanceFiles: ['claude', 'agents-user']` — machine content in machine files. The
project `agents` target **stays** for genuinely repo-scoped rows (there are none in the
built-in registry today; custom `kit.json` rows may still opt in), and — critically — for
**strips** (Decision 3).

### 2. One shared `guidanceTargets({ cwd, cfg })` helper — the duplicated list is gone

Both commands now call `guidanceTargets` in `blocks.mjs`; the two literal lists that could
silently disagree are replaced by one source of truth. `agents-user` is included **only when
`~/.codex` (the directory) already exists** — a dir-exists gate, never a `mkdir`. That single
gate covers both cases correctly:

- a codex machine that is momentarily single-host still gets the target, so a stale block can
  be **stripped** after dual mode is disabled;
- a codex-less machine never grows a `~/.codex` and sees zero new writes (NFR-1).

### 3. Re-scoped blocks are force-stripped from files they left — `retiredForTarget`

Moving a block between targets is a migration: the old file still carries the sentinel. For
each target, `sync`/`status` pass `syncBlocks` both `blocksForTarget(rows, name)` (rows that
belong) **and** `retiredForTarget(rows, name)` (rows that do **not** belong, each rewritten
with a detector that never fires). A retired row that is *present* is stripped; *absent* is a
no-op. Using a never-firing detector — rather than the row's real detector — is load-bearing:
the dual-mode row's live `flag` detector would otherwise **re-upsert** the block into the
very project `AGENTS.md` we are trying to clear whenever dual mode is on. This is the
mechanism that removes the leaked block (from `371da30`) on the next `ak sync` in this repo.

### 4. Backup parity and no spurious writes

`~/.codex/AGENTS.md` gets the same fail-closed one-time `.bak`-before-first-rewrite contract as
`~/.claude/CLAUDE.md`. `syncBlocks` writes only when content actually changes, so a
single-host codex machine (dual block not wanted, nothing present) yields **no file and no
backup** — the target is discovered but nothing is written. Replacements use a same-directory
temporary file plus atomic rename; a missing backup must be created successfully before replacement.

### 5. Project setup preserves foreign guidance and converges owned blocks

`ak setup --project` applies the same scope rule to project guidance that sync applies to machine
guidance: prose outside an agentic-kit sentinel is foreign content. Setup captures pre-init
`CLAUDE.md` and `AGENTS.md` bytes before Ruflo runs, then reconciles the owned projection twice—once
before Agentic-QE compatibility work and once after it—so an upstream initializer cannot silently
become the last writer.

| Prior project state | Result |
| --- | --- |
| Neither guidance file exists | Create the bounded project guidance required by the enabled integrations. |
| User-authored `CLAUDE.md` exists | Preserve that prose byte-for-byte outside sentinels and reconcile only agentic-kit-owned blocks. |
| Only user-authored `AGENTS.md` exists | Preserve it and create a one-line `CLAUDE.md` containing `@AGENTS.md`, avoiding a second equivalent instruction body. |
| Previous agentic-kit managed block exists | Replace its complete sentinel span in place; a second run is byte-idempotent. |
| Duplicate complete agentic-kit blocks exist | Collapse them to one canonical block; never delete text outside complete matching sentinels. |
| Old unsentineled agentic-kit lean stub exists | Recognize that exact prior-art shape and migrate it to the managed form. A near-match remains user-owned. |

Removal follows the same authority boundary: disabling an integration removes only its complete
sentinel-owned content. A missing end sentinel is not repair authority. Agentic-QE's distinct
`BEGIN AGENTIC-QE CODEX` block remains upstream-owned, and the bounded compatibility guard around
it is not permission to rewrite arbitrary AQE guidance.

Ruflo setup is invoked with supported suppression flags (`--no-global`, `--no-codex-detect`, and
`--no-skills-sh`) so project setup does not recreate redundant machine guidance or unrelated skill
shell projections. This reduces overlap where the upstream CLI provides a supported switch; it
cannot prevent every future upstream version from introducing a new, differently owned projection.

## Consequences

- Machine truths stop leaking into shared git history. A dual-host machine writes the
  dual-mode block to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`; a repo's checked-in
  `AGENTS.md` is never a target for it.
- The next `ak sync` in *this* repo strips the previously-committed dual block from
  `AGENTS.md` — a follow-up commit that is expected and desired, not a regression.
- Other machines self-heal: their next `ak sync` strips any project-`AGENTS.md` copy they
  carry. No cross-repo migration tooling is needed.
- `sync` and `status` can no longer disagree about targets — they read the same helper.
- No behavior change on machines without `~/.codex`: same rows, same files, zero new writes.
- Project setup no longer treats an upstream force-init result as authority to discard pre-existing
  user guidance; re-runs converge owned blocks and preserve foreign text.
- Out of scope: aqe-init's own `AGENTS.md` sentinel (a different manager) and any
  `~/.codex/config.toml` changes — this ADR is only about the guidance-block registry.

## Alternatives considered

- **Keep the dual block in the project `AGENTS.md`.** Rejected: it is machine state, and a
  project file is committed — the leak is the whole reason for this record.
- **Gate `agents-user` on `bothHostsEnabled(cfg)` instead of `~/.codex` existing.** Rejected:
  a single-host codex machine must still be able to *strip* a stale block, and gating on
  enablement would skip the target exactly when a strip is needed. Dir-existence is the
  gate that makes both the write and the strip paths correct.
- **`mkdir ~/.codex` when absent.** Rejected: `~/.codex` is codex's home; ak creating it
  would fabricate a codex install on a machine that has none.
- **Give retired rows their real detector.** Rejected: a live `flag` detector would re-upsert
  the block into the file we are clearing. Retired rows must be unconditional strips.

## References

- `src/lib/blocks.mjs` (`guidanceTargets`, `retiredForTarget`, the re-scoped row, the
  `.bak` mechanism), `src/lib/paths.mjs` (`codexDir`/`codexAgentsMdPath`),
  `src/commands/sync.mjs` + `src/commands/status.mjs` (target loop), `src/lib/hosts.mjs`
  (codex guidance surface).
- Spec: `sparc/spec-agents-user-target.md` (Phase 1).
- The leak: commit `371da30` ("chore: sync heals AGENTS.md dual-mode reference block").
