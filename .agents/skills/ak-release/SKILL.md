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
   `docs/maintainer.md` sections 6 and 7 again if unsure. Section 7's checklist pushes `main`
   directly; the pull request path in step 4 is current practice.
4. `gh run list --workflow=release.yml --limit 3` and `npm view @pacphi/agentic-kit dist-tags`
   to see what shipped last.

## Steps

1. Choose the version with the maintainer, by SemVer and the bump rules in `docs/maintainer.md`
   section 6. Ask whether the next step is an alpha, a beta or an rc (`-alpha.N` and `-rc.N` go
   to `next`, `-beta.N` to the project-scoped `beta` line, a stable version to `latest`); never
   infer it. Confirm with `node scripts/release-dist-tag.mjs <version>` and show the result.
2. Run the suite: `node scripts/run-tests.mjs unit` (the `pnpm test` script; never `pnpm` in a
   worktree). Stop if red.
3. Bump `version` in `package.json`, the only place it lives. Check
   `node bin/agentic-kit.mjs --version` prints it.
4. Release commit `release: v<version>`. Recent releases landed through a pull request because
   `main` requires one: push a release branch and open the PR only after a yes, then hand the
   merge to `ak-ship` (a release PR needs a fresh yes there). Pushing `main` directly needs its
   own yes that names this commit and this branch; a general "direct pushes are allowed" is not
   that yes. A rejected push is reported, never worked around. `ak-ship`'s cleanup may remove
   the release branch's worktree: run step 5 onward from a checkout `ak-ship` is not removing.
5. Verify the commit before tagging, and again right before the tag-push approval:
   `git fetch origin`, then `git rev-parse HEAD` must equal `git rev-parse origin/main` (or tag
   `origin/main` explicitly, as on the pull request path, where HEAD is the release branch).
   Read the version from the commit being tagged, not the working tree:
   `git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version"`
   must print `<version>`, and `git log -1 --format=%s origin/main` must be
   `release: v<version>` or `release: v<version> (#<N>)`, where `<N>` is the release PR a squash
   merge appends. If any differs, stop and report. Never `git checkout main` in a worktree where
   it is held elsewhere.
6. Create the annotated tag on the verified commit, matching exactly:
   `git tag -a v<version> -m "v<version>" origin/main`. Show `git show v<version> --stat` and
   the dist-tag.
7. Tag push, separate approval: name the tag, the commit and the dist-tag, repeat the step 5
   checks, then run `git push origin v<version>` only after that yes. This starts the publish
   (`release.yml` runs `pnpm publish`; you never publish).
8. Watch the publish, separate approval (cheap to give, it only reads):
   `gh run list --workflow=release.yml --limit 5 --json databaseId,headBranch,event,status`.
   Pick the run whose `headBranch` is `v<version>` and `event` is `push`, not an earlier run or
   a `workflow_dispatch` dry run; if none appears yet, wait and list again. Then
   `gh run watch <run-id> --exit-status`. A failure on the tag-version guard or tests published
   nothing; report it and the fix options in `docs/maintainer.md` section 7, and do not move or
   delete the tag without a yes for that exact action.
9. npm check, separate approval (also read-only and cheap): `npm view @pacphi/agentic-kit
   dist-tags` and `npm view @pacphi/agentic-kit@<version> version dist.tarball`. Allow about
   eight minutes after the workflow reports success; a 404 on the tarball inside that window is
   registry lag, not a failed publish, so wait and re-check.
10. `gh release view v<version> --json tagName,isPrerelease` (the workflow creates it; do not
    run `gh release create`). Prereleases must show `isPrerelease` true.
11. Close the release epic and its items in the GitHub Project after a yes per target, with
    `gh issue close <N> --comment "Released in v<version>"`; list the numbers first.
12. Remind the maintainer that the global `ak` is the published npm copy, not the repo: run
    `npm i -g @pacphi/agentic-kit@<dist-tag>`, then `ak sync`. Do not run it unasked.

## Gates

- The release commit push, the tag push, the publish watch and the npm check are each a
  separate approval. A yes to one is not a yes to the next.
- Never run `npm publish`; only the workflow publishes. Never infer the channel; ask.
- Never force-push, never `--force` a tag, never pass `--no-verify` or skip hooks.
- Never delete or move a published tag, `npm unpublish` or `npm deprecate` without a yes naming
  that exact target. A published version is superseded, not republished.
- A false precondition (dirty tree, red tests, stale base, the commit to tag not `origin/main`, tag and version mismatch) stops
  the release with a report. Do not improvise around it.
- No secrets in output; if the workflow reports a bad npm token, tell the maintainer to fix it.

## Done

The tag run is green, `dist-tags` shows the version on the intended tag, the tarball resolves
(or the lag window is stated), the GitHub Release exists with the right prerelease flag, the
approved issues are closed, and the maintainer has the `npm i -g` reminder.
