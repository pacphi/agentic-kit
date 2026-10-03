---
name: ak-release
description: Cut an agentic-kit release - choose the semantic version and npm dist-tag, bump package.json, make the release commit and annotated tag, watch the publish workflow, verify npm and the GitHub Release, close the tracking items. Use when the maintainer says "release next", "cut an alpha", "cut a beta", "semantic release", "semantic version bump", or "publish a new version".
---

# Release a version

A tag push publishes to npm and cannot be undone, so each outward step below needs its own yes.

## When to use

The maintainer wants a new `@pacphi/agentic-kit` version published. The contents must already be
merged to `main`. This skill does not merge feature PRs (use `ak-ship`).

## Preflight

1. Work in a checkout you own with `git branch --show-current`, `git status --porcelain` and
   `git worktree list`. Never switch branches in a checkout another session uses; if `main` is
   held elsewhere, use a worktree you create. Stop and report if the tree is dirty.
2. `git fetch origin` and confirm the release base equals `origin/main`. Stop if it is behind,
   or if the contents the maintainer expects are not merged.
3. Read the current version: `node -p "require('./package.json').version"`. Read
   `docs/maintainer.md` sections 6 and 7 again if unsure; they are the source of truth.
4. `gh run list --workflow=release.yml --limit 3` and `npm view @pacphi/agentic-kit dist-tags`
   to see what shipped last.

## Steps

1. Choose the version with the maintainer, by SemVer and the bump rules in `docs/maintainer.md`
   section 6. Ask whether the next step is an alpha or a beta (`-alpha.N` goes to `next`,
   `-beta.N` to the project-scoped `beta` line, a stable version to `latest`); never infer it.
   Confirm the tag with `node scripts/release-dist-tag.mjs <version>` and show the result.
2. Run the suite: `node scripts/run-tests.mjs` (never `pnpm` in a worktree). Stop if red.
3. Bump `version` in `package.json`, the only place it lives. Check
   `node bin/agentic-kit.mjs --version` prints it.
4. Release commit `release: v<version>`. Recent releases landed through a pull request because
   `main` requires one: push a release branch and open the PR only after a yes, then hand the
   merge to `ak-ship` (a release PR needs a fresh yes there). If the maintainer says pushing
   `main` directly is allowed, that is its own approval; a rejected push is reported, never
   worked around.
5. With `main` at the merged release commit, create the annotated tag, matching exactly:
   `git tag -a v<version> -m "v<version>"`. Show `git show v<version> --stat` and the dist-tag.
6. Tag push, separate approval: name the tag, the commit and the dist-tag, then run
   `git push origin v<version>` only after that yes. This starts the publish.
7. Watch the publish, separate approval: `gh run list --workflow=release.yml --limit 1`, then
   `gh run watch <run-id> --exit-status`. A failure on the tag-version guard or tests published
   nothing; report it and the fix options in `docs/maintainer.md` section 7, and do not move or
   delete the tag without a yes for that exact action.
8. npm check, separate approval: `npm view @pacphi/agentic-kit dist-tags` and
   `npm view @pacphi/agentic-kit@<version> version dist.tarball`. Allow about eight minutes
   after the workflow reports success; a 404 on the tarball inside that window is registry lag,
   not a failed publish, so wait and re-check.
9. `gh release view v<version> --json tagName,isPrerelease` (the workflow creates it; do not
   run `gh release create`). Prereleases must show `isPrerelease` true.
10. Close the release epic and its items in the GitHub Project after a yes per target, with
    `gh issue close <N> --comment "Released in v<version>"`; list the numbers first.
11. Remind the maintainer that the global `ak` is the published npm copy, not the repo: run
    `npm i -g @pacphi/agentic-kit@<dist-tag>`, then `ak sync`. Do not run it unasked.

## Gates

- The release commit push, the tag push, the publish watch and the npm check are each a
  separate approval. A yes to one is not a yes to the next.
- Never run `npm publish`; only the workflow publishes. Never infer the channel; ask.
- Never force-push, never `--force` a tag, never pass `--no-verify` or skip hooks.
- Never delete or move a published tag, `npm unpublish` or `npm deprecate` without a yes naming
  that exact target. A published version is superseded, not republished.
- A false precondition (dirty tree, red tests, stale base, tag and version mismatch) stops
  the release with a report. Do not improvise around it.
- No secrets in output; if the workflow reports a bad npm token, tell the maintainer to fix it.

## Done

The tag run is green, `dist-tags` shows the version on the intended tag, the tarball resolves
(or the lag window is stated), the GitHub Release exists with the right prerelease flag, the
approved issues are closed, and the maintainer has the `npm i -g` reminder.
