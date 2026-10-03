---
name: ak-docs-gate
description: Run the agentic-kit docs completion gate - check the documentation layout rules, archive finished plans and specs, and confirm living guides match a code change. Use when the maintainer says "docs gate", "docs alignment", "docs check", "are the docs aligned", or "archive the finished plan".
---

# Docs gate

## When to use

A code or docs change is about to be called done, or the maintainer asks for the docs gate. The gate
has two halves: the layout rules, which a test enforces, and alignment, which only reading can check.

## Preflight

1. `git branch --show-current`, `git status --short` and `git worktree list`. Work in the checkout
   this session owns; never write to a checkout another session uses. Never run `pnpm` in a
   worktree: use `node scripts/run-tests.mjs` and `node_modules/.bin/*`.
2. `git diff --name-only main...HEAD` plus uncommitted files: the change under review. If there is
   no change and no named plan, stop and ask what to check.

## The rules (AGENTS.md and CLAUDE.md, "Documentation layout")

- Markdown file names are lower case. Only `README.md`, `CLAUDE.md`, `AGENTS.md` and `SKILL.md`
  keep capitals.
- Never create a folder under `docs/`. Plans go to `docs/plans/YYYY-MM-DD-<feature>.md`, specs to
  `docs/plans/YYYY-MM-DD-<topic>-design.md`, never `docs/superpowers/`. Dated audits and evidence go
  straight to `docs/archive/`; dormant proposals go to `docs/proposals/`.
- Never move an ADR. Nothing under `docs/adr/` is archived, renamed or deleted.
- Top-level `docs/*.md` files are living guides. Each is listed in `docs/README.md` and carries
  current state only. History stays in ADRs. A retired command gets no alias and no hint in a guide;
  the old-to-new mapping goes in the PR body and release notes only.
- `docs/plans/README.md` defines the `## Status` section every plan or spec carries: Active,
  Blocked, Superseded, or Done, pending archive.

## Steps

1. Layout: `node scripts/run-tests.mjs focus tests/kit/docs-layout.test.mjs`. Each failure names
   the file and the fix (`layoutProblems` in `scripts/docs-layout.mjs` is the source of the rules; it
   has no CLI). A fail is a FAIL. Do not edit the test or the script to make it pass.
2. Alignment: for each changed behavior (command, flag, path, setting, output, default), search the
   guides, README, AGENTS.md and the packaged templates for the old and new wording
   (`git grep -n` on the literal). Update each doc the change touches so it states the new current
   state only. A code change is not complete until the docs it touches are aligned; list the docs
   checked, even when none needed edits.
3. New or renamed guide: it is listed in `docs/README.md` in the same change.
4. ADRs: if an ADR describes behavior the change alters, do not edit it. Name the ADR and the claim,
   and ask whether to update its status and date. Edit only after a yes.
5. Plans and specs: read the `## Status` of each file in `docs/plans/`. For a "Done, pending archive"
   file (or one the maintainer names), check it is not still cited by name from a live doc
   (`git grep -n <file name>`; a Superseded file stays while cited). Then propose the move:
   - Write a map file OUTSIDE the repository (for example in the scratchpad): one row per file,
     the source path, a tab, the archive path. A plan `docs/plans/<date>-<topic>.md` becomes
     `docs/archive/<date>-plan-<topic>.md`, and a spec `docs/plans/<date>-<topic>-design.md`
     becomes `docs/archive/<date>-design-<topic>.md`: the name is
     `YYYY-MM[-DD]-<origin>-<topic>.<ext>`, with the origins under "Naming convention" in
     `docs/archive/README.md`. The destination must not exist.
   - Preview: `node scripts/docs-relocate.mjs --map <map file> --mentions --dry-run`. It writes
     nothing. It prints each path mention it would rewrite, a count of the Markdown links it would
     rewrite and in how many files, and links that are already broken. `--bare` also rewrites bare file names; use it only if the dry run shows it is needed.
   - Show the maintainer the rows and the dry-run output, and ask for a yes that names the files.
     A move is a write that rewrites links in other files; a general permission is not a yes.
   - After the yes, run the same command without `--dry-run`, then add one row per file to
     `docs/archive/README.md` (see its existing rows for the format). Re-run step 1.
   - Re-read `git status --short` and `git diff --stat`: only the named moves, link rewrites and the
     index rows may appear. Report anything else.
6. Markdown lint on the touched files: `node_modules/.bin/markdownlint <files>`. This is the
   worktree form of `pnpm run lint:md`; use the pnpm script only in the main checkout, if it is yours.

## Gates

- Never move an ADR, and never move or rewrite any file before the maintainer's yes naming the files.
- Never create a folder under `docs/`; if a doc has no home, ask.
- Never delete a doc. Archiving is a move, and it keeps one row per file in `docs/archive/README.md`.
- Never edit an ADR silently; ask whether to update its status and date.
- Never commit, push or open a PR from this skill; hand the diff back.
- Never `pnpm` inside a worktree; use `node scripts/run-tests.mjs` and `node_modules/.bin/*`.
- A skipped check is reported as skipped, never as passed.

## Done

The layout test passes, every doc the change touches is aligned and listed in the report, any approved
archive move is verified with its index rows, markdownlint is clean, and open questions (ADR updates,
plans left Active or Blocked) are named for the maintainer.
