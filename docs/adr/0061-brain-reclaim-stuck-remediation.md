# ADR-0061 — RuvNet Brain "unresolved rollback state" remediation

- **Status:** Accepted
- **Date:** 2026-09-27
- **Updated:** 2026-09-30 — #271 adds bounded hold expiry, separate KB absence/access evidence and one-shot sync retry; disposable kit-path proof is separate from live upstream recovery.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0025](0025-machine-footprint-metrics.md) (machine-footprint metrics; this
  record deliberately does not add a new footprint subsystem there — see §4),
  the [issues 237–239 audit record](../archive/2026-09-26-plan-issues-237-238-239-verification-and-decisions.md)
  (Decision 4, the Brain hook-contract warning this record does not touch), upstream
  [stuinfla/ruvnet-brain#335](https://github.com/stuinfla/ruvnet-brain/issues/335) (filed
  2026-09-27, with a follow-up comment recording the workaround verified here)

## Context

`ak sync` on this machine held a RuvNet Brain refresh (4.3.28 → 4.3.29) behind:

```text
[forge-update] ERROR: unresolved rollback state exists; refusing to create another full-KB copy.
```

Investigation (session 2026-09-27) found the cause: `~/.cache/ruvnet-brain/` had accumulated 12
legacy KB snapshot directories (`kb.bak-2026-07-*`, `kb.install-preserved-*`) totalling ~21GB.
The Brain's own `forge-update.mjs` reclaim logic (`reclaimBackups()`, tested against issue #35
upstream) evaluated all 12 for real — not a dry run — and kept every one (`freed: 0`), because
each held content the live `kb/` lacked, or an inventory it could not parse. That protection is
correct and intentional (the same logic exists specifically so a backup holding a repo's only
remaining store survives). But it also means `--update` **cannot ever resolve this on its own**:
retrying it, which is what `ak sync` currently does every cycle it holds a refusal, can never
succeed while any of those directories remain unresolved.

Two things were verified empirically before this record:

