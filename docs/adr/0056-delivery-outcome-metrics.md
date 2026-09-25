# ADR-0056 — Delivery outcome metrics: what shipped, next to what it cost

- **Status:** Proposed — nothing here is implemented
- **Date:** 2026-09-21
- **Updated:** 2026-09-21 — Delivery is now its own dashboard area with four views, not a section
  of the Scorecard; who reads which view follows [ADR-0057](0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md).
  Consent, metric, exclusion, GitHub-tier and export decisions are unchanged.
- **Related:** [ADR-0057](0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0035](0035-managed-deja-vu-companion.md),
  [ADR-0038](0038-consistent-cross-host-session-metrics.md),
  [ADR-0046](0046-scan-local-observation-reuse-and-nonblocking-deep-scans.md),
  [ADR-0050](0050-dashboard-project-identity-and-context-reporting.md),
  [ADR-0054](0054-fleet-evidence-export.md), and the
  [managed-tools contract](../MANAGED-TOOLS.md)

## Context

The Usage Scorecard answers what a window cost and how it was spent: sessions, tokens,
API-equivalent cost, engaged time, autonomy, cost per session and per engaged hour. Every figure
comes from local transcripts. Nothing states what the work produced. The question people ask
about AI assistance is about lift and velocity: how much shipped, how quickly, at what cost, and
whether quality held. Managers ask whether output justifies cost, developers ask where their own
time goes, finance asks how a dollar figure was reached, and architects ask which stacks and
modules the work lands in. Outcome data serves several of those readers, which is why Delivery
gets its own area rather than a strip on the page that answers the spend question.

The pieces to answer it mostly exist. The Scorecard already takes a `?days=N` window (default 14)
and compares each tile with the previous equal-length window. ADR-0050 resolves working
directories to repositories through the Git common directory, so linked worktrees fold into one
repository. `stack-detect.mjs` already defines "code the user wrote" (`EXCLUDED_DIRS`,
`EXCLUDED_FILES`), and `stack-registry.mjs` states that lines belong to languages and that an
unmapped extension is never counted. ADR-0054 already exports per-installation snapshots for
later aggregation. What is missing is any read of git history, any GitHub-derived fact, and a
consent model for either.

Three constraints shape the design:

- Telemetry works without a network connection and uploads nothing (`docs/TELEMETRY.md`). GitHub
  facts such as CI results and exact PR counts need a network call, so they cannot be
  default behavior.
- ADR-0054 snapshot schema v1 has an exact field set. Unknown fields are rejected, repository
  labels are deliberately absent, and copies of the same activity on two installations "cannot be
  deduplicated automatically." Git history breaks that last assumption: the same repository
  cloned on two machines contains the same commits.
- ADR-0023 requires unknown to stay unknown. A repository with no GitHub remote is not a 0% CI
  rate.

## Decision

### 1. Two consent tiers, both opt-in

| Tier | Reads | Network | Default |
| --- | --- | --- | --- |
| **Local** | Git history of repositories that had a session in the window | None | Off |
| **GitHub** | CI runs, PRs, releases through the user's own `gh` sign-in | Repository names and date ranges to GitHub only | Off |

The GitHub tier requires the Local tier. Both are chosen during `ak setup` and can be turned on
or off afterward from the dashboard or the CLI. The choice is stored as intent in `kit.json`
(`delivery.local`, `delivery.github`, and per-project exclusions), never a credential. Turning a
tier off stops reads and clears that tier's cache. With both off, the dashboard shows a card
that says what enabling would read and keep.

Local reads are read-only, use argument vectors with no shell, and pass `--no-ext-diff
--no-textconv`. Only counts are retained. Commit messages, file names, branch names and author
addresses are used transiently for classification and never stored.

### 2. Scope: which repositories and which commits

- **Repositories.** Every repository that had at least one session in the selected window, found
  through ADR-0050 identity. Linked worktrees fold into their repository. Independent clones
  stay separate. A session in a Git submodule resolves to the submodule's own repository.
  Folders that are not Git repositories are "not applicable," never zero.
