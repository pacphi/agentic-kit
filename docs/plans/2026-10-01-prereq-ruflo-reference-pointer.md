# Prerequisite A: remove the dangling full Ruflo reference pointer

## Status

**Active**, not started. This is a prerequisite of
[Project-scoped management only](2026-10-01-project-scope-only-design.md#prerequisites). It lands
on `main` before P0, so it also ships in the exit release.

**Amended 2026-10-04:** the project skill that takes this content over is the single
`managed-tools` skill, through its Ruflo reference, not a separate per-tool skill (master plan
Decision G15).

## Problem

The managed `ruflo-reference` block tells the agent, in every Claude session on an installed
machine, to read a file that agentic-kit no longer installs. The agent either wastes a tool call
on a missing file or concludes the reference is unavailable.

The block is about 1.7 KB and is rendered from `claude/ruflo-reference.md` into
`~/.claude/CLAUDE.md` whenever Claude is enabled (`src/lib/blocks.mjs:59-66`). It names the file
twice:

| Line | Text |
| --- | --- |
| `claude/ruflo-reference.md:2` | `<!-- Compact pointer; full reference: ~/.config/ruflo/ruflo-reference-full.md -->` |
| `claude/ruflo-reference.md:31` | ``Read `~/.config/ruflo/ruflo-reference-full.md` or run `ruflo <cmd> --help` for`` |

Line 2 is an HTML comment. Claude Code strips block-level comments before injecting `CLAUDE.md`,
so it costs no context, but it misleads maintainers. Line 31 is prose that the agent acts on.

## Evidence

- **Nothing deploys the file.** No code under `src/` writes
  `~/.config/ruflo/ruflo-reference-full.md`. The only code that names it is the legacy shell-kit
  cleanup in `src/commands/uninstall.mjs:540-542`. That code *deletes* a copy left in
  `paths.legacyConfigDir()` (`src/lib/paths.mjs:42`, `~/.config/ruflo`) by the retired shell kit.
- **The pointer only works on old machines.** It resolves only where the shell kit ran and
  `ak uninstall` has not. Every machine set up with the npm kit has a dangling pointer.
- **The source still ships.** `claude/ruflo-reference-full.md` (439 lines) is published through
  `package.json` `files` (the whole `claude/` tree). Its header still claims a deployed copy:
  `claude/ruflo-reference-full.md:6`, "Deployed copy: `~/.config/ruflo/ruflo-reference-full.md`".
- **The dependency-constraint record also names it.** `src/lib/hook-audit/agentic-dependency-constraints.json:907`
  lists the file under `kitImpact` for the retired upstream issue ruvnet/ruflo#2206. That record
  is status `retired`, so the fix does not change it.

## Fix

Remove the pointer, and keep `ruflo <cmd> --help` as the on-demand reference. The full file stays
in the repository as source material.

1. **`claude/ruflo-reference.md`**
   - Line 2: replace the comment with
     `<!-- Compact Ruflo guidance; use ruflo <cmd> --help for commands and flags -->`.
   - Line 31: rewrite to "Run `ruflo <cmd> --help` for commands and flags." The rest of the
     sentence ("Reconcile upgrades with `ak sync`; inspect effective health with `ak status`.")
     stays unchanged.
   - Keep both sentinel lines exactly as they are.
2. **`claude/ruflo-reference-full.md`**
   - Replace the "Deployed copy" line 6 with a statement that the file is not deployed and is the
     source for a future on-demand skill.
   - Do not name `docs/plans/` or any other repository-only path. `tests/kit/docs-layout.test.mjs`
     rejects shipped guidance that names this repository's documentation folders.
3. **Leave the legacy cleanup in place.** `uninstall.mjs:540-542` still removes a shell-kit copy
   where one exists.

Why not deploy the file instead:

- It would add a new user-level write.
- The [project-scope design](2026-10-01-project-scope-only-design.md) removes user-level guidance,
  and turns this content into the Ruflo reference (`ruflo.md`) of the `managed-tools` project
  skill.

A one-line prose fix now is cheaper and makes no change that later has to be reversed.

## Effect on existing machines

- The block's content changes. `ak status` reports `1 CLAUDE.md block(s) drifted:
  ruflo-reference→upserted` until the next `ak sync`. This is the same drift path as any template
  change (`tests/kit/blocks-drift-parity.test.mjs:120-124`).
- `ak sync` replaces the sentinel span in place. Text outside the sentinels is untouched.
- The block gets slightly smaller, so it stays within the `claude` target budget of 12,000 bytes
  (`src/lib/blocks.mjs:37-43`).

## Tests

- **Existing, should keep passing:**
  - `tests/kit/blocks-drift-parity.test.mjs` (drift and upsert of `ruflo-reference`);
  - `tests/kit/opencode.test.mjs:717` (the Claude reference block is not projected into OpenCode);
  - `tests/kit/uninstall-command.test.mjs` (block strip);
  - the status golden fixture `tests/kit/fixtures/status-golden.json:230`, which names drifted
    blocks but not their content.
- **New:** a guard test that reads every template in `claude/*.md` and asserts that none names
  `~/.config/ruflo/`. Shipped guidance must not point at paths the kit does not create.
- **Commands:** `node scripts/run-tests.mjs focus tests/kit/blocks-drift-parity.test.mjs`, then
  `pnpm run lint:md` and `pnpm test`.

## Acceptance criteria

- No file under `claude/` names `~/.config/ruflo/`.
- After `ak sync`, the rendered `ruflo-reference` block in `~/.claude/CLAUDE.md` names only
  `ruflo <cmd> --help`, `ak sync` and `ak status` for further reference.
- The guard test fails if any template reintroduces a pointer to a path the kit does not create.

## Relation to the project-scope design

The design's [Guidance and templates](2026-10-01-project-scope-only-design.md#guidance-and-templates)
section later moves this content into the Ruflo reference (`ruflo.md`) of the on-demand
`managed-tools` project skill, with `ruflo-reference-full.md` as its reference file. This
prerequisite only stops the current line from pointing at a missing file in the meantime.
