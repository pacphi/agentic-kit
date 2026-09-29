# In-flight plans

Plans, specs, and an active program's decision log live here only while their work is open.

- Superpowers writes plans as `YYYY-MM-DD-<feature>.md` and specs as
  `YYYY-MM-DD-<topic>-design.md`. There is no separate specs folder.
- The pull request that finishes the work moves its plan and spec to
  [the archive](../archive/README.md), with one index row per file, using
  `node scripts/docs-relocate.mjs`.
- A program that spans several branches keeps its plan and decision log here until its final
  branch merges.