1. **Manual reclaim is possible but bounded.** Hashing every file across the 12 directories found
   6 that were provably byte-identical duplicates of each other (safe to collapse after archiving
   one canonical copy); the other 6 (5 pre-RVF `kb.bak-*` snapshots, 1 `kb.install-preserved-*`
   holding content not reproducible from the current bundle) could not be proven safe by hand,
   and forge-update's own algorithm could not clear them either. No CLI reclaim/prune command
   exists (`--doctor`, `--what-changed`, `--uninstall` don't touch this) — filed as
   stuinfla/ruvnet-brain#335.
2. **A distinct, verified escape hatch exists for the version block specifically.**
   `npx ruvnet-brain --uninstall` removes only `~/.cache/ruvnet-brain/kb` (plus a handful of
   installer-owned files); it never touches the legacy snapshot directories, the Claude Code
   plugin, or the MCP registration. With `kb/` gone, the next install takes the **fresh-install
   path** (`bin/install.mjs`'s `obtainBundle()`), not the incremental `--update` path
   (`forge-update.mjs --apply`) — only the latter runs the reclaim check that gets stuck. Tested
   live on this machine: landed cleanly on 4.3.29, `search_ruvnet` came back immediately (no
   Claude Code restart — matches the documented "body-only releases go live on the next hook/MCP
   call" contract), and `ak sync` re-verified clean afterward. **Disk usage was unchanged** — the
   12 legacy directories were untouched throughout, and the fresh install even left behind one new
   empty `kb.install-preserved-<random>` directory (removed by hand). The workaround trades "stuck
   on an old version" for "still bloated," not a real fix for the bloat.

Today, `ak`'s own remediation text for *any* held Brain refusal (`brainReleaseRow()` in
`src/commands/status/sections/ruvnet-brain.mjs`) reads:

> fix the cause, then run `npx ruvnet-brain --update`; or set `"ruvnetBrain": false` in kit.json
> to stop ak managing the Brain

For most refusals (a private-overlay preflight, a stale updater bug — see
`tests/kit/brain-held-refresh.test.mjs`) that's correct: the cause is a one-off condition worth
retrying after a fix. For this specific refusal it is actively wrong — there is no "fix the
cause" available to the user, and telling them to re-run `--update` sends them back into the same
refusal forever.

## Decision

1. **Classify this refusal distinctly.** Add a narrow, exported pattern in `src/lib/heal.mjs`
   (`BRAIN_RECLAIM_STUCK`) alongside the existing `BRAIN_REFUSAL`/`BRAIN_CAUSAL` patterns,
   matching the two verified error strings
   (`unresolved rollback state exists`, `refusing to create another full-KB copy`). This does
   not change what gets held (`brainRefused()`/`recordRefusal` are unchanged) — only how a held
   refusal of this specific shape is *described*.
2. **Give it distinct remediation text**, in `brainReleaseRow()`: when a held refusal's `detail`
   matches `BRAIN_RECLAIM_STUCK`, the `fix` field names the verified workaround
   (`npx ruvnet-brain --uninstall` then `ak sync`), states plainly that it clears the version
   block but not the legacy-snapshot disk usage, and cites stuinfla/ruvnet-brain#335. Every other
   held refusal keeps the existing generic text unchanged (regression-guarded by the existing
   `tests/kit/brain-held-refresh.test.mjs` assertions).
3. **Report the legacy-snapshot count in that same message**, via a new pure helper
   `legacySnapshotBytes()` in `src/lib/ruvnet-brain.mjs` (best-effort, bounded, matching this
   file's existing null-on-failure conventions) — called only inside the reclaim-stuck branch, so
   it costs nothing on every ordinary `ak status`/`ak sync` run.
4. **No automatic execution.** The remediation stays `repair: 'manual'`, exactly like every other
   held-refusal row. `--uninstall` followed by a fresh `--force` install is a heavier, more
   invasive action than a normal `--update` — and per `src/lib/heal.mjs`'s own documented
   caution (`installRuvnetBrain`, citing issue #237 §4), a forced fresh install can itself be
   refused for a Brain with private stores, *after* downloading the whole bundle. `ak sync`
   auto-running this for every user hitting a reclaim-stuck hold would trade one silent failure
   mode for a more expensive one. The user decides.
5. **Installer-level fresh routing, not a complete sync proof.** Once the installer is reached
   after `--uninstall`, `updaterPresent()` becomes false (no `forge-update.mjs` on disk),
   `present()` stays true (the plugin cache survives), so the existing pinned
   `--force --version v<tag>` fresh-install branch fires and `recordRelease` clears the hold on
   success. The original test pins installer dispatch, not sync reaching it while a hold applies.
   The historical 4.3.29 escape hatch above is not a guarantee for later upstream installers.
6. **No new footprint-metrics subsystem.** [ADR-0025](0025-machine-footprint-metrics.md) owns
   machine footprint reporting; a one-sentence mention of a legacy-snapshot count inside an
   already-existing warning row is not a new dashboard card, and this record does not attempt to
   fold the two together — that's future work if the legacy-snapshot signal proves worth
   surfacing outside this one warning.
7. **Bounded hold expiry (#271).** A hold applies only to its release pair and a valid fresh
   timestamp. The configured positive finite version-check TTL applies, defaulting to 24 hours
   for invalid values. Expired, missing, malformed or future hold timestamps permit a half-open
   attempt; a new refusal records a fresh hold. An unreadable current clock does not authorize
   expiry. Status evaluation never deletes the stored refusal or private snapshots.
8. **Missing KB is not an installed release.** A surviving plugin cache can remain present
   after KB removal. Confirmed missing entrypoint clears only the observed installed-release
   value, not the stored historical stamp; that release-pair change permits a fresh attempt.
   A new refusal binds the null installed side and restores the normal hold. Access errors
   remain unknown/manual, never automatic fresh-install evidence. Missing/unverified release
   assets still block installer actions. No KB or snapshot deletion is automated.
9. **Explicit one-shot retry.** `ak sync --retry-brain` bypasses a fresh refusal hold only
   during plan collection. The stored refusal remains until installation succeeds or records
   a new refusal. Postcondition collection uses ordinary hold semantics; no retry loop is added.
   Dry-run only previews. No-upgrade, explicit Brain skip and disabled management conflict
   with the flag and are rejected before lookups/repairs. Unknown KB access or unavailable
   release assets remain blocked. The flag is not a cross-process attempt lock.

## Consequences

- Once a user hits this specific hold, the row tells them something they can actually act on,
  instead of a dead-end instruction.
- The disk-bloat problem remains open and upstream. If stuinfla/ruvnet-brain#335 ships a real
  `--reclaim`/prune command, this record's remediation text should be revisited to prefer it
  (cheaper — no full re-download, and it can reason about directories this session could not
  prove safe by hand, like `kb.install-preserved-69VtSI`).
- `docs/troubleshooting.md`'s existing row for "`ruvnet-brain … retained; the refresh … was
  refused`" is updated in the same change to describe both the generic case and this specific
  one, so the docs-alignment gate stays honest.

## Implementation status

Implemented in this branch: `BRAIN_RECLAIM_STUCK` export, `legacySnapshotBytes()`, the
`brainReleaseRow()` branch, `docs/troubleshooting.md` update, and tests covering classification,
the unchanged generic-refusal path, the post-uninstall install-routing behavior, and
`legacySnapshotBytes()` against a fixture directory.
