# Retire the external host-adapter contract and Hermes

## Status

**Active** (2026-10-07). Design for card P0-04, issue
[#324](https://github.com/pacphi/agentic-kit/issues/324), epic
[#295](https://github.com/pacphi/agentic-kit/issues/295), release `4.0.0-beta.1`. Nothing is merged.
The work ships as three pull requests (A, B, C). The maintainer approved the split and the error-message
fix on 2026-10-07. #324 closes when C merges. #324 blocks #330 (the project layout) and #385
(publish beta.1).

## Outcome

v5 replaces adapters with first-class hosts (design Decision 10). v4 stops carrying the external
host-adapter contract and Hermes support. After the last pull request:

- no code, command, flag, environment variable or guide offers an external host adapter;
- Claude Code, Codex and OpenCode behave exactly as before;
- ADR-0029 and ADR-0031 say "Withdrawn from v4; carried to v5";
- `pnpm test` passes at every merge, not only at the end.

The code stays available at the tag `archive/v4-host-adapters`, and users who rely on Hermes stay on
`4.0.0-alpha.61`.

## Corrections to the card and the ledger

The inventory, the import graph and a dry run of PR A show the card is bigger and ordered differently
than it says.

| Claim in the card or ledger | What the code shows |
| --- | --- |
| "ten adapter modules" | **17 source files** go: the ten, plus `x/host-adapters`, `x/host-adapters-grants`, `x/aqe-provider`, `execution/admitted`, `hook-audit/providers/external`, and two status sections. |
| `execution/adapters.mjs` goes (ledger G1) | **It stays.** It is the built-in `EXECUTION_ADAPTERS` registry that `ak run` uses. Only its import and an 8-line fall-through go. |
| about 15 test files | **16 test files** plus 7 fixtures. One is a hidden guard test, `aqe-live-proof-key-guard.test.mjs`, that spawns the live test. About 19 more test files are edited. |
| "ten modules" is the whole code scope | About **95 external-provider hits** sit inside `aqe-router.mjs`, `providers.mjs` and `routing.mjs`, interleaved with built-in code. This is the largest edit. |
| Steps can run "green after each step" in any order | **Not true.** `admission.mjs` imports `admitted.mjs` and `execution/admitted.mjs`, so those cannot be deleted first. Consumers must be detached first, then the cluster deleted. |

## What stays

- The built-in host registry, bindings and lifecycle (`registries`, `schema`, `bindings`, `config`,
  `facts`, `migration`, `ownership`, `lifecycle`, `lifecycle-render`).
- `execution/adapters.mjs` (edited), `lifecycle-registry.mjs` (edited), `lifecycle-render.mjs` (edited).
- `ak host pick --aqe-provider <built-in>`: the binding control. It becomes an `init` choice later.
- Read-only Hermes discovery in Maintenance (`maintenance/discovery/configuration.mjs` and related).
  It observes Hermes. It does not run it.
- `hostTierLabel` and `hostAsymmetryNote` keep their capability-derived logic, including the
  non-built-in branch. v5 reuses that logic for first-class hosts. The "external adapter" label text is
  v5's to redefine.

## Design: three pull requests

Each pull request leaves `main` green. The rule is: a module is deleted only after everything that
imports it is gone, and a module's own tests are deleted in the same pull request as the module.

```text
A  close the door, detach routing        -> the cluster still compiles, but nothing reaches it
B  detach the three consumers            -> the cluster is unreferenced by built-in code
C  delete the cluster, tests, docs       -> gone
```

### PR A: close the door and detach routing and hosts

- **CLI.** Delete `ak host adapters` (dispatch, help, the `expect-hash`/`timeout`/`dev` flags),
  `ak x aqe-provider`, the `AK_EXPERIMENTAL_HOST_ADAPTERS` bootstrap in `bin/agentic-kit.mjs` and the
  re-bootstrap inside `pick`. Delete the three command files and `adapters/conformance.mjs`, which only
  the CLI reached.
- **Detach.** `routing.mjs`, `hosts.mjs` and `x/host.mjs` use the built-in registry directly instead of
  the `effective*` overlay functions. `execution/adapters.mjs` loses its fall-through to admitted
  adapters.
- **Error fix (approved).** An unknown host in a route now says
  `unknown host "hermes" (expected: claude|codex|opencode)`. Today it says
  `host "hermes" requires canRouteActivities`, which names the wrong reason. A known host without the
  capability keeps the capability message. The helper `ineligibleHostReason` carries both and is
  exported so a unit test covers both branches.
- **Status.** Delete the two external status sections. One of them tells the user to run a command that
  no longer exists.
- **Docs, same pull request.** Delete the three guides (`authoring-host-adapters`,
  `hermes-host-adapter`, `host-adapter-freeze-checklist`). Remove the adapter sections from
  `host-support.md` and `providers.md`, the rows in `docs/README.md` and one sentence in `README.md`.
  Turn seven archive links to the deleted files into plain text (the #454 precedent and the archive
  README rule).
- **Tests.** Tests of the removed behaviour are deleted or rewritten as tests that the command is gone.
  Tests of dead modules stay until PR C.
- **Registry.** `agentic-dependency-constraints.json` lists five kit files that A deletes. Fix those
  entries. The registry test needs at least one ref or file on a `mapped` entry, so `ruflo#2912` gets a
  ref sentence.

**Dry-run evidence.** I applied PR A once in a scratch tree, then replayed it from a machine-readable edit
script in a fresh worktree. The two trees are byte-identical: 38 files changed (12 deleted, 26 edited),
+116 and -6,600 lines. The full gate passed on the replay: `tsc`, `eslint` (0 errors), the complexity
ceiling, the comment guard, `build-check`, markdownlint, lychee (0 errors), `docs-layout`, and
`node scripts/run-tests.mjs unit` (6,456 tests, 0 failures, 8 skipped). The suite is red between tasks 1
and 2, because tests of the overlay survive until task 2 deletes them. The plan names the 18 tests.

### PR B: detach the three consumers of the admitted overlay

All three read the same source, the admitted external hosts. A has closed the door. B removes them.

1. **AQE external-provider code.** `aqe-router.mjs` (`admittedProviderRecord`,
   `reconcileExternalProviders`, the external default and ownership receipt), `providers.mjs`
   (`aqeExternalProviders`, the `aqeSelectable*` functions, the external branch of
   `aqeProviderCredential`, `EXTERNAL_PROVIDERS_MIN_AQE`, `aqeExternalProviderState`,
   `configuredAdapterIds`, `externalProviderIntent`, `providerExternalState`), `routing.mjs` (the
   `aqeProviderForHost` and `aqeConstructibleProviderTypes` external parts), `live-checks.mjs`,
   `providers-status.mjs`, two display strings in `x/host.mjs`, and the `hostAdapters` default in
   `config.mjs`. The ownership helpers (`declarationHash`, `plainRecord`, `AQE_OWNERSHIP_KEY`) are shared
   with built-in defaults and **stay**.
2. **Hook audit, external host.** `orchestrator.mjs`, `providers/external.mjs`, `audit.mjs`,
   `context-audit.mjs`, `context-audit-sources.mjs`, the dashboard allow-list and "Adapter manifest"
   source kind, `hook-presentation.mjs` and `hook-remediation/planner.mjs`. `--host external` becomes an
   unknown host, and `--host all` means the three built-ins.
3. **Lifecycle entries.** The external half of `lifecycle-registry.mjs` (about 55% of the file), its
   `effective*` use, the `isBuiltinHost` branches, the "external lifecycle host, enabled" status rows and
   one special case in `uninstall.mjs`.

The managed block `claude/providers-reference.md` names "admitted external adapters". Editing it changes
a shipped block. B checks the block-drift and upgrade tests and bumps the template version if they
require it.

### PR C: delete the cluster

Delete the nine unreferenced adapter modules (`admission`, `admitted`, `aqe-provider`, `consent`,
`grants`, `hook-runner`, `integrity`, `manifest`, `sources`) and `execution/admitted.mjs`. Delete their
11 test files, the live proof test, `tests/fixtures/adapters/` and the `package.json` entries for the
live test. Trim `adapters/index.mjs`. Fix the constraints-registry entries that name them. Mark ADR-0029
and ADR-0031 "Withdrawn from v4; carried to v5", fix the ADR README, the DDD docs and the remaining docs
that mention adapters, and correct `docs/proposals/v5-planning-sources.md` (it wrongly lists
`live-adapters.test.mjs` as an adapter test; that file reads transcripts and stays).

## Rulings

- **Stale `kit.json` keys.** A saved `hostAdapters` list or an external id under `integrations.hosts`
  stays on disk as inert data, so the source never needs to name them again (the #454 precedent for
  `tools.dejaVu`). The exit release and the single legacy check cover users who still have them.
- **Archive files** stay frozen. Only broken links become plain text.
- **No aliases or hints** for the removed commands. The old-to-new mapping goes in the PR bodies and the
  release notes.
- **`execution/adapters.mjs` stays**, contrary to the ledger.

## Behaviour after the change

| Area | Before | After |
| --- | --- | --- |
| `ak run` with claude, codex, opencode | works | **unchanged** |
| `ak run` with a route naming `hermes` | error says "requires canRouteActivities" | exit 2 at plan time: `unknown host "hermes" (expected: claude\|codex\|opencode)` |
| `ak host adapters …` | experimental, behind a flag | `unknown host subcommand: adapters` |
| `ak x aqe-provider` | hidden transport | `unknown plumbing command: aqe-provider` |
| `AK_EXPERIMENTAL_HOST_ADAPTERS=1` | admits adapters | no effect |
| `ak audit hooks --host external` | lists manifests | rejected as an unknown host (PR B) |

## Test strategy

Each pull request starts with tests that fail for the right reason, then the change:

- A: the two message tests (`routing.test.mjs`, `run-command.test.mjs`) and a unit test of
  `ineligibleHostReason`; `ak host adapters` and `ak x aqe-provider` unknown-command tests, with the old
  environment variable set and unset; a test that a registered admitted execution adapter and host
  overlay no longer change routing.
- B and C: the existing built-in suites must stay green. Each removed consumer takes its tests with it.
- Every pull request runs the full gate: `tsc`, `eslint`, the complexity ceiling, the comment guard,
  `build-check`, `lint:md`, lychee, `docs-layout` and `node scripts/run-tests.mjs unit`.

## Risks and open questions

- **B: AQE stale entries.** A project that used the experimental feature keeps its
  `externalProviders` entries and `_agenticKit` receipts after B removes the pruning code. What AQE does
  with a stale entry is not verified. The exit release's `--purge` removes them by receipt for alpha
  users.
- **B: `--json` shape.** `ak audit hooks --json` loses its `external` key. Whether that command is part of
  the GA surface contract (`ga-surface-guard.test.mjs`) is not yet read.
- **B: managed block.** The template-version question above.
- **A to C: docs links.** Lychee covers `docs/archive`. Each pull request runs it.
- **Unread:** four small test files with `external` hits (`hook-scope-inventory`, `context-audit`,
  `provider-proving-integrations` and one more) are counted but not read. B reads them first.

## Out of scope

The built-in host registry and lifecycle, `--aqe-provider` for built-in providers, Hermes discovery in
Maintenance, and any v5 host model. v5 hosts are a separate design.

## Verification

- `node scripts/run-tests.mjs unit` after every task, and the full gate before every pull request.
- A review pass after each pull request, as for #467.