- **Branch.** The default branch: `origin/HEAD`, else `main` or `master`, else unknown. A detached
  or ambiguous head yields "unknown," not a guess. Unmerged branch work is not counted, and the
  UI says so.
- **Authors.** Commits authored by the installation's configured `user.email` values. The
  dashboard offers an "all authors" view for shared repositories, and bots (`dependabot`,
  `renovate`, any `[bot]` author) are excluded in both views. Export always uses own-author only
  (see §8).
- **Shallow clones.** A shallow repository reports incomplete history and its counts carry that
  status.

### 3. Local metrics and what they mean

| Metric | Definition |
| --- | --- |
| Commits to main | First-parent, non-merge commits on the default branch in the window; total, mean per project, and median per project |
| Lines added / removed | `--numstat`, source only, under the exclusion rules in §4 |
| PRs merged (approximate) | `(#N)` at the end of a squash subject, or a merge-commit PR reference. Marked `≈` because it depends on the merge style |
| Releases | Tags created in the window, split into stable, pre-release and unclassified. Semver is parsed from the tag suffix, so `pkg@1.2.3`, `crate-v0.3.0` and `v1.2.3` all classify. A tag that does not parse is unclassified and never forced into stable |
| Peak day, merge streak | Maximum merges in a day; consecutive days with a merge ending at the latest merge |
| Assisted share | Share of commits whose author time fell inside an agent session in the same repository, plus `Co-Authored-By` trailers reported separately. Labelled as session overlap, not causation |
| Rework | Reverts plus `fix:` commits within 48 hours of a merge, as a share of merges |
| Specs shipped | ADR status transitions to Accepted or Implemented, and closed `bd` issues. Shown only for repositories that have those sources |

Each tile follows the Scorecard pattern: the figure, a change against the previous equal-length
window, and a per-day sparkline. Change is read directionally: fewer reworks is good, more
commits is neither good nor bad.

### 4. Exclusions

Delivery reuses the Footprint definition of code so the two surfaces agree, and adds what git
history needs that a tree walk does not:

- **Existing rules.** `EXCLUDED_DIRS`, `EXCLUDED_FILES`, and the registry rules that only mapped
  languages own lines and unmapped extensions are listed by name, not counted.
- **More lockfiles.** Extend the set beyond today's npm, pnpm, yarn, Cargo, Poetry, Bundler,
  Composer, Go and Nix entries with `bun.lock`, `uv.lock`, `Pipfile.lock`, `pdm.lock`,
  `pubspec.lock`, `mix.lock`, `Package.resolved`, `Podfile.lock`, `gradle.lockfile`, `deno.lock`,
  `.terraform.lock.hcl` and `packages.lock.json`.
- **Repository-declared generated and vendored code.** Honor `.gitattributes`
  `linguist-generated`, `linguist-vendored` and `linguist-documentation` through
  `git check-attr`. This is language-neutral and owned by the repository, not by agentic-kit.
  A pattern fallback covers `*.min.js`, `*.map`, `*.pb.go`, `*_pb2.py`, `*.g.dart`,
  `*.generated.*`, `__snapshots__/` and `*.snap`.
- **Binary files** (numstat `-`) are skipped. **Merge commits** are skipped. **Renames** use
  rename detection, so a directory move is not a large addition and deletion.
- **Docs, data and infrastructure** are reported as a separate "docs and config" figure using
  the registry's ecosystem tags, so a docs-heavy week stays visible without inflating source
  lines.
- **Bulk imports are flagged, not dropped.** When one commit exceeds 40% of the window's added
  lines, the tile keeps it in the total and shows the figure without it.
- **Transparency.** A "How lines are counted" panel shows what was counted, what was set apart,
  and what was excluded, with the rule list.

