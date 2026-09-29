# In-flight plans

Plans, specs, and an active program's decision log live here only while their work is open.

- Superpowers writes plans as `YYYY-MM-DD-<feature>.md` and specs as
  `YYYY-MM-DD-<topic>-design.md`. There is no separate specs folder.
- The pull request that finishes the work moves its plan and spec to
  [the archive](../archive/README.md), with one index row per file, using
  `node scripts/docs-relocate.mjs`.
- A program that spans several branches keeps its plan and decision log here until its final
  branch merges.

## Status line

Every file here (plan, spec, or decision log) carries a `## Status` section right after its
title (after the "For agentic workers" blockquote, if it has one) so a maintainer can tell what
is still open without reading the whole file. One of:

- **Active** — work is proceeding, or is queued to start. Say what is queued or in flight.
- **Blocked** — waiting on something outside the file's own branches (a decision, another plan,
  an upstream fix, a verification step). Name the blocker.
- **Superseded** — a later plan replaced this one. Link to it and say what, if anything, of this
  file is still cited by name from elsewhere (so it isn't archived out from under a live link).
- **Done, pending archive** — the work merged; the file moves to `docs/archive/` in the PR that
  notices this and runs `node scripts/docs-relocate.mjs`.

Update the line whenever a branch tied to the file merges or a blocker clears — don't let it go
stale.