Multi-module repositories: commits, PRs, releases and CI are repository-level facts and are not
split. Lines and language mix can be attributed per module through the nearest ancestor manifest
(the registry's manifest kinds and `MANIFEST_MAX_DEPTH`) in the project drilldown only.

### 5. The GitHub tier

`gh` is a detected prerequisite, not a bundled dependency. It is a Go binary rather than an npm
package, so bundling would add a per-platform binary matrix and supply-chain upkeep, and it would
contradict the managed-tools rule that `ak sync` updates only what agentic-kit installed. This
follows ADR-0035's treatment of an external install.

- **Detection.** Read from disk (`gh --version`), as managed-tools invariant 1 requires. An
  external install is "installed-only": no drift tracking, and `ak sync` never updates it.
- **Missing.** Setup and the dashboard show the install command for the user's package manager.
  Homebrew, mise, winget and scoop can run it after explicit confirmation and need no elevated
  rights. Linux package managers that need sudo only show the command and the vendor's install
  documentation. Whether mise packages `gh` must be verified before this ships.
- **Sign-in.** The kit never runs `gh auth login` and never reads or stores a token. Delivery
  calls `gh run list` and `gh api` and lets `gh` hold the credential. This deliberately differs
  from `admin-collect.mjs`, which reads `gh auth token`. Guidance states the scopes needed:
  read access to repositories, Actions and pull requests.
- **Facts obtained.** CI success (completed runs on the default branch, excluding cancelled and
  skipped, aggregated as a runs-weighted rate and never a mean of per-repository percentages),
  exact PR counts, median time to merge, median PR size, and GitHub releases.
- **Statuses, each distinct from zero.** `gh` missing, signed out, no remote, remote is not
  GitHub, no access or SSO authorization required, rate limited, excluded by the user, stale.
- **Load and freshness.** Queries run only for repositories with sessions in the window, with
  bounded concurrency and rate-limit awareness. Results are cached, and data older than six
  hours is labelled stale, not silently refetched. Nothing runs when a page opens. Refresh is an
  explicit action (ADR-0046's rule for scans).
- **Per-project exclusion.** A project can be excluded from GitHub queries, for example client
  work. Its local numbers remain. A separate switch excludes it from telemetry export.
- **Egress statement.** Repository slugs and time filters go to GitHub through the user's own
  session. The consent copy says so.

### 6. Effort next to output

The differentiating metrics join Delivery to the usage store: cost per merged PR (API-equivalent,
never called billing), PRs per engaged hour, and a same-repository comparison of agent days with
other active days. The comparison is observational and says so, because people may reach for an
agent on larger days. Session-to-commit attribution is time and repository overlap and is
labelled that way.

### 7. Surfaces

- **Dashboard.** A new primary area, **Delivery**, with four views. It is an area of its own
  because it has a different data source (git and GitHub, not transcripts), its own consent and
  setup lifecycle, and readers who are not the ones reading Spend. All views follow the shared
  `?days=N` window and compare against the previous equal-length window.
  - **Summary:** the headline tiles (PRs merged, commits, lines, releases, CI success, assisted
    share, rework, peak day, time to merge, specs shipped) and the bulk-commit note.
  - **Projects:** the per-repository table (commits, PRs, lines, releases, CI, assisted share,
    GitHub status), the monorepo module breakdown, and the "How lines are counted" panel.
  - **Economics:** cost per merged PR, cost per 1,000 source lines, PRs per engaged hour, effort
    and output as two charts on one time axis (never one dual-scale chart), and the agent-day
    comparison.
  - **Setup:** consent, the readiness ladder (install `gh`, sign in, allow queries, choose
    projects, each verified only on Re-check), and telemetry export controls.

  Usage keeps a one-line teaser of these figures on its Summary view that links here. When
  Delivery is off, every view shows the opt-in card.
- **CLI.** A `## Delivery` block in `ak usage score` for offline parity with the dashboard, and an
  `ak delivery` family (`status`, `enable`, `disable`, `recheck`, `refresh`, `show`). Command
  names are provisional until the CLI review.
- **Setup.** `ak setup --with-delivery` and `--with-github-metrics`, with `--no-` forms, following
  the `--with-deja-vu` pattern. Both default off. `ak status` gains a `gh` row (installed-only,
  signed-in state). `ak uninstall` clears Delivery caches and never removes a `gh` it did not
  install.
- **Recap card (later increment).** An exportable summary image for a chosen window, built on the
  existing dual-theme SVG figure system. Project names are omitted by default.

### 8. Telemetry export

Fleet export gains a `delivery` section so machines can be captured individually and aggregated
later.

**Contract version.** Adding a section is a breaking wire change under ADR-0054, since v1 rejects
unknown fields. This decision introduces snapshot and aggregate **schema version 2**. Version 1
stays valid. The reference reducer admits both, and an installation whose snapshot is v1 reports
`delivery: unavailable` in the aggregate rather than blocking it. Selection must still match
across snapshots.

**Grain.** UTC-day counter records per `(repoRef, authorRef, day)` covering `selection.days`. Daily
counters are mergeable, idempotent under whole-snapshot replacement, and let the aggregator
re-window without summing overlapping rolling totals, which ADR-0054 forbids.

Counters: commits, assisted commits, trailer-attributed commits, lines added (source, docs and
config, excluded), lines removed, PRs merged (local and GitHub kept in separate fields and never
summed), rework events, releases (stable, pre-release, unclassified), and CI completed and failed
runs. Median time to merge and PR size use fixed non-cumulative buckets, like the latency
histogram. Every GitHub counter carries `observedAt`. Missing remains `null`, measured zero
remains zero.

**Privacy.** No repository name, path, branch, commit message, file name, author address or
hostname. Repositories and authors are keyed hashes. Export includes only the installation's own
authors, never other people's activity in a shared repository.

**Cross-machine identity is the hard part.** A repository cloned on two machines yields the same
commits twice, and an unkeyed hash of a public commit SHA lets anyone with the repository confirm
membership. So:

- `repoRef` is a keyed hash of the repository's root commit, and `authorRef` a keyed hash of the
  normalized author address. By default the key is the installation key, so refs are
  installation-scoped (`repoKeying: "installation"`). The aggregate cannot tell that two
  installations saw the same repository, sums their counters, and marks the result **a sum of
  machine views that may double-count**.
- **Opt-in fleet key.** `ak telemetry fleet-key create` produces a random key file (owner-private)
  to copy to the user's other machines with `import`. It is never written into a snapshot. A
  snapshot carries only `fleetKeyId`, a truncated keyed hash of the key. With a shared key,
  `repoRef` and `authorRef` match across machines (`repoKeying: "fleet"`).
- **Aggregation rule.** For records with matching refs, day and counter, from installations
  sharing a `fleetKeyId`, the fleet takes the **maximum**, which is a lower bound of the union
  because clones can differ in what they have fetched. Different authors never collapse, so a
  teammate's activity adds. Mismatched key ids are not matched and are reported. Assisted
  counters are session-derived and installation-scoped, so they sum, bounded by the matched
  commit count.
- **Ratios** are always computed from summed numerators and denominators, never averaged. Cost per
  merged PR uses summed estimated cost and summed PRs, labelled approximate because the usage
  selection is whole sessions by end time and Delivery uses UTC days. **PRs per engaged hour is
  not a fleet metric**, since ADR-0054 omits engaged time.

**Boundary changes to ADR-0054.** Export never runs `gh` or makes a network request. It reads the
last cached GitHub observations only. It does read git metadata of enabled repositories, which
is new, so the ADR-0054 statement that export does not inspect repositories no longer holds when
Delivery is enabled. Delivery is included when the Local tier is on and export inclusion is on
(default on once Delivery is enabled, since export itself is an explicit command that writes a
file). `--no-delivery` omits it for a run, and a per-project switch excludes a repository.
Delivery records are bounded (100,000 per snapshot, matching sessions and receipts) and exceeding
the bound fails rather than truncating.

## Alternatives

1. **Use an external git-analytics or engineering-metrics product.** Lacks the transcripts, so no
   effort-to-output join, and adds a data destination.
2. **Bundle `gh`.** Rejected for the reasons in §5.
3. **Call the GitHub REST API directly with `GH_TOKEN`.** Removes the CLI dependency but
   duplicates a client and makes the kit handle a token. Kept as a possible later fallback.
4. **Fold Delivery into the usage-index cache.** Forces a schema bump for data that is not a
   transcript and is cheap to recompute. Delivery gets its own module keyed by repository and
   `HEAD`, with GitHub data in a separate small cache.
5. **Persist snapshots in a new store.** Survives rebased and deleted branches and speeds
   trends, at the cost of schema and migration work. Deferred until a need appears. Dated
   telemetry exports already serve as archival as-of views.
6. **Export repository names or unkeyed commit hashes for easy dedup.** Rejected on privacy
   grounds.
7. **One combined consent switch.** Rejected: reading local history and sending repository names
   to GitHub are different disclosures.

## Consequences

- The Scorecard gains outcome measures without adding a default data flow. Both tiers are off
  until chosen.
- The Footprint and Delivery tabs share one definition of code, at the cost of extending that
  shared exclusion set carefully.
- ADR-0054's contract moves to version 2 and its "export does not inspect repositories" boundary
  is amended for Delivery. ADR-0054's status is unchanged for version 1.
- Reading many repositories has a cost. Work is bounded to repositories with sessions in the
  window, cached by `HEAD`, and subject to a time budget that reports `truncated` rather than
  guessing.
- Limits that will stay visible in the product: squash, rebase and merge styles change PR
  approximation; author matching depends on a consistent `user.email`; root-commit identity can
  change when unrelated histories are merged; CI coverage is GitHub Actions only.

## Validation intent

Not yet written. The tests this decision commits to:

- **Git fixtures:** polyglot repository, monorepo with per-package tags, linked worktree,
  submodule, shallow clone, squash, merge and rebase histories, lockfile-only commit, bulk
  import, rename-only commit, bot commits, detached head, no remote.
- **GitHub, with an injected executor:** `gh` missing, signed out, SSO refusal, rate limit,
  non-GitHub remote, stale cache, refresh, and proof that no query runs on page open or export.
- **Consent:** the state machine for both tiers, disable clearing caches, `ak sync` and
  `ak uninstall` leaving an external `gh` alone.
- **Contract v2:** allowlist privacy, no names or paths, keyed refs, admission of v1 and v2,
  matched and unmatched aggregation, key-id mismatch, replacement semantics, duplicate delivery,
  bounds, and ratio arithmetic.
- **Documentation gate:** `DASHBOARD.md`, `USAGE-SCORECARD-METRICS.md`, `TELEMETRY.md`,
  `MANAGED-TOOLS.md` and the ADR index, in the same change as the code.

An interactive mockup accompanied review of this proposal. It is illustrative and generated from
synthetic data, so it is not implementation evidence.

## Phasing

| Phase | Delivers |
| --- | --- |
| 1 | Consent model, local metrics, exclusions, the Delivery area (Summary, Projects, Economics, Setup), CLI block. Lands after the Usage rename and split in ADR-0057, so it arrives in the final navigation |
| 2 | GitHub tier: `gh` detection and guided setup, CI, exact PRs, time to merge |
| 3 | Telemetry v2 with the `delivery` section, fleet key and aggregation |
| 4 | Recap card export, same-repository comparison refinements, `glab` adapter if wanted |

## Open questions

- Whether export inclusion should default to on once Delivery is enabled, or be a third opt-in.
- Whether root-commit identity is stable enough or needs a documented fallback.
- The `ak delivery` command names and whether `show` duplicates `ak usage score`.
- The cache lifetime (six hours is the proposal) and the per-run time budget.
- Whether the day convention on the dashboard (local days) versus export (UTC) needs a shared
  statement in `docs/DATE-TIME-PRESENTATION.md`.
