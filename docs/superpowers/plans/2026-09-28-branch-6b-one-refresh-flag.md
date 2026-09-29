# Branch 6b Implementation Plan — `feat/one-refresh-flag`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Drafted by a read-only planning pass against the `feat/one-refresh-flag` worktree at `31a1a39b` (main after PR #252, Branch 6a). Every premise below was checked in that code; file:line references are to `31a1a39b` unless a task says otherwise.
>
> **Split (maintainer decision B6b-D2):** this plan is Branch 6b — the CLI vocabulary, the Codex quota rule, the CLI connection check, the sync and CLI honesty fixes, and the CLI half of the docs and ADRs (Tasks 1–14). The dashboard half (the POST route, the one Refresh control, Reload, read-only GET routes, and their docs and ADRs) is kept intact at the end under **Deferred to Branch 6c** (6c-1 … 6c-5); Branch 6c starts from `main` after 6b merges.

**Goal:** One refresh vocabulary on the CLI: `--refresh[=live|machine]` on `ak status`, `ak system` and `ak maintain`; `ak x verify` folded into `--refresh=live`; operations that are not refreshes renamed; the paid connection check reachable from the CLI behind consent; Codex quota asked only when Codex is found; and the CLI honesty defects closed.

**Architecture:** A new `src/lib/refresh.mjs` owns the strengths, one ordered stage table and `runRefresh()`, which composes the chains that exist today — status `collect({ refresh: true })`, the live checks, the System collector's `refreshDeep()`, the Maintenance service's provider scan and the management facade's inventory rebuild — through injected stage functions. In 6b the CLI supplies the stage implementations over one shared collector/service/facade set; 6c adds the dashboard's implementations behind `POST /api/refresh`. Storage does not move (Ruling R1). Work starts only from an explicit CLI flag; plain reads and the 30-second dashboard poll stay spawn-free.

**Tech Stack:** Node 22/26 ESM CLI (`bin/agentic-kit.mjs`, `node:util` `parseArgs` with `strict: true`), `node:test`, the Playwright UI harness (`tests/ui`), the 6a spawn-guard harness (`tests/helpers/spawn-guard.mjs`, `tests/kit/helpers/dashboard-child-server.mjs`), the sandbox helpers (`tests/kit/helpers/home-sandbox.mjs`).

**Spec:** [Remediation program, Branch 6b](2026-09-26-remediation-program.md) · [Audit record, Addendum 3 Item 4; Decisions 1, 5, 6](../../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md) · [ADR-0063](../../adr/0063-evidence-store-and-refresh-vocabulary.md) · ledger decisions **B6b-D1**, **B6b-D2**, **B6b-D3** (`.superpowers/sdd/2026-09-26-remediation-program/progress.md`, main checkout, section "Wave 3 Branch 6b"). B6b-D3 supersedes the program plan's "including `docs/UPGRADING.md` for the renamed flags".

The design this work implements (audit Addendum 3 Item 4, copied so no implementer needs the audit). 6b delivers every CLI entry in it; the quoted dashboard controls and Reload land in 6c:

| Strength | Does | Replaces |
|---|---|---|
| (none) | Shows recorded results with their age; re-collects quick local evidence only when it has expired | today's probing plain status |
| `--refresh` | Re-runs every local check, the online version lookup, and the Maintenance evidence and inventory | `status --refresh`, `maintain scan [--refresh-inventory]`, "Refresh evidence", "Check again" |
| `--refresh=live` | Adds live round trips; `--only <test>` selects one; slow proofs run only when named | `status --live`, `ak x verify` |
| `--refresh=machine` | Adds the full machine re-measure, with project trees as an option on both surfaces | `system --deep`, `maintain scan --deep`, "Full scan", "Re-measure machine" |

"The paid connection check is never a strength of `--refresh`; it stays a separate consent-gated action with a CLI twin. Operations that are not refreshes are renamed: `ak host refresh` → `ak host reset-routes`; `ak usage prompts --deep` → `--show-text`; the dashboard header's '↻ refresh now' → '↻ Reload'. The dashboard offers one Refresh control with the same three strengths, running the same server operation as the CLI and reporting its stages the same way." Maintainer direction (audit line 1572): "carry no legacy behaviour".

**B6b-D1 (maintainer, binding):** the dashboard Limits panel reads Codex quota when Codex is FOUND (installed), whether or not ak manages it; the decision comes from 6a's recorded host evidence, with no extra probe. Cost accepted: a Codex installed after the last evidence refresh shows no quota until evidence is refreshed (≤ 6 h, or one dashboard status poll after the evidence expires, or `--refresh`).

---

## Global Constraints

- Commits carry no `Co-Authored-By` or any trailer-like final line. Conventional subjects; stage files by name (never `git add -A`/`.`); never commit `.harness/`, `.swarm/`, `.claude-flow/`, `.agentic-qe/`.
- Nothing is pushed, opened as a pull request, merged, posted upstream, or created as a routine without the maintainer's explicit go-ahead for that action.
- Never run `pnpm` in this worktree (its `node_modules` is a symlink). Use `node --test`, `npx eslint`, `npx tsc -p tsconfig.json`, `npx markdownlint-cli2`, `node scripts/build-check.mjs`, `node scripts/run-tests.mjs unit|ui|exec`.
- Do not delete files or folders except as `common.md`'s deletion rule allows (one literal absolute path per command, `ls` before and after). A file this plan retires is removed with `git rm <literal path>` or `git mv`, never `rm` with a variable or glob.
- Tests never write real user state (`~/.config/agentic-kit`, `~/.local/state/agentic-kit`, `%APPDATA%`/`%LOCALAPPDATA%` equivalents, the repository's `.claude`/`.swarm`/`.agentic-qe`/`.claude-flow`/`.harness`). Use `sandboxHome()`/`spawnEnv()` from `tests/kit/helpers/home-sandbox.mjs`. An in-process `XDG_*` redirect sets its Windows twin (`APPDATA`/`LOCALAPPDATA`) — `tests/kit/spawn-env-guard.test.mjs` enforces it. Unset `FORCE_COLOR` for ad-hoc runs.
- Test-first for every behaviour change: show the failing run, then the passing run, in the task report.
- Runtime assets live under `src/`; prove with `npm pack --dry-run` when a task adds one.
- User-facing docs describe the current state only; history lives in ADRs and audits. An ADR this branch changes gets its Status, an `Updated` date (2026-09-28 or the day it lands) and a one-line note.
- **No legacy (B6b-D3, Ruling R17):** no alias and no hint for any retired spelling (`ak x verify`, `ak status --live`, `ak status --deep`, `ak system --deep`, the `ak maintain scan` verb with `--deep`/`--refresh-inventory`, `ak maintain scans start --deep`, `ak maintain plan --deep`, `ak maintain recipes refresh`, `ak host refresh`, `ak usage prompts --deep`). A retired spelling gets the parser's generic unknown-command or unknown-option error. Help, README, `docs/*.md` (including `docs/UPGRADING.md`) and the installed guidance under `claude/` show only the new spellings, with no old → new tables. The mapping lives only in the pull request's "Breaking changes" section and, at release time, the GitHub release notes. ADRs and audit records may still name old spellings (history).
- **Hermeticity rule specific to this branch:** a base `--refresh` constructs the Maintenance service and management facade, which write `<state>/agentic-kit/maintenance/…`. Every test that passes any `--refresh` strength to `status`, `system` or `maintain` injects its stages (`deps.refreshStages`) or runs in a `sandboxHome()`; the real-state tripwire must stay clean.
- **Line budgets:** `src/commands/sync.mjs` counts 832 of 1,000 (Ruling R11): every task that touches it leaves the count at or below 832. `src/lib/dashboard-server.mjs` is already over the `max-lines` warning (1,473 counted lines) and `startDashboard` is at complexity 38 (the gate errors at 50); 6b touches that file only in comments (Tasks 1 and 6). Every task leaves `npx eslint src bin --rule 'complexity: [2, 50]'` passing.

Line-count probe used above (read-only):

```bash
npx eslint --no-config-lookup --rule '{"max-lines":["warn",{"max":1,"skipBlankLines":true,"skipComments":true}]}' src/commands/sync.mjs src/lib/dashboard-server.mjs 2>&1 | grep -oE 'too many lines \([0-9]+\)'
```

## Premise verification (done by the planner; tasks carry the evidence forward)

Rows marked 6c are evidence for the deferred dashboard work; they stay here so both branches argue from one table.

| Item | Premise | Verdict | Evidence at `31a1a39b` |
|---|---|---|---|
| 1 | `ak status --deep` is declared but never read | True | `src/commands/status.mjs:20` (option), `:41` (help), `:55` (example); `run()` `:147-187` never reads `flags.deep` |
| 1 | `--refresh` is a boolean; `--live` a separate flag | True | `status.mjs:22-23,43-51,150-152` |
| 1 | `ak system --deep` = re-measure only | True | `src/commands/system.mjs:22,36,363-371` → `collector.refreshDeep()`; no provider scan, no inventory rebuild |
| 1 | `ak maintain scan --deep --refresh-inventory` = re-measure + provider scan + rebuild | True | `src/commands/maintain.mjs:253-270` → `service.scan({deep:true})` (`src/lib/maintenance/service.mjs:267-269,296-341` calls `collector.refreshDeep()` first) then `management.rebuildAfterMeasurement()`. **Also:** `scans start --deep` (`maintain.mjs:661-664` → `service-discovery.mjs:270` `refreshDeep()`) and `plan --deep` (`maintain.mjs:297` → `service.mjs:350-354`) are two more "re-measure first" meanings. `ak maintain scan` builds separate collector instances for the service and the facade (`maintain.mjs:228-231,254`) |
| 1 | `util.parseArgs` rejects a bare string option | True (code-forced) | a `type:'string'` option with no value throws `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`; `bin/agentic-kit.mjs:163-181` parses with `strict: true` |
| 2 | `ak x verify all` omits `mcp` | True | `src/commands/x/verify.mjs:714` |
| 2 | `ak x verify` ignores `--json` | True | declared `verify.mjs:32`; `run()` `:701-725` never reads it |
| 2 | In-repo callers of `ak x verify` | Found | `.github/workflows/nightly.yml:62` (`x verify security`), `:97` (`x verify learning`, `continue-on-error`) — both rely on exit 1 on failure; `claude/ruflo-reference-full.md:63,78,253,270,434,436` (guidance ak installs to `~/.config/ruflo/`); `src/lib/hook-audit/agentic-dependency-constraints.json:1015,1650,2616` list `src/commands/x/verify.mjs` in `kitImpact.files`, and `tests/kit/upstream-watch-registry.test.mjs:281-282` fails when such a path does not exist |
| 2 | Flaky "memory suite leaves no temp directory behind" | Hypothesis | `tests/kit/verify-command.test.mjs:197-205` diffs the shared `os.tmpdir()` by the prefix `agentic-kit-memory-`; `verify.mjs:155` creates that prefix; `tests/kit/verify-memory-routes.test.mjs:229-236` runs the same `verifyMemory` in a parallel test process. Unproven — Task 4 must reproduce before claiming |
| 3 (6c) | "Full scan" and "Re-measure machine" start the same chain | True | `page.mjs:222` / `:920` → `client/system-projects.mjs:923-930` and `client/maintenance-operation.mjs:100` → `GET /api/system/summary?refresh=deep` → `dashboard-server.mjs:1995-2013` (`refreshDeep`) → `:1217-1233` (`service.scan({deep:false})`, then `rebuildAfterMeasurement`); the chain stops when the deep scan fails (`:1221`) |
| 3 (6c) | "Refresh evidence" | Confirmed | `page.mjs:918` → `client/maintenance-operation.mjs:103` `GET /api/maintenance?refresh=scan` → `dashboard-server.mjs:2022-2031` → `dashboard/maintenance-api.mjs:872-876` (`service.scan()` + `afterScan` = `refreshInventoryAfterProviderScan`, `dashboard-server.mjs:1201-1214`) |
| 3 (6c) | "Check again" / "↻ refresh now" / Project-trees chip | Confirmed | "Check again" `page.mjs:162` → `client/host-readiness.mjs:138,178` `POST /api/host-health/local` → `dashboard/host-health-api.mjs:18-19` `read({force:true})`; "↻ refresh now" `page.mjs:116` → `client/poll.mjs:131-161` (reads only); trees chip `page.mjs:752` → `client/system-projects.mjs:1048-1054` re-measures |
| 3 | 30-s poll cost is pinned | True | `tests/kit/dashboard-status-cost.test.mjs` (tick 2: zero spawns except the named `npm view` exception; bytes within max(10 %, 2 KiB) of tick 1) |
| 4 | Paid connection check and its gate | Confirmed | `POST /api/host-health/connection` (`host-health-api.mjs:4,24-37`) → `createHostReadinessReader().checkConnection` (`src/lib/host-readiness.mjs:136-166`: `confirm === true`, single-use `evidenceKey` from fresh local evidence, managed-only `canCheckConnection` `:86-92`) → `checkHostConnection` (`src/lib/host-health-connected.mjs:199-205`, refuses without `confirm`); UI consent = disclosure + checkbox (`page.mjs:160-162`) |
| 5 | `ak host refresh` only rewrites routes | True | `src/commands/x/host.mjs:99-101,182,365-410` (kit.json routes + AQE router) |
| 5 | `ak usage prompts --deep` reveals text | True | `src/commands/usage.mjs:31,46,50,68,81,981` |
| 6 | Security check scans the current folder | True | `verify.mjs:273` `runner('ruflo', ['security','secrets'])` with no `cwd` → `process.cwd()`; `LIVE_CHECKS` `:646` ignores `ctx.cwd`; Ruflo 3.47.0 `security secrets` defaults `--path .` and reads up to 500 files (`@claude-flow/cli/dist/src/commands/security.js:772,780-789`); it writes nothing |
| 7 | `--skip versions` still does the online lookup | True | `src/commands/sync.mjs:111-127` (`refreshPlanDrift`) returns early only for `--dry-run`/`--no-upgrade` (`:112`); `parseSkip` (`:1074`) never reaches it. **Also:** the plan read `collect()` reaches `versions`/`self`/`ruvnet-brain` sections that fetch when their 24 h TTL has expired (`src/lib/versions.mjs:71-99`, `src/lib/ruvnet-brain.mjs:269-290`) |
| B | `ak sync --dry-run` skips the online lookup | True, and worse | `sync.mjs:112` and `:141` skip it; yet an expired TTL makes the plan read fetch **and `saveKitConfig`** (`versions.mjs:95-98`, `ruvnet-brain.mjs:283-290`), so a dry run writes `kit.json` whenever the cache is stale, contradicting `--dry-run  … change nothing` (`sync.mjs:209`). `npm view` also writes `~/.npm` (the reason `bin/agentic-kit.mjs:212-216` skips the drift nudge under `--dry-run`). The support-window row carries a sync fix (`status/sections/versions.mjs:15-16`), so release dates matter to the plan |
| 8 (6c) | Two GET routes start work | True | `GET /api/system` and `/api/system/summary` with `?refresh=deep[&trees=]` (`dashboard-server.mjs:1995-2014`, routes `:2125-2126`); `GET /api/maintenance?refresh=scan` (`:2022-2031`). ADR-0025 §5 (`docs/adr/0025-machine-footprint-metrics.md:320-321`) and `client/system-projects.mjs:915-918` justify the GET — 6c-3 amends that decision |
| 9 | `ak maintain recipes refresh` can never succeed | True | `maintain.mjs:791-793` → `maintenance/management/service-actions.mjs:64-67` throws unless `recipeRegistry`; no production caller passes one (`management/service.mjs:69` default `null`, `service-context.mjs:51`). Also reachable as `POST /api/maintenance/v2/recipes/refresh` (`dashboard/maintenance-security.mjs:50`, `maintenance-api.mjs:1059`); no dashboard control calls it |
| 10 | `ak sync --json` + unknown option prints help | True | `bin/agentic-kit.mjs:171-180` (`fail` + help on stdout, exit 2) |
| 10 | Config error under `--json` loses recovery | True | `sync.mjs:1047-1053` catches and records `error` only; the recovery commands exist only in `bin/agentic-kit.mjs:246-262` |
| 10 | `--skip` lines print twice | True | `sync.mjs:96` (`announcePlan`) and `:999` (`reportVerdict`) both print every plan-skipped item on a real run |
| 10 | `ak status --live --json` can print non-JSON | True, re-expressed | `live-check-evidence.mjs:181` `warn()` → `output.mjs:83` `console.log`; `runLiveChecks` records outside any capture (`verify.mjs:697`). `--live` is removed by Task 2, so the requirement becomes "`ak status --refresh[=…] --json` prints only JSON on stdout" |
| 10 | `ak x host --dry-run` is never read | **Partly false** | declared `x/host.mjs:67`; honored by `align` (`x/host-align.mjs:35`); ignored by `pick`, `off`, `refresh` |
| 10 | Bare `ak` hint ignores rows without a fix | True | `status.mjs:173-185` prints "0 item(s) need attention — run: ak sync" when only `fix: null` warnings remain |
| 10 | `sync.mjs` is near/over `max-lines` | **False** | rule `eslint.config.mjs:58` `max-lines: ['warn', {max: 1000, skipBlankLines: true, skipComments: true}]`; `sync.mjs` counts **832** (1,236 physical lines). No split task (Ruling R11) |
| A | `readLimits` always asks Codex | True | `src/lib/quota.mjs:447-458` → `collectCodexLimitsDetailed` (`:385-407`) → `codexAppServerExchange` spawns `codex -s read-only -a never app-server` (`:313-317`) on a stale 5-min cache; sole caller `dashboard-server.mjs:1137-1140` (`/api/limits`, `:1911-1921`) |
| A | Which evidence says "Codex found" | `host-setup` | `detectHosts` (`src/lib/providers.mjs:352-375`) records `host-setup` for **every** host on every `collect()` (`status.mjs:120`), managed or not; `host-install-method` is recorded only for **enabled** hosts (`status/sections/hosts.mjs:41-45`, `sync.mjs:143-146`), so an unmanaged Codex never gets one. Read with `readEvidence('host-setup', 'codex', { inputsKey, maxAgeMs })` (`src/lib/evidence.mjs`, a pure file read) keyed by `hostSetupInputsKey` (`providers.mjs:234`, private, spawn-free) with `HOST_SETUP_MAX_AGE_MS` (`:226`, 6 h) |
| C | ADR-0063 must go Proposed → Accepted | **Already done** | `docs/adr/0063-…md:3` reads `Accepted`. What it owes: a "Delivered in 6b" section and a rewritten "still ahead in 6b" list (`:370-378`) in Task 14; the Supersedes line (`:17-20`, "terminology only") becomes real supersession in 6c-5. ADR-0048's 2026-09-28 Updated line (`0048-…md:5-10`) says the two dashboard controls are *unchanged* — still true after 6b; Task 14 adds the CLI facts, 6c-5 supersedes the controls |
| — | `captureOutput` is safe inside the long-lived dashboard | True | per-call `AsyncLocalStorage` scope (`src/lib/output.mjs:65-78`) |
| — | Adding a `refresh` key breaks `ak maintain --json` | No | `jsonPayload` (`maintain.mjs:221-224`) returns `rawJson` results as-is |

Two documented-but-absent UI strings/behaviours Task 13 fixes (they are wrong today, whatever 6c does later): `docs/DASHBOARD.md:670-671` quotes "Re-measuring the machine… this can take minutes." (no such string under `src/lib/dashboard/`), and `docs/DASHBOARD.md:592-594` says Maintenance never loads on the shared poll, while `client/poll.mjs:155` reloads it on every tick while the Maintenance view is open.

## Rulings (decided here: what — why — cost if wrong)

- **R1 — `--refresh=machine` moves the control, not the storage.** One flag (6b) and one dashboard control (6c) drive the existing chain (`refreshDeep` → Maintenance provider scan → `rebuildAfterMeasurement`); the footprint snapshot and `scan-store.mjs` stay where they are. — The audit table asks for one flag and one control running one operation; ADR-0063 (`:216-218`) deliberately left scan storage separate; the Replaces column maps `machine` to today's Full scan/Re-measure, which never ran live checks. — Cost if wrong: two storage systems remain (already recorded in ADR-0063); moving storage later means a footprint-snapshot schema bump plus rewriting `scan-store.mjs` and its readers, none of which this branch touches.
- **R2 — Strengths and stages.** Internal strength names `local` (bare `--refresh`; `--refresh=local` accepted as its explicit spelling), `live`, `machine`. One ordered stage table: `machine` (Measuring the machine) → `maintenance` (Refreshing Maintenance evidence) → `inventory` (Rebuilding the inventory) → `live` (Running live checks) → `local` (Re-checking local evidence and versions). `local` runs `maintenance`, `inventory`, `local`; `live` adds `live`; `machine` adds `machine` and rebuilds the inventory with `rebuildAfterMeasurement` instead of `refreshInventory`. `machine` does **not** include `live`. The `local` stage is last so its status rows include fresh live results. A failed `machine` stage marks `maintenance` and `inventory` `skipped` (mirrors `dashboard-server.mjs:1221`); any other failure does not stop later stages; `local` always runs. — Matches the Replaces column and the dashboard's existing dependency rule. — Cost if wrong: a user expecting "machine = everything" runs a second refresh; the change is one array in `REFRESH_STAGES`.
- **R3 — Parsing a bare `--refresh`.** `bin/agentic-kit.mjs` rewrites an exact `--refresh` token to `--refresh=` before `parseArgs`, only for commands whose `options.refresh.type === 'string'`, never after a `--` terminator, and never consumes the next token (`ak maintain --refresh report` keeps `report` a positional). Programmatic callers may pass `refresh: true` (treated as `local`). — `parseArgs` cannot express an optional value. — Cost if wrong: an odd spelling like `--refresh live` (space) parses as bare refresh plus a positional; commands with positionals reject it with a usage error.
- **R4 — `--only` decides the exit code.** Without `--only`, a failed live check stays a warning (today's contract for live checks run from `ak status`). With `--only`, the exit code is 1 when any named check is `failed` or `inconclusive`. — Keeps `nightly.yml`'s security step failing on a failed proof after migration. — Cost if wrong: scripts that expected `--only` to be advisory see exit 1; one line in `status.mjs`.
- **R5 — `ak maintain` verbs.** The `scan` verb is removed; a new read-only `report` verb (`service.report()`, the saved model) is the default when no verb is given. `--refresh[=…]` is accepted only with `report` (explicit or default) and runs the refresh before reporting; any other verb with `--refresh` is a usage error (exit 2). `--deep` and `--refresh-inventory` are removed from `ak maintain` entirely (also from `scans start` and `plan`, whose "re-measure first" meaning is `ak maintain --refresh=machine` followed by the verb). — Plain reads read; `--refresh` refreshes (the table's first row). — Cost if wrong: one extra command for someone who re-measured inside `plan`/`scans start`.
- **R6 — Dashboard control (Branch 6c; kept here so 6c starts from it).** One Refresh control in the header (`#refresh-run` plus a strength menu `#refresh-strength` with "Refresh", "Refresh live", "Refresh machine" and an "Include project trees" checkbox enabled only for machine; stage progress in `#refresh-status`, `role="status"`, `aria-live="polite"`). The header's `#poll-now` becomes "↻ Reload" (title/aria-label "Reload — re-read this view; runs no checks"). Removed: `#sys-rescan` ("Full scan"), `#mnt-check-providers` ("Refresh evidence"), `#mnt-remeasure` ("Re-measure machine"), `#host-health-refresh` ("Check again"). The host-health dialog keeps one button, labelled "Refresh", that calls the same client function at `local` strength (a modal dialog cannot reach the header). The Storage view's Project-trees chip stops starting work and shows whether the last measurement included project trees. The noun "Full scan" retires: the deep tier is "machine measurement" everywhere. The dashboard does not expose `--only`. — One operation, one vocabulary; the dialog placement avoids closing a modal to reach the header. — Cost if wrong: one more button placement to remove later.
- **R7 — CLI connection check.** `ak host check-connection <claude|codex|opencode> [--yes] [--json] [--dry-run]`. It prints the target and the dashboard's own disclosure (one shared constant), asks `[y/N]` on a TTY, refuses (exit 2) on a non-TTY without `--yes`, runs only for a managed host whose local checks pass, and is never reachable from any `--refresh` strength (Task 2's static assertion; 6c-1 extends it to the server module). — Mirrors the dashboard's consent and prerequisites exactly by reusing `createHostReadinessReader`. — Cost if wrong: a rename.
- **R8 — `ak sync --dry-run` previews the online lookup.** A dry run performs the same forced lookups a real sync performs before planning (npm versions for ruflo/agentic-qe/npm-managed hosts, the kit's own tags, the Brain release when enabled, Ruflo's release dates), records nothing (`record: false`; an in-memory config copy for release dates), feeds the results to the plan through the collector context, and runs every `npm view` (versions **and** release dates) with `npm_config_cache` pointed at a per-run temporary folder it removes afterwards (plus `npm_config_logs_max=0`, `npm_config_update_notifier=false`). When every lookup fails it prints one line saying versions were not checked online and the plan uses the recorded ones. — A GET is not a local write; the redirect keeps `~/.npm` untouched (the contract `bin/agentic-kit.mjs:212-216` protects) while honoring the user's `.npmrc` registry and proxy. — Cost if wrong: a dry run takes a few network seconds; a crash can leave one `ak-sync-preview-npm-*` folder under the OS temp dir.
- **R9 — Codex quota when not found.** `readLimits` never probes. Presence `found` → today's path. `not-found` (fresh `host-setup` says absent) → no spawn, `codexUnavailable.reason = 'host-not-found'`. `unconfirmed` (no record, older than 6 h, or recorded under a different `PATH`) → no spawn, `'host-unconfirmed'`. In both non-found cases the cached Codex figure, if any, is still served with its age — the existing "failure → stale cache" contract (`quota.mjs:396-398`). — Keeps one contract. — Cost if wrong: a removed Codex's last figure stays visible, labelled, until the cache file is gone.
- **R10 — Keep `ak usage refresh openrouter` and `ak models refresh`.** Not in the audit's rename list; each fetches one named external source. — Cost if wrong: two later renames.
- **R11 — No `sync.mjs` split task.** The premise is false (832/1,000 counted lines, warn-only). Instead the code this branch rewrites leaves the file: Task 2 moves `humanOutputToStderr` (`sync.mjs:976-994`) to `src/lib/output.mjs`; Task 8 moves the plan-time version lookups (`refreshPlanDrift`, `:108-127`) into `src/commands/sync/plan-versions.mjs` before Task 9 extends them. Split-first on exactly the seam being rewritten means freshly reviewed code is never moved twice. — Cost if wrong: none measurable; every task touching `sync.mjs` asserts the count stays ≤ 832.
- **R12 — `ak host --dry-run`.** `pick`, `off`, `reset-routes` and `check-connection` print what they would do and stop before any write; `status` is read-only; `align` already honors it; `adapters` refuses `--dry-run` (exit 2) because its verbs have no preview. — "A flag we declare is a flag we honor, or refuse." — Cost if wrong: `adapters` gains a preview later.
- **R13 — Remembered live-check sources.** New source id `status-refresh-live` (label "ak status --refresh=live"); records already on disk with `verify` or `status-live` render as "an earlier live check" (they expire within 24 h) — the label never names a retired command (R17). Evidence ids are unchanged (`memory-routes` records under `memory`; the full `aqe` proof records only its embedding request under `aqe-embedding`, as today). — Cost if wrong: one label.
- **R14 — Recipe refresh.** Remove every user-reachable path (CLI verb, v2 route and its allowlist entry, facade method, `recipeRegistry`/`fetchImpl` service options that exist only for it). Keep the recipe store's verified-staging function (`maintenance/management/recipes.mjs` `refreshRecipes`, allowlist/HTTPS/redirect/signature checks) and its tests as the library a future registry calls; ADR-0048 says so. — The verification code is the expensive, reviewed part (MNT-ACT-019). — Cost if wrong: ~100 unreachable lines.
- **R15 — Exit codes.** A refresh stage that fails makes `status`, `system` and `maintain` exit 1 (keeps `system --deep`'s contract, `system.mjs:381,399`). Live-check outcomes follow R4. A usage error is exit 2 everywhere.
- **R16 — Split into 6b and 6c (maintainer decision B6b-D2).** 6b = the CLI work (Tasks 1–14 here); 6c = the POST route, the one Refresh control and Reload, read-only GET routes, and the dashboard half of the docs and ADRs (section "Deferred to Branch 6c"), started from `main` after 6b merges. The vocabulary guard in 6b covers CLI spellings only; 6c extends it with the dashboard spellings. — Dashboard strings legitimately exist until 6c; each pull request stays reviewable. — Cost if wrong (ledger): a dashboard string slips through until 6c's guard lands.
- **R17 — No legacy, "move fast and break" (maintainer decision B6b-D3).** Retired spellings get the parser's generic unknown-command/unknown-option error: no alias, no "is now" hint, no table of retired spellings in the parser. Docs — README, help, `docs/*.md` including `docs/UPGRADING.md`, and the installed guidance under `claude/` (for example `ruflo-reference-full.md`) — show only the new spellings, with no old → new tables and no new UPGRADING section for the renames. The old → new mapping appears only in the pull request body's "Breaking changes" section and, at release time, in the GitHub release notes (`release.yml` generates notes from PR titles, so the section is added when releasing). ADRs and audit records may still name old spellings, because they are history. — `docs/UPGRADING.md` is a user-facing current-state document under the standing docs rule. — Cost if wrong (ledger): a short section added to `UPGRADING.md` later.
- **R18 — Guard scope.** Task 13's guard scans `src/**` (comments included — they must describe current behaviour), `bin/**`, `claude/**`, `README.md` and `docs/**/*.md` except `docs/adr/`, `docs/audits/`, `docs/superpowers/` and `docs/research/`. In `src/lib/hook-audit/agentic-dependency-constraints.json` it parses the JSON and skips only the dated `watch[].history[].note` strings (history, like ADRs; e.g. the 2026-09-27 note at `:1657`); every other string, including `adjustment` (`:1017`), is scanned. — Rewriting a dated history note would falsify the record; the current-state fields must still be current. — Cost if wrong: one history note keeps an old spelling.

## File map (6b)

| File | Responsibility after this branch | Tasks |
|---|---|---|
| `src/lib/refresh.mjs` (new) | strengths, `normalizeBareRefresh`, `refreshRequestFromFlags`, `REFRESH_OPTIONS`, `REFRESH_STAGES`, `stagesFor`, `runRefresh`, `cliRefreshStages`, `printRefreshStage` | 2, 3, 4 |
| `src/lib/live-checks.mjs` (moved from `src/commands/x/verify.mjs`) | the live checks and slow proofs, `LIVE_CHECK_IDS`, `SLOW_PROOF_IDS`, `runLiveChecks` | 4, 7 |
| `src/commands/sync/plan-versions.mjs` (new) | plan-time version lookups: real, skipped, dry-run preview | 8, 9 |
| `src/commands/x/host-connection.mjs` (new) | `ak host check-connection` | 5 |
| `src/lib/host-connection-disclosure.mjs` (new) | `CONNECTION_CHECK_DISCLOSURE`, the one consent sentence shared by the CLI and the dashboard dialog | 5 |
| `src/lib/output.mjs` | gains `humanOutputToStderr` (moved) | 2 |
| `src/lib/config.mjs` | gains `configErrorRecovery(err, platform)` | 11 |
| `tests/kit/refresh-vocabulary-guard.test.mjs` (new) | no retired CLI spelling in the guarded tree (R18) | 13 |

---

## Closing this branch (maintainer, 2026-09-28; supersedes the restructure below)

The maintainer asked to bring this branch to a close at a natural breaking point. The dashboard tasks 6c-1 to 6c-5 move to the next remediation program. Tasks 13 and 14 run in their CLI-only form, as R16 specified:

- **Task 13:** the vocabulary guard covers CLI spellings only. Dashboard docs keep today's control names and state the new CLI equivalents beside them, as current fact.
- **Task 14:** records only what the CLI work made true. ADR-0063 gets a "Delivered" section and an "Ahead" section that names the dashboard half. No dashboard control is superseded yet.

The carry-ins listed below for Tasks 13 and 14 still apply, except the ones that belong to the dashboard half.

## Execution after the 2026-09-28 restructure (binding; supersedes R16's split)

The maintainer folded 6c back into this branch (decision M-6): one pull request carries the whole refresh vocabulary. Execution order: Tasks 1–12 → 6c-1 → 6c-2 → 6c-3 → Task 13 together with 6c-4 (one docs task; the vocabulary guard covers CLI and dashboard spellings) → Task 14 together with 6c-5 (one ADR task, including the supersessions of the dashboard controls). The 6c text below was verified against `31a1a39b`, so its implementers re-verify every file:line first. Run the branch gate after 6c-3 and after the final task.

Carry-ins assigned by rulings in the SDD ledger (each task's implementer does these too):

- **Task 10:**
  - `ak maintain <verb> --only …` and `--project-trees` without `--refresh` are usage errors (exit 2); today they are silently ignored.
  - `refreshedReport` builds `deps.service ?? createMaintenanceService()` even when `deps.refreshStages` is injected. Guard it the way `cliRefreshStages` guards a half-injected maintenance/management pair.
- **Task 11:**
  - A try/catch around `refreshPlanHosts` in `sync.mjs` that reports a failed probe.
  - `driftReport` and `selfDrift` (`versions.mjs`) follow the same failed-lookup rule as the Brain and ruvector: on total failure, keep the cached values and restamp the TTL stamp, but never under `record: false` or a cache-only read. Today an offline dashboard retries them on every poll.
  - The real (non-dry) sync test inside `withOpencodeCli` (`tests/kit/sync-command.test.mjs` ~1093) puts `/usr/bin` on PATH without injected version lookups. Inject them, so no test can query the real npm registry.
- **Task 12:** `reset-routes` in `ak host`'s help misaligns its column. Use the `check-connection` pattern: the name on its own line, the description on the next.
- **Task 13:**
  - Drop "(R17)" from three test assertion messages (`host-cli-migration.test.mjs` ~48, `provider-refresh-cli.test.mjs` ~244, `usage-cli.test.mjs` ~586).
  - Replace the ledger-only labels "B6b-D1" / "Branch 6b Task 1" in source and test comments with a reference to ADR-0010's update.
  - Remove the remaining `ak x verify` mentions in `src/` comments: `exec.mjs`, `output.mjs`, `harvest.mjs`, `ruflo-memory.mjs`, `mcp-tool-call.mjs`, `status/sections/project-memory.mjs`, and the registry's `adjustment` field.
- **Task 14:**
  - ADR-0063's sentence that says `setup.mjs` was extended, then lists `ak setup` as unaffected.
  - The dry-run preview (R8) and its host-evidence limitation.
  - The failed-lookup rule: keep the cached value, restamp the TTL stamp, and record `observedAt` for the observation time.

## Tasks (Branch 6b)

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14. Hard dependencies: 2 before 3, 4 and 13 (and before all of 6c — the audit's 6.8 → 6.10 rule: flag syntax before the dashboard control); 4 before 7 (the moved module); 5 → 6 → 12 (all edit `x/host.mjs`); 3 before 10 (both edit `maintain.mjs`); 8 → 9 → 11 (all edit `sync.mjs`); 13 before 14. Nothing in 6b depends on 6c. Run the branch gate set (common brief) after Tasks 4, 9 and 14.

### Task 1: Codex quota only when Codex is found (B6b-D1)

**Commit:** `fix(limits): ask Codex for its quota only when Codex is found`

**Files:**

- Modify: `src/lib/providers.mjs:226-236` — export `hostSetupInputsKey` and add `recordedHostPresence`.
- Modify: `src/lib/quota.mjs:299-301` (`CODEX_UNAVAILABLE_REASONS` gains `'host-not-found'`, `'host-unconfirmed'`), `:385-407` (extract a pure `readCodexLimitsCache({ cacheFile })`), `:447-458` (`readLimits` gains `codexPresence`).
- Modify: `src/lib/dashboard/client/usage.mjs:1161-1175` — `CODEX_WHY` and `CODEX_FAILED_SHORT` entries for both reasons (otherwise the panel falls back to its generic sentence).
- Modify: `src/lib/dashboard-server.mjs:1132-1140` — comment only (who decides presence); no logic.
- Test: `tests/kit/quota-codex-presence.test.mjs` (new).

**Interfaces:**

- Produces: `hostSetupInputsKey(host, env = process.env): string` (now exported, unchanged); `recordedHostPresence(hostId: string, { env?: NodeJS.ProcessEnv, now?: number } = {}): 'found' | 'not-found' | 'unconfirmed'`; `readLimits({ …existing, codexPresence?: () => 'found'|'not-found'|'unconfirmed' })`.

**Do not add a probe.** `recordedHostPresence` and `readLimits` must not call `have`, `detectHosts`, `collectIntegrationFacts`, `hostInstallState`, `hostExecutable` or spawn anything. Absent or stale evidence means "skip the spawn": the dashboard's own `/api/status` poll (`collect` → `collectIntegrationFacts` → `detectHosts`) records `host-setup` for every host, managed or not, on its next tick. Use `host-setup`, not `host-install-method` (recorded only for enabled hosts — an unmanaged Codex never gets one).

- [ ] **Step 1: Write the failing test.** In `sandboxHome('ak-quota-presence')`, seed evidence with `writeEvidence('host-setup', 'codex', { source: 'status', inputsKey: hostSetupInputsKey(codexHost), inputs: { PATH: process.env.PATH, bin: 'codex' }, result: { present } }, { now })` and a Codex cache file older than `CODEX_TTL_MS`. Pass a `spawnImpl` spy to `readLimits`.

```js
test('found Codex, stale cache: one app-server call', async () => { /* present:true → spy.calls.length === 1, args ['-s','read-only','-a','never','app-server'] */ });
test('not found: no spawn, host-not-found, cached figure still served', async () => { /* present:false → 0 calls; r.codexUnavailable.reason === 'host-not-found'; r.codex deepEquals the cache */ });
test('no evidence: no spawn, host-unconfirmed', async () => { /* 0 calls */ });
test('evidence older than 6 h: no spawn, host-unconfirmed', async () => { /* now = checkedAt + 6h + 1 */ });
test('evidence recorded under another PATH: no spawn, host-unconfirmed', async () => { /* change process.env.PATH after seeding */ });
test('found but unmanaged (kit.json hosts.codex false): still asked', async () => { /* 1 call — B6b-D1 */ });
test('found, fresh cache: no spawn (existing TTL)', async () => { /* 0 calls, unavailable null */ });
```

- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/quota-codex-presence.test.mjs` — expect the not-found/unconfirmed cases to FAIL with one spawn recorded.
- [ ] **Step 3: Implement.** `recordedHostPresence`: find the host in `HOSTS`; `readEvidence('host-setup', id, { inputsKey: hostSetupInputsKey(host, env), maxAgeMs: HOST_SETUP_MAX_AGE_MS, now })`; `null`/`stale`/`invalidated` → `'unconfirmed'`; else `result.present === true ? 'found' : 'not-found'`. In `readLimits`: `const presence = (codexPresence ?? (() => recordedHostPresence('codex', { now })))();` — `'found'` → existing `collectCodexLimitsDetailed`; otherwise `{ limits: readCodexLimitsCache({ cacheFile }), unavailable: { reason: presence === 'not-found' ? 'host-not-found' : 'host-unconfirmed' } }`. Client copy: `host-not-found` — "Codex is not installed on this machine (ak's last host check did not find the codex CLI), so its quota is not requested." / short "codex not found"; `host-unconfirmed` — "ak has not checked for Codex on this machine recently; the quota is requested once the dashboard's status check finds it." / short "not checked yet".
- [ ] **Step 4: Run to verify it passes,** plus neighbors: `env -u FORCE_COLOR node --test tests/kit/quota-codex-presence.test.mjs tests/kit/quota.test.mjs tests/kit/usage-limits-empty-state.test.mjs tests/kit/host-setup-evidence.test.mjs tests/kit/dashboard-status-cost.test.mjs`.
- [ ] **Step 5: Commit** (`git add` the five files by name).

**Acceptance:** zero spawns from `/api/limits` when presence ≠ found; the Limits panel names the reason; `tests/kit/dashboard-status-cost.test.mjs` unchanged and green.

### Task 2: One `--refresh` flag — the shared operation and `ak status`

**Commit:** `feat(refresh): one --refresh flag with live and machine strengths, starting with ak status`

**Files:**

- Create: `src/lib/refresh.mjs`.
- Modify: `bin/agentic-kit.mjs:153-163` (normalize before `parseArgs`), `:67` (help line `ak status … [--json] [--refresh[=live|machine]]`). Import `normalizeBareRefresh` statically; `refresh.mjs` must be cheap to import (no top-level import of status, live-checks, footprint or maintenance modules — lazy-import them inside `cliRefreshStages`).
- Modify: `src/commands/status.mjs` — options: remove `deep`, `live`; spread `REFRESH_OPTIONS`; rewrite help (only the new spellings; document the three strengths, their stages, the exit rule R15); `run({ flags, pkgRoot, deps = {} })` replaces the `runLive` parameter with `deps.refreshStages`; under `--json` wrap the whole run in `humanOutputToStderr`.
- Modify: `src/lib/output.mjs` — add `humanOutputToStderr(fn)` moved verbatim from `sync.mjs:976-994`; `src/commands/sync.mjs` imports it and deletes its copy (count must drop).
- Test: `tests/kit/refresh.test.mjs` (new); modify `tests/kit/status-command.test.mjs`, `tests/kit/status-live.test.mjs` (the `runStatus({live:true})` helpers at `:186-192` move to `refresh: 'live'` with injected stages), `tests/kit/cli-help.test.mjs:90-93`.

**Interfaces (Produces — later tasks and 6c rely on these exact names):**

```js
export const REFRESH_STRENGTHS = Object.freeze(['local', 'live', 'machine']);
export const REFRESH_OPTIONS = Object.freeze({
  refresh: { type: 'string' },
  'project-trees': { type: 'boolean', default: false },
}); // Task 4 adds `only: { type: 'string', multiple: true }`
export function normalizeBareRefresh(args /* string[] */) /* → string[] */;
export function refreshRequestFromFlags(flags)
  /* → { strength: null|'local'|'live'|'machine', projectTrees: boolean, only: string[] } | { error: string } */;
export const REFRESH_STAGES = Object.freeze([
  { id: 'machine', label: 'Measuring the machine', runsAt: ['machine'] },
  { id: 'maintenance', label: 'Refreshing Maintenance evidence', runsAt: ['local', 'live', 'machine'] },
  { id: 'inventory', label: 'Rebuilding the inventory', runsAt: ['local', 'live', 'machine'] },
  { id: 'live', label: 'Running live checks', runsAt: ['live'] },
  { id: 'local', label: 'Re-checking local evidence and versions', runsAt: ['local', 'live', 'machine'] },
]);
export function stagesFor(strength) /* → stage ids in order */;
/** stages: { [id]: (ctx) => Promise<{ ok: boolean, detail?: string|null, result?: any }> }
 *  ctx: { strength, projectTrees, only, results } (results = earlier stages' results by id)
 *  onStage(event): event = { id, label, state: 'running'|'done'|'failed'|'skipped', detail, elapsedMs } */
export async function runRefresh({ strength, projectTrees = false, only = [], stages, onStage = () => {}, now = Date.now })
  /* → { strength, ok: boolean, stages: Array<{ id, label, state, detail, elapsedMs, result? }> } */;
export function cliRefreshStages({ cwd, pkgRoot, deps = {} })
  /* → stages map; deps may carry collector, maintenance, management, collect, runLive */;
export function printRefreshStage(event) /* CLI renderer: one line per finished stage via ok/warn/info */;
```

`cliRefreshStages` builds **one** shared set lazily, as the dashboard does: `collector = deps.collector ?? createSystemCollector({ cwd })`, `maintenance = deps.maintenance ?? createMaintenanceService({ collector })`, `management = deps.management ?? createManagementService({ collector, maintenance })`. Stage bodies: `machine` → `collector.refreshDeep(projectTrees ? { includeProjectTrees: true } : undefined)` (ok = `result.ok === true && result.persisted?.ok !== false`); `maintenance` → `maintenance.scan({ deep: false })`; `inventory` → `strength === 'machine' ? management.rebuildAfterMeasurement() : management.refreshInventory({ deep: false })`; `live` → `runLiveChecks({ cfg: loadKitConfig(), cwd })` (from `src/commands/x/verify.mjs` until Task 4 moves it); `local` → `collect({ pkgRoot, cwd, refresh: true })` returning rows as `result`. Machine stages run under `withProgress(label, …)` so a minutes-long step shows elapsed time.

`status.run`: `const req = refreshRequestFromFlags(flags)`; on `req.error` print `ak status: <error>` with `fail()` and return 2. No strength → today's path (`collect({ pkgRoot, refresh: false })`). With a strength → `runRefresh({ …req, stages: deps.refreshStages ?? cliRefreshStages({ cwd, pkgRoot }), onStage: flags.json ? undefined : printRefreshStage })`; rows = the `local` stage's result (if that stage failed, fall back to `collect({ pkgRoot, refresh: false })` and append `row('refresh', 'warn', 'local re-check failed: <detail>')`); `live` = the `live` stage's result. JSON: `{ overall, rows, refresh: { strength, ok, stages: [{ id, label, state, detail, elapsedMs }] }, ...(live ? { live } : {}) }`. Exit: 1 when `worst === 'fail'` or `!refresh.ok`, else 0.

- [ ] **Step 1: Write the failing tests** (`tests/kit/refresh.test.mjs`):

```js
test('normalizeBareRefresh', () => {
  assert.deepEqual(normalizeBareRefresh(['--refresh']), ['--refresh=']);
  assert.deepEqual(normalizeBareRefresh(['--refresh', '--json']), ['--refresh=', '--json']);
  assert.deepEqual(normalizeBareRefresh(['--refresh', 'report']), ['--refresh=', 'report']); // never consumes a positional
  assert.deepEqual(normalizeBareRefresh(['--refresh=live']), ['--refresh=live']);
  assert.deepEqual(normalizeBareRefresh(['--', '--refresh']), ['--', '--refresh']);
});
test('refreshRequestFromFlags', () => { /* undefined/false → null; '' | true | 'local' → local; 'live'; 'machine';
  'bogus' → error naming "=live or =machine"; project-trees without machine → error "--project-trees needs --refresh=machine" */ });
test('stagesFor', () => { /* local → [maintenance, inventory, local]; live → [maintenance, inventory, live, local];
  machine → [machine, maintenance, inventory, local] */ });
test('runRefresh runs stages in order and reports each', async () => { /* spies record order; onStage running→done */ });
test('a failed machine stage skips maintenance and inventory; local still runs; ok false', async () => {});
test('a throwing stage is failed with its message; later independent stages still run', async () => {});
test('the refresh operation can never reach the paid connection check (R7)', () => {
  // read src/lib/refresh.mjs as text; 6c-1 adds src/lib/dashboard/refresh-api.mjs to this list
  assert.doesNotMatch(source, /checkConnection|host-health-connected/);
});
```

In `tests/kit/status-command.test.mjs`: `run({ flags: { refresh: '', json: true }, pkgRoot, deps: { refreshStages: fakes } })` with fakes that call `ok()`/`warn()` — capture stdout and `JSON.parse` it whole; it carries `refresh.stages` in order. A `live` fake that calls `warn('memory: could not remember this live check result; ak status will not show it')` (the unwritable-evidence path) under `refresh: 'live', json: true` → stdout still parses as one JSON object (item 10's status sub-item). Child-process checks with `spawnEnv(home)`: `node bin/agentic-kit.mjs status --deep` and `status --live` exit 2 with the parser's generic unknown-option error (no hint, R17); `status --refresh=bogus` exits 2.

- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/refresh.test.mjs tests/kit/status-command.test.mjs` — FAIL: module not found; `--deep` accepted.
- [ ] **Step 3: Implement** as specified above; update `cli-help.test.mjs` to assert `ak --help`'s status line shows `--refresh[=live|machine]` and not `--live`/`--deep`.
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/status-live.test.mjs tests/kit/status-zero-spawn.test.mjs tests/kit/sync-command.test.mjs tests/kit/output-capture.test.mjs tests/kit/cli-help.test.mjs`, and the line probe (sync.mjs < 832).
- [ ] **Step 5: Commit** (`git add src/lib/refresh.mjs bin/agentic-kit.mjs src/commands/status.mjs src/lib/output.mjs src/commands/sync.mjs tests/kit/refresh.test.mjs tests/kit/status-command.test.mjs tests/kit/status-live.test.mjs tests/kit/cli-help.test.mjs`).

**Acceptance:** plain `ak status` behaviour and the zero-spawn test unchanged; `ak status --refresh[=…] --json` prints exactly one JSON object on stdout; no test in the branch passes a strength without injected stages or a sandbox home.

### Task 3: `ak system` and `ak maintain` take the same flag

**Commit:** `feat(refresh): ak system and ak maintain take the same --refresh flag`

**Files:**

- Modify: `src/commands/system.mjs` — options: remove `deep`, spread `REFRESH_OPTIONS`; help (`ak system [--refresh[=live|machine]] [--project-trees] [--json]`); `run({ flags, deps })` runs `runRefresh` with `cliRefreshStages({ cwd, pkgRoot, deps: { collector } })` (the command's own collector, so the read after the refresh sees it) before `collector.read()`; JSON adds `refresh` only when refreshed; exit per R15. Wording: "deep scan" → "machine measurement" (`:122-151,235-237,301-303,324-330,343-349,385-390`), hints read `run: ak system --refresh=machine`.
- Modify: `src/commands/maintain.mjs` — options: remove `deep`, `refresh-inventory`; spread `REFRESH_OPTIONS`; DISPATCH: remove `scan`, add `report` (`service.report()`, `rawJson: true`, heading "Maintenance — findings from the last measurement"); default verb `report` (`:856`); `--refresh` only with `report` (else `usageError('--refresh applies to ak maintain report; run it first, then this verb')`); `scansStart` (`:661-664`) stops passing `deep`; `dispatchPlan` (`:297`) stops passing `deep`; help `:63-170` rewritten (drop `scan [--deep] [--refresh-inventory]`, `scans start … [--deep]`, and the Compatibility sentence naming the old measurement spelling); the empty-inventory hint (`:447`) reads `Run: ak maintain --refresh.`; `resolveManagement`/service construction for `report --refresh` goes through `cliRefreshStages` so one collector is shared.
- Modify: `src/lib/maintenance/service.mjs:61` — the not-scanned `nextAction.steps` text ("Use Rescan in System …") → "Run `ak maintain --refresh=machine` to measure the machine." (CLI spelling only; the dashboard half, "or Refresh › Machine in the dashboard", is added by 6c-2 when that control exists); `src/lib/maintenance/management/service-discovery.mjs:134` comment.
- Modify: `bin/agentic-kit.mjs:74-75` help lines.
- Test: `tests/kit/system-command.test.mjs` (new); modify `tests/kit/maintenance-cli.test.mjs`.

**Interfaces:** Consumes Task 2's `REFRESH_OPTIONS`, `refreshRequestFromFlags`, `runRefresh`, `cliRefreshStages`, `printRefreshStage`.

- [ ] **Step 1: Write the failing tests.** `system-command.test.mjs` with a fake collector (`read`, `refreshDeep` spies) and injected `deps.refreshStages`: `run({ flags: {} })` never calls `refreshDeep`; `run({ flags: { refresh: 'machine', 'project-trees': true } })` runs stages `machine, maintenance, inventory, local` in order and the machine stage receives `projectTrees: true`; a failed machine stage → exit 1; `--json` stdout parses and carries `refresh` only when refreshed. `maintenance-cli.test.mjs`: bare `run({ flags: {}, positionals: [] })` calls `service.report`, never `service.scan`; `positionals: ['scan']` → exit 2 usage; `['inventory']` with `refresh: ''` → exit 2; `scans start` with a management spy never receives `deep`; child spawns (`spawnEnv`) of `ak maintain --deep` and `ak maintain --refresh-inventory` exit 2 with the generic unknown-option error.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/system-command.test.mjs tests/kit/maintenance-cli.test.mjs`.
- [ ] **Step 3: Implement** as listed.
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/maintenance-one-action.test.mjs tests/kit/maintenance-management-service.test.mjs tests/kit/refresh.test.mjs tests/kit/cli-help.test.mjs`.
- [ ] **Step 5: Commit** (files by name).

**Acceptance:** `ak system` and bare `ak maintain` read only; every strength on all three commands runs the same stages with the same labels.

### Task 4: Fold `ak x verify` into `ak status --refresh=live`

**Commit:** `refactor(verify): fold ak x verify into ak status --refresh=live`

**Files:**

- Move: `git mv src/commands/x/verify.mjs src/lib/live-checks.mjs`; fix its relative imports (`../../lib/x.mjs` → `./x.mjs`); delete its `options`, `help`, `run`; keep every check function.
- Modify: `src/lib/live-checks.mjs` — each check entry gains `timeoutMs` (quick checks 60 s; slow proofs 360 s) and `evidenceId` (`null` for `learning`/`harvest`; `'memory'` for `memory-routes`; the full `aqe` proof records only its embedding request through `onEvidence`, as `runRememberedSuite` did at `verify.mjs:624-629`). Export `LIVE_CHECK_IDS = ['aqe-embedding','mcp','providers','security','deja-vu','memory']` and `SLOW_PROOF_IDS = ['learning','harvest','aqe','memory-routes']`. `runLiveChecks({ cfg, cwd, checks, only, timeoutMs, graceMs, source = 'status-refresh-live' })`: with `only`, run exactly those ids (a named check runs even when its `applies(cfg)` is false, as a named suite always did); without, `liveChecksFor(cfg)` (so `mcp` runs whenever Codex is enabled — the omitted-`mcp` defect is gone). Each result keeps its captured lines (`entries`) for the human renderer. Comments in the moved file describe the current commands only (R18).
- Modify: `src/lib/refresh.mjs` — `REFRESH_OPTIONS.only = { type: 'string', multiple: true }`; `refreshRequestFromFlags` splits comma lists, rejects unknown names with the accepted list, rejects `--only` unless the strength is `live`; `cliRefreshStages` live stage imports `./live-checks.mjs` and passes `only`.
- Modify: `src/commands/status.mjs` — human output: one line per check (`✓ security passed (3 s)` / `⚠ memory failed — reason`); with `--only`, each check's captured lines indented under it; exit rule R4.
- Modify: `bin/agentic-kit.mjs:56,108` — remove the `verify` PLUMBING entry and its `HELP_ALL` line.
- Modify: `src/lib/live-check-evidence.mjs:197` — `SOURCE_LABEL` per R13 (and its header comment `:3-10`); `src/commands/status/sections/live-checks.mjs:2,19` (`recheck: 'ak status --refresh=live'`), `status/sections/aqe.mjs:14,36,75` (`ak status --refresh=live --only aqe`), `src/lib/ruflo-memory-contract.mjs:11,23,51` (`ak status --refresh=live --only memory-routes`).
- Modify: `src/lib/hook-audit/agentic-dependency-constraints.json:1015,1650,2616` — `src/commands/x/verify.mjs` → `src/lib/live-checks.mjs` (else `tests/kit/upstream-watch-registry.test.mjs:281` fails).
- Modify: `.github/workflows/nightly.yml:62` → `node bin/agentic-kit.mjs status --refresh=live --only security`; `:97` → `… --only learning`; the comment at `:88` names `--only memory-routes`.
- Test: rename `git mv tests/kit/verify-command.test.mjs tests/kit/live-checks.test.mjs` and retarget it at `runLiveChecks({ only: [...] })` / `status.run`; update imports in `tests/kit/status-live.test.mjs`, `tests/kit/verify-memory-routes.test.mjs`, `tests/kit/aqe-readiness.test.mjs`, `tests/kit/agentdb-retirement.test.mjs`, `tests/kit/deja-vu-teardown-verify.test.mjs`, `tests/live/ruflo-memory-routing.test.mjs`; `tests/kit/cli-help.test.mjs:43` drops `['x','verify']` and asserts `ak x verify` exits 2 with the generic unknown-plumbing-command error.

**Interfaces:**

- Consumes: `refreshRequestFromFlags`, `cliRefreshStages` (Task 2).
- Produces: `src/lib/live-checks.mjs` exports `runLiveChecks`, `liveChecksFor`, `LIVE_CHECK_IDS`, `SLOW_PROOF_IDS`, `verifySecurity`, `verifyMemory`, `verifyProviders`, `verifyAqe`, `verifyMcp`, `verifyDejaVu`, `verifyHarvest`, `verifyLearning`, `checkAqeEmbedding`, `aqeEmbeddingManaged`, `probeProjectMemoryRoutes`, `parseDefendVerdict` (same signatures as today). 6c-1's live stage consumes `runLiveChecks`.

**The flake (report on it explicitly).** `tests/kit/verify-command.test.mjs:197-205` diffs the shared `os.tmpdir()` by prefix while `tests/kit/verify-memory-routes.test.mjs:229-236` runs the same `verifyMemory` in another test process. Before changing the test: run both files concurrently 20 times (`for i in $(seq 20); do env -u FORCE_COLOR node --test tests/kit/verify-command.test.mjs tests/kit/verify-memory-routes.test.mjs || echo "FAIL $i"; done`) and record whether the assertion fails. Then give `verifyMemory` and `verifyLearning` an injectable `tmpRoot` (default `os.tmpdir()`), and assert the "no temp directory left behind" cases against a private `mkdtempSync` root. The report must say whether the rewrite **resolves** (the race reproduced before and cannot occur after), **preserves** (not reproduced; the new assertion is at least as strict), or **masks** it — with the loop's output as evidence.

- [ ] **Step 1: Write the failing tests** (in `tests/kit/live-checks.test.mjs`): `refreshRequestFromFlags({ refresh: 'live', only: ['security,memory'] })` → `only: ['security','memory']`; `only` with bare refresh → error; `only: ['bogus']` → error listing `LIVE_CHECK_IDS` and `SLOW_PROOF_IDS`; `runLiveChecks({ only: ['learning'] })` runs the learning proof with a 360 s timeout and records no evidence; `runLiveChecks({ cfg: { integrations: { hosts: { codex: true } } } })` includes `mcp`; `status.run({ flags: { refresh: 'live', only: ['security'] }, deps })` exits 1 when the named check fails and 0 when it passes, while `refresh: 'live'` without `only` exits 0 on a failed check; `--json` carries `live`. Keep every existing suite-behaviour assertion (security absent → failed with "@claude-flow/security missing", providers drift, harvest never skips to a pass, the aqe oversized-RVF case, remembered-evidence cases) retargeted through `runLiveChecks({ only })`.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/live-checks.test.mjs tests/kit/refresh.test.mjs`.
- [ ] **Step 3: Implement** (the move, then the options, then status rendering, then callers, registry paths and workflow).
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/status-live.test.mjs tests/kit/verify-memory-routes.test.mjs tests/kit/aqe-readiness.test.mjs tests/kit/agentdb-retirement.test.mjs tests/kit/deja-vu-teardown-verify.test.mjs tests/kit/live-check-evidence.test.mjs tests/kit/upstream-watch-registry.test.mjs tests/kit/cli-help.test.mjs tests/kit/ga-surface-guard.test.mjs`, then the gate set.
- [ ] **Step 5: Commit** (files by name, including the two `git mv`s and `.github/workflows/nightly.yml`).

**Acceptance:** `ak x verify` exits 2 (generic unknown plumbing command); `nightly.yml` still fails its security step on a failed proof; the flake verdict is in the report.

### Task 5: Consent-gated connection check from the CLI

**Commit:** `feat(host): consent-gated connection check from the CLI`

**Files:**

- Create: `src/commands/x/host-connection.mjs` — `run({ flags, positionals, deps = {} })`.
- Create: `src/lib/host-connection-disclosure.mjs` — `export const CONNECTION_CHECK_DISCLOSURE` (the exact sentence now in `page.mjs:160`; a tiny module so neither the CLI nor `page.mjs` imports the host-readiness stack for one string).
- Modify: `src/commands/x/host.mjs:90-113,176-193` — `check-connection` subcommand (lazy import), help, unknown-subcommand list; keep `host.mjs`'s own line count flat.
- Modify: `src/lib/dashboard/page.mjs:160` — render the disclosure from the import (escaped). A static string swap; it does not depend on 6c's dialog changes (6c-2 edits the buttons at `:162`, not this paragraph).
- Modify: `bin/agentic-kit.mjs:80,103` help lines.
- Test: `tests/kit/host-connection-cli.test.mjs` (new).

**Behaviour:** `reader = deps.createReader?.() ?? createHostReadinessReader({ cwd: process.cwd() })`; `view = await reader({ force: true })`; `entry = view.hosts[host]`; unknown host → exit 2; `!entry.canCheckConnection` → `fail(entry.connectionUnavailable)`, exit 2, no probe; print host, model/provider target and `CONNECTION_CHECK_DISCLOSURE`; `--dry-run` → "dry run — no request sent", exit 0; consent: `--yes`, else TTY `[y/N]` (the `askCodexRepair` pattern, `sync.mjs:52-60`), else non-TTY → `fail('the connection check sends a paid request; re-run with --yes to confirm')`, exit 2; `await reader.checkConnection({ host, confirm: true, evidenceKey: entry.evidenceKey })`; print state, reason, model; `--json` → `{ host, connection }` on stdout (human lines to stderr); exit 0 for `pass`, 1 otherwise; `finally reader.close()`.

- [ ] **Step 1: Write the failing test** with a fake reader (`read` returns a view; `checkConnection` spy): unmanaged host → exit 2 and zero probe calls; non-TTY without `--yes` → exit 2, zero calls; `--yes` → exactly one call with `confirm: true` and the view's `evidenceKey`; `--dry-run --yes` → zero calls, disclosure printed; `--json` stdout parses; a reader that throws "Health evidence is stale" → exit 1 with that message; the printed disclosure equals `CONNECTION_CHECK_DISCLOSURE`, and the rendered dashboard page contains the same (escaped) sentence.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/host-connection-cli.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/host-readiness.test.mjs tests/kit/host-health-connected.test.mjs tests/kit/host-management.test.mjs tests/kit/cli-help.test.mjs`, and `env -u FORCE_COLOR node scripts/run-tests.mjs exec -- --test tests/ui/host-readiness.mjs` (the disclosure still renders).
- [ ] **Step 5: Commit.**

**Acceptance:** no test performs a real inference; nothing under `--refresh` reaches this code (Task 2's static assertion).

### Task 6: Rename operations that are not refreshes

**Commit:** `refactor(cli): rename operations that are not refreshes`

**Files:**

- Modify: `src/commands/x/host.mjs:58,99-101,140,159,182,192,365-410` — `refresh` → `reset-routes` (function `resetRoutes`; prompt "reset which activities? …"; messages "no routes reset — routes left as they are" and "reset N route(s) to the current defaults: …"; `--activity` help names `reset-routes`).
- Modify: `src/lib/providers.mjs:750`, `src/commands/status/sections/routing.mjs:30,38`, `src/lib/dashboard/client/intelligence.mjs:206` (tells users which command adopts the default route — now `ak host reset-routes`), comments `src/lib/routing.mjs:135`, `src/lib/dashboard-server.mjs:421`, `src/commands/sync.mjs:612`.
- Modify: `src/commands/usage.mjs:31,46,50,68,81,981` — `deep` → `show-text`; heading "Deep pass — verbatim exemplars" → "Prompt text — verbatim exemplars" (`:939`); comments `src/lib/usage-aggregate.mjs:91`, `src/commands/usage/deep-pass.mjs`.
- Modify: `bin/agentic-kit.mjs:71,80,103` help lines.
- Test: modify `tests/kit/provider-refresh-cli.test.mjs` (spawns `host reset-routes`; `host refresh` → exit 2 with the generic unknown-subcommand error), `tests/kit/routing-divergence.test.mjs` (hint text), `tests/kit/usage-cli.test.mjs:511+` (`--show-text`; `--deep` → exit 2 with the generic unknown-option error).

- [ ] **Step 1: Write the failing assertions** above.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/provider-refresh-cli.test.mjs tests/kit/routing-divergence.test.mjs tests/kit/usage-cli.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `tests/kit/cli-help.test.mjs tests/kit/ga-surface-guard.test.mjs tests/kit/dashboard-intel-integration.test.mjs`.
- [ ] **Step 5: Commit.**

### Task 7: The security check scans the project folder and says so

**Commit:** `fix(security-check): scan the project folder and say so`

**Files:**

- Modify: `src/lib/live-checks.mjs` (`verifySecurity`, formerly `verify.mjs:246-275`; the `security` entry of `LIVE_CHECKS`, formerly `:646`).
- Test: `tests/kit/live-checks.test.mjs`.

**Behaviour:** `verifySecurity({ runner = runCmd, cwd = process.cwd() } = {})`; `const root = repoRoot(cwd)`; outside a repository → `info('secrets scan skipped: not inside a repository')`, no runner call; inside → `runner('ruflo', ['security', 'secrets', '--path', '.'], { cwd: root, timeout: 120_000 })` (the folder travels as `cwd`, never as an argument, so no Windows path passes through `.cmd` shim quoting) and print `secrets scan of <root>: no secrets found` (exit 0) or `secrets scan of <root> reported findings or could not run (exit N) — run: ruflo security secrets --path . in <root>` (warn). The `security` live check passes `ctx.cwd`. The proof's verdict still depends only on the packages and `defend` (unchanged).

- [ ] **Step 1: Write the failing tests** with a runner spy: from a subfolder of a sandbox repo (create `.git/` as a folder; `repoRoot` checks existence) the secrets call has `opts.cwd === root` and args ending `['--path', '.']`, and the printed line names the root; from a sandbox folder with no `.git` above it the runner is never called for `secrets` and the skip line prints; the verdict is unchanged by a non-zero secrets exit.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/live-checks.test.mjs`.
- [ ] **Step 3: Implement.** Re-check that `ruflo security secrets --path` exists in the newest Ruflo inside the support window before the PR (verified in 3.47.0, `security.js:772`).
- [ ] **Step 4: Run to verify it passes,** plus `tests/kit/security-status.test.mjs tests/kit/status-live.test.mjs`.
- [ ] **Step 5: Commit.**

### Task 8: `--skip versions` also skips the online version lookup

**Commit:** `fix(sync): --skip versions also skips the online version lookup`

**Files:**

- Create: `src/commands/sync/plan-versions.mjs` — `refreshPlanVersions` (moved from `sync.mjs:108-127` and extended) and `skippedVersionEvidence`.
- Modify: `src/commands/sync.mjs:1060-1109,1198-1200,1224` — call the new module after `parseSkip`; pass `versionEvidence` into both `collectFn` calls; the health snapshot's `driftOutdated` uses cache-only data when `versions` is skipped. `converge` gains an injectable `brainDrift = ruvnetBrainDrift`.
- Modify: `src/commands/status.mjs:95-125` — `collect({ …, versionEvidence })` puts it on `ctx`.
- Modify: `src/commands/status/sections/versions.mjs:23-37`, `self.mjs:7-10`, `ruvnet-brain.mjs:111-115` — use `ctx.versionEvidence?.drift` / `?.self` / `?.brain` when present, and `ctx.versionEvidence?.cfg ?? loadConfig()` for the support-window row.
- Modify: `src/lib/versions.mjs` — export `cachedOnlyLatest = async () => null` (a `fetchLatest` that never touches the network; `driftReport` then saves nothing because no probe succeeded, `versions.mjs:95-98`).
- Test: `tests/kit/sync-skip-versions.test.mjs` (new); modify `tests/kit/sync-command.test.mjs` (exact `collectFn` argument assertions).

**Interfaces (Produces):**

```js
/** Real sync: the forced lookups for every part --skip does not name (versions: driftReport + Ruflo release dates;
 *  self: selfDrift; ruvnet-brain: brainDrift when cfg.ruvnetBrain). Returns versionEvidence for the skipped parts only. */
export async function refreshPlanVersions({ flags, skip, pkgRoot, fetchLatest, releaseDatesRunner, brainDrift })
  /* → { versionEvidence: { drift?, self?, brain?, cfg? } } */;
/** Cache-only results (no network, no write) for the parts --skip names; recomputed for the converge proof so
 *  `installed` is read after the apply phase. */
export async function skippedVersionEvidence({ skip, pkgRoot }) /* → { drift?, self?, brain? } */;
```

For a real sync that skips nothing, `versionEvidence` is empty and the sections read the TTL cache the forced lookups just wrote — today's behaviour. The converge proof never reuses plan-time evidence for a part that was not skipped (installed versions changed during the apply).

- [ ] **Step 1: Write the failing tests.** Seed `kit.json` with `versionCheck.last` two days old (so a plain collect would fetch). `run({ flags: { skip: ['versions'], yes: true }, pkgRoot, fetchLatest: spy, releaseDatesRunner: spy2, brainDrift: spy3 })` in `sandboxHome`: `fetchLatest` never called for `ruflo`/`agentic-qe`, `releaseDatesRunner` never called, and `kit.json`'s `versionCheck` byte-identical afterwards; `skip: ['self']` → no `fetchLatest` call for the kit's own package; `skip: ['ruvnet-brain']` with `cfg.ruvnetBrain` on → `brainDrift` never called with `force: true`; no `--skip` → all three called (baseline). Section-level: `versions.collect({ versionEvidence: { drift: rows }, drift: spy })` → spy not called.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/sync-skip-versions.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `tests/kit/sync-command.test.mjs tests/kit/sync-self-freshness.test.mjs tests/kit/brain-held-refresh-sync.test.mjs tests/kit/status-version-drift-refresh.test.mjs tests/kit/status-zero-spawn.test.mjs`, and the line probe (≤ 832).
- [ ] **Step 5: Commit.**

### Task 9: `ak sync --dry-run` previews the online lookup without recording it

**Commit:** `fix(sync): --dry-run previews the online version lookup without recording it`

**Files:**

- Modify: `src/lib/versions.mjs:71-99,147-175` — `driftReport({ …, record = true })`, `selfDrift({ …, record = true })`: `record: false` skips `saveKitConfig`.
- Modify: `src/lib/ruvnet-brain.mjs:269-290` — `drift({ force, record = true, fetchImpl })`; `record: false` skips the save (and `latestRelease` gets the injected `fetchImpl`); a failed fetch keeps the cached `latest` (see "A failed lookup never erases a good one" below).
- Modify: `src/lib/ruvector.mjs:45` — the same failed-fetch rule for `drift()`.
- Modify: `src/commands/sync/plan-versions.mjs` — `previewPlanVersions({ skip, pkgRoot, fetchLatest, releaseDatesRunner, brainDrift, tmpRoot = os.tmpdir() })`.
- Modify: `src/commands/sync.mjs` — under `--dry-run`, call `previewPlanVersions` instead of `refreshPlanVersions` and pass its `versionEvidence` to the plan read; help text (`:164-166,209`): "`--dry-run  print the plan and stop; like a real sync it checks the latest versions online first, and records nothing`".
- Test: `tests/kit/sync-dry-run-preview.test.mjs` (new).

**Behaviour (R8):** `previewPlanVersions` creates `fs.mkdtempSync(path.join(tmpRoot, 'ak-sync-preview-npm-'))`; its default `fetchLatest` is `(pkg, tag) => latestVersion(pkg, tag, { runner: (cmd, args, o) => run(cmd, args, { ...o, env: { npm_config_cache: dir, npm_config_logs_max: '0', npm_config_update_notifier: 'false' } }) })` (`exec.run` merges `opts.env`, `exec.mjs:214`; precedent `aqe-store-merge.mjs:249`); it runs `driftReport({ force: true, record: false, fetchLatest })`, `selfDrift({ pkgRoot, force: true, record: false, fetchLatest })`, `brainDrift({ force: true, record: false })` when enabled, and `recordRufloReleaseDates({ cfg: structuredClone(loadKitConfig()), runner })` on the copy — where `runner` is **the same redirected npm runner** (that function spawns `npm view ruflo time --json`, `src/lib/ruflo-support-window.mjs:87`; handing it the plain `run` would write `~/.npm` again); it returns `{ versionEvidence: { drift, self, brain, cfg: copy }, online }` where `online` is true when at least one lookup answered; `finally` removes the temporary folder (`fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })` — product code removing its own folder). Parts `--skip` names are not looked up (Task 8's cache-only evidence). When `online` is false, sync prints one `info` line: "versions not checked online (offline or timed out); this plan uses the versions ak recorded <age> ago".

- [ ] **Step 1: Write the failing tests.** Seed `kit.json` with a **fresh** (1 h old) `versionCheck` saying ruflo is current. `run({ flags: { 'dry-run': true, json: true }, fetchLatest: newerRuflo, … })` → the JSON `plan` contains the `versions` upgrade row; `kit.json` and the whole sandbox HOME are unchanged (`snapshot`/`assertUnchanged` from `home-sandbox.mjs`). `fetchLatest` that always returns `null` → plan from the cache, and stderr (or stdout without `--json`) contains "versions not checked online". A dry run with `versionCheck.last` two days old also leaves `kit.json` unchanged (the defect in the premise table). POSIX-only (skip on win32, as `status-live.test.mjs:117` does): a fake `npm` first on `PATH` records its arguments with `$npm_config_cache` and `$npm_config_logs_max` for **every** invocation — both the `npm view <pkg>@<tag> version` calls and the `npm view ruflo time --json` release-dates call carry a cache path that starts with the injected `tmpRoot` and the prefix `ak-sync-preview-npm-`, and that folder no longer exists after the run.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/sync-dry-run-preview.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `tests/kit/sync-command.test.mjs` (its strict dry-run hermeticity test must still pass), `tests/kit/sync-skip-versions.test.mjs tests/kit/versions*.test.mjs tests/kit/ruvnet-brain*.test.mjs`, the line probe, then the gate set.
- [ ] **Step 5: Commit.**

**A failed lookup never erases a good one (maintainer decision, 2026-09-28).** `drift()` in `src/lib/ruvnet-brain.mjs:269-290` and `src/lib/ruvector.mjs:45` today saves `latest: null` with a fresh `last` timestamp when a forced fetch fails. That hides the last known latest version for a full TTL window, and every `ak status --refresh` forces the fetch. Fix both in this task, test-first: when the fetch returns nothing, keep the cached `latest` (and `releaseAssetAvailable`) and do not restamp `last`, so the next call retries. Tests: seed a cached `latest`; a forced fetch that returns `null` leaves `kit.json`'s value and `last` unchanged and the returned drift still reports the cached `latest`. Do the same for `ruvector.mjs`.

**Known limitation to state in the help and ADR-0063, not fix:** a dry run still reads host evidence from the cache (`refreshPlanHosts` persists, so it stays skipped under `--dry-run`, `sync.mjs:140-149`); host evidence expires in 6 h.

### Task 10: Remove recipe refresh until a registry exists

**Commit:** `refactor(maintain): remove recipe refresh until a registry exists`

**Files:**

- Modify: `src/commands/maintain.mjs:97,161-163,786-798` — `recipes list|accept|withdraw` only.
- Modify: `src/lib/dashboard/maintenance-security.mjs:50` (drop the `recipesRefresh` route), `src/lib/dashboard/maintenance-api.mjs:1059` (and `publicRecipeRefresh` if now unused). These are server-side route removals with no dashboard control behind them; they do not touch 6c's files or contracts.
- Modify: `src/lib/maintenance/management/service.mjs:33,59-61,68-69,92-95,134`, `service-actions.mjs:59-72`, `service-context.mjs:44,51,66` — remove `refreshRecipes` from the facade and the `recipeRegistry`/`fetchImpl` options that exist only for it (grep both names first; keep anything another path uses).
- Keep: `maintenance/management/recipes.mjs` `refreshRecipes` and its tests (R14).
- Test: modify `tests/kit/maintenance-cli.test.mjs:239,847,892`, `tests/kit/maintenance-dashboard-v2-api.test.mjs:154,318`.

- [ ] **Step 1: Failing assertions:** `ak maintain recipes refresh` → exit 2 with usage "recipes list|accept|withdraw"; `POST /api/maintenance/v2/recipes/refresh` → 405; the facade has no `refreshRecipes`; list/accept/withdraw unchanged.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/maintenance-cli.test.mjs tests/kit/maintenance-dashboard-v2-api.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `tests/kit/maintenance-management-procedures.test.mjs tests/kit/maintenance-dashboard-security.test.mjs`.
- [ ] **Step 5: Commit.**

### Task 11: `--json` failures stay JSON; `--skip` lines print once

**Commit:** `fix(cli): --json failures stay JSON and keep their recovery text; --skip lines print once`

**Files:**

- Modify: `bin/agentic-kit.mjs:166-181` — on a parse error, when the command declares `json` and `rest` contains `--json`: write `mod.jsonUsageError?.(message) ?? { error: message, exitCode: 2 }` as one JSON object on stdout; the message and help go to stderr; exit 2. `:246-262` — `reportFatal` uses `configErrorRecovery`; when the invocation had `--json`, stdout gets `{ error, recovery }` and the human recovery lines go to stderr.
- Modify: `src/lib/config.mjs` — `configErrorRecovery(err, platform = process.platform)` → `{ backup, commands: string[], note }` (the exact commands `reportFatal` prints today, including the `Move-Item` form on win32).
- Modify: `src/commands/sync.mjs` — export `jsonUsageError(message)` returning the empty result shape (`{ plan: [], steps: [], unresolved: [], skipped: [], needsYourAction: [], converged: null, exitCode: 2, error: message }`, shared with `run`'s initial literal); the `--json` catch (`:1050-1052`) adds `recovery` for a `KitConfigError` and prints the recovery lines to stderr; `reportVerdict` (`:998-999`) prints only skipped items not already announced by `announcePlan` (compare by `repairKey`); update the `--json` help paragraph (`:195-204`) to name `recovery`.
- Test: `tests/kit/cli-json-honesty.test.mjs` (new); modify `tests/kit/sync-command.test.mjs`.

- [ ] **Step 1: Failing tests** (child processes with `spawnEnv`): `ak sync --json --bogus` → exit 2, stdout parses to the sync result shape with `error`; `ak status --json --bogus` → stdout parses to `{ error, exitCode: 2 }`; an invalid `kit.json` in the sandbox → `ak sync --json` stdout has `error` and `recovery.commands[0]` matching `/^mv -- |^Move-Item /`, and `ak status --json` stdout has the same `recovery`; in-process: a sync with `--skip ruvnet-brain --yes` and an injected `collectFn` returning a planned `ruvnet-brain` row plus one other planned row prints `skipped by request: [ruvnet-brain]` exactly once (the JSON `skipped` array unchanged).
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/cli-json-honesty.test.mjs tests/kit/sync-command.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `tests/kit/sync-needs-your-action.test.mjs tests/kit/cli-help.test.mjs`, and the line probe (≤ 832).
- [ ] **Step 5: Commit.**

### Task 12: Honor `ak host --dry-run`; the bare `ak` hint counts rows without a fix

**Commit:** `fix(cli): honor ak host --dry-run; the bare ak hint counts rows without a fix`

**Files:**

- Modify: `src/commands/x/host.mjs` — `pick`: after `resolvePickDecision` (in-memory only) and the trust manifest listing (no prompt under `--dry-run`), print the resolved hosts, primary host, AQE provider, fallback chain and route changes, then "dry run — nothing changed" and return 0 before `retireCodexOnDisable`/`saveKitConfig` (`:996-1001`); `off` (`:413-450`): print what it would reset and stop before any write; `reset-routes`: print the diverged table and the activities it would reset, stop before `saveKitConfig`; `adapters`: `--dry-run` → exit 2 "ak host adapters has no preview; run it without --dry-run"; `status`/`align`: unchanged. Help documents `--dry-run` per subcommand.
- Modify: `src/commands/status.mjs:173-185` — extract `hintLines(rows, worst)` (exported, pure); rows at warn/fail with no fix are counted: with no sync or manual fixes → "N item(s) need attention and have no automatic fix — see the rows above" and no `ak sync` suggestion; otherwise append "· N more have no fix (see above)".
- Test: `tests/kit/host-dry-run.test.mjs` (new), `tests/kit/status-hint.test.mjs` (new).

- [ ] **Step 1: Failing tests.** Child processes with `spawnEnv` and a sandbox project: `ak host pick --host claude,codex --dry-run --yes`, `ak host off --dry-run`, `ak host reset-routes --dry-run --yes` each exit 0, print "dry run", and leave the sandbox HOME and project byte-identical (`snapshot`/`assertUnchanged`); `ak host adapters list --dry-run` exits 2. `hintLines`: only `fix: null` warns → no "ak sync"; mixed → both counts.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/host-dry-run.test.mjs tests/kit/status-hint.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `tests/kit/host-cli-migration.test.mjs tests/kit/host-defaults.test.mjs tests/kit/hosts.test.mjs tests/kit/status-command.test.mjs tests/kit/host-alignment.test.mjs`.
- [ ] **Step 5: Commit.**

### Task 13: CLI help, README, docs and installed guidance speak the new CLI vocabulary

**Commit:** `docs: align help, README and docs with the CLI refresh vocabulary`

**Files:**

- Create: `tests/kit/refresh-vocabulary-guard.test.mjs` — modeled on `tests/kit/ga-surface-guard.test.mjs`, with R18's scope: `src/**` (comments included), `bin/**`, `claude/**`, `README.md`, and `docs/**/*.md` except `docs/adr/`, `docs/audits/`, `docs/superpowers/`, `docs/research/`; in `src/lib/hook-audit/agentic-dependency-constraints.json` only the dated `watch[].history[].note` strings are skipped. **CLI patterns only** (R16): `/\bx\s+verify\b/`, `/\bstatus\s+--live\b/`, `/\bstatus\s+--deep\b/`, `/\bsystem\s+--deep\b/`, `/\bmaintain\s+scan\b/` (does not match the `scans` verb), `/--refresh-inventory\b/`, `/\bmaintain\s+scans\s+start\b[^\n]*--deep/`, `/\bmaintain\s+plan\b[^\n]*--deep/`, `/\bhost\s+refresh\b/`, `/\bprompts\s+--deep\b/`, `/\brecipes\s+refresh\b/`. 6c-4 extends the list with the dashboard spellings. No test asserts any UPGRADING section or old → new table (R17).
- Modify — every current hit (from `grep` at `31a1a39b`; re-run the guard for the live list), each rewritten to the current spelling with no history narration:
  - `README.md` (4), `docs/TROUBLESHOOTING.md` (19), `docs/UPGRADING.md` (11 — e.g. `:54,141,249,378,391,399,416,430,437,441,650`; rewrite each sentence to the current spelling; add no section about the renames), `docs/AQE-EMBEDDINGS.md` (4), `docs/PROVIDERS.md` (3), `docs/DEJA-VU.md` (2), `docs/SETUP.md:268`, `docs/MODEL-PRICING-AUDIT.md` (1), `docs/AUTHORING-HOST-ADAPTERS.md` (1).
  - `docs/DASHBOARD.md` (7) and `docs/MAINTENANCE.md` (5): only the **CLI** mentions change — the dashboard's controls keep their current names until 6c, stated as current fact beside the new CLI equivalents (e.g. "press Full scan (or run `ak system --refresh=machine`)"; "`ak maintain --refresh` runs the same checks from a terminal, together with the local status checks"; "`ak maintain --refresh=machine`" for Re-measure machine). Also fix the two present-day misstatements from the premise section (the Maintenance view does reload on the poll while open, `client/poll.mjs:155`; drop the nonexistent quoted string at `DASHBOARD.md:670-671`); every UI string quoted must be grep-verified under `src/lib/dashboard/`. `docs/MAINTENANCE.md:283,667,706` and `docs/MAINTENANCE-ACCEPTANCE.md` MNT-ACT-019: recipe refresh is not offered (the store's verification library remains, R14). Document the Limits panel's two new Codex reasons (Task 1).
  - `docs/ddd/ubiquitous-language.md` (define Refresh and its three CLI strengths, live check, slow proof, connection check, and "machine measurement — the full re-measure `--refresh=machine` runs; the dashboard's Full scan and Re-measure machine controls run the same chain"), `docs/ddd/maintenance.md` (`:389` route list without recipes refresh), `docs/ddd/machine-footprint.md` (CLI spelling).
  - `claude/ruflo-reference-full.md:63,78,253,270,434,436` (installed guidance: new spellings only).
  - `src/` comments and strings the guard still reports after Tasks 2–12 (at `31a1a39b`: `src/lib/harvest.mjs:22,66`, `src/lib/ruflo-memory.mjs:8,20`, `src/lib/mcp-tool-call.mjs:11`, `src/lib/output.mjs:64`, `src/lib/exec.mjs:24`, `src/commands/status/sections/project-memory.mjs:5`), and `src/lib/hook-audit/agentic-dependency-constraints.json:1017` (`adjustment`: "status, live checks, about").
  - Final pass over `bin/agentic-kit.mjs` `HELP`/`HELP_ALL` and every command's `help`.

- [ ] **Step 1: Write the guard test; run it to verify it fails** — `env -u FORCE_COLOR node --test tests/kit/refresh-vocabulary-guard.test.mjs` lists every remaining hit.
- [ ] **Step 2: Rewrite** until the list is empty.
- [ ] **Step 3: Run** `env -u FORCE_COLOR node --test tests/kit/refresh-vocabulary-guard.test.mjs tests/kit/ga-surface-guard.test.mjs tests/kit/doc-citations.test.mjs tests/kit/cli-help.test.mjs tests/kit/upstream-watch-registry.test.mjs`, `npx markdownlint-cli2`, and the internal link check CI runs (`links (internal)` — the 6a round-1 failure was a relative link one level off).
- [ ] **Step 4: Commit.**

### Task 14: ADRs record what the CLI work made true

**Commit:** `docs(adr): record the CLI refresh vocabulary Branch 6b delivered (ADR-0063)`

**Files and required edits** (only what 6b makes true; the dashboard supersessions are 6c-5):

- `docs/adr/0063-evidence-store-and-refresh-vocabulary.md` — Status stays **Accepted** (the Proposed → Accepted step was already taken, `:3`); add `Updated: 2026-09-28 — Branch 6b delivered the CLI refresh vocabulary`; new section **Delivered in 6b** (the CLI strength table as shipped, `REFRESH_STAGES`, R2's dependency rule, `runRefresh`/`cliRefreshStages`, `--only` and R4, R15, the live-check fold and R13's source labels, the Codex presence gate R9, the `--skip` lookups, the dry-run preview R8 and its stated host-evidence limitation, the renames, the recipe-refresh removal, `ak host check-connection`); replace **Explicitly not built… still ahead in 6b** (`:370-378`) with **Ahead in Branch 6c** (the dashboard Refresh control and Reload, `POST /api/refresh`, read-only GET routes, the supersession of ADR-0048's two controls and of ADR-0025 §5's GET rationale) and what stays out of scope (R1's storage unification; `host-health-evidence.mjs`); rewrite **The interim --refresh boolean's scope** (`:257-275`) to the current CLI state. The **Supersedes** line (`:17-20`) and **Relationship to ADR-0048** (`:380-390`) stay as they are until 6c-5, except one sentence in the latter naming the CLI equivalents (`ak maintain --refresh`, `ak maintain --refresh=machine`).
- `docs/adr/0048-…md` — new `Updated` line (the 2026-09-28 line becomes an "Earlier update"): the CLI equivalents of its two scan controls are now `ak maintain --refresh` and `ak maintain --refresh=machine`; the `scan` verb, `scans start`/`plan` re-measure flags and recipe refresh are gone from the CLI and the v2 routes (store library kept, R14); the two dashboard controls are unchanged (their supersession is 6c's).
- `docs/adr/0044-…md:248` — `Updated`: the CLI verb for the explicit scan is `ak maintain --refresh[=machine]` (the `?refresh=scan` route at `:231` is 6c's).
- `docs/adr/0025-…md:325` — `Updated`: CLI parity is `ak system [--refresh[=live|machine]] [--project-trees] [--json]` (§5's GET rationale is 6c's).
- `docs/adr/0053-…md` — `Updated`: `ak host check-connection` is the CLI twin of the connection check, with the same consent and managed-only rule (the "Check again" and `/api/host-health/local` changes at `:108,164` are 6c's).
- `docs/adr/0055-…md:9,15,120` — `Updated`: live checks run with `ak status --refresh=live`, the AQE proof with `--only aqe`; source labels per R13.
- `docs/adr/0010-provider-mediated-quota-reads.md` — `Updated`: Codex quota is requested only when `host-setup` evidence says Codex is found (B6b-D1), never probed.
- `docs/adr/0023-…md:302` — only if that sentence states current behaviour, an `Updated` line naming the current spelling; otherwise leave it.
- `docs/adr/README.md` — refresh the index rows these edits touch.

- [ ] **Step 1:** Re-read each ADR's decision text and the audit's Decisions 1, 5, 6 and Addendum 3 Item 4; list any sentence that the 6b code now contradicts (and leave dashboard statements that stay true until 6c).
- [ ] **Step 2:** Edit.
- [ ] **Step 3:** `env -u FORCE_COLOR node --test tests/kit/doc-citations.test.mjs tests/kit/ga-surface-guard.test.mjs tests/kit/refresh-vocabulary-guard.test.mjs && npx markdownlint-cli2`, then the full gate set.
- [ ] **Step 4: Commit.**

---

## Pre-flight: shared files and interfaces (Branch 6b)

| Pair / task | Shared file or interface | What one produces, the other consumes | Finding |
|---|---|---|---|
| 2 ↔ 3, 4 | `src/lib/refresh.mjs` | 2 produces `REFRESH_OPTIONS`, `refreshRequestFromFlags`, `REFRESH_STAGES`, `stagesFor`, `runRefresh`, `cliRefreshStages`, `printRefreshStage`; 3 uses them for system/maintain; 4 adds `only` | Hard gate: 2 lands and is reviewed before 3 and 4 |
| 2 ↔ 5 | Task 2's static assertion in `tests/kit/refresh.test.mjs` | 2 asserts `refresh.mjs` never references `checkConnection`/`host-health-connected`; 5 relies on it for R7 | 5's acceptance cites 2's test |
| 2 ↔ 11 | `src/lib/output.mjs` `humanOutputToStderr`; `sync.mjs` | 2 moves it; 11 edits sync's `--json` catch that uses it | Sequential; 11 must not reintroduce a local copy |
| 2 ↔ 8 ↔ 9 | `status.mjs` `collect()` | 2 changes `run()` only; 8 adds `collect({ versionEvidence })`; 9 feeds it | Different functions; sequential |
| 4 ↔ 7 | `src/lib/live-checks.mjs` | 4 moves the file and fixes the `security` entry's shape; 7 changes `verifySecurity`'s signature (`cwd`) | 7 starts after 4's commit; its test file is 4's renamed file |
| 4 ↔ nightly / registry | `.github/workflows/nightly.yml`, constraint registry `kitImpact.files` | 4 renames the module and the commands | Same commit, or `upstream-watch-registry.test.mjs:281` and nightly CI break |
| 5 ↔ 6 ↔ 12 | `src/commands/x/host.mjs` | 5 adds `check-connection`; 6 renames `refresh` → `reset-routes`; 12 adds `--dry-run` to `pick`/`off`/`reset-routes` | Order 5 → 6 → 12; 12 names `reset-routes` |
| 3 ↔ 10 | `src/commands/maintain.mjs` | 3 removes `scan`/`--deep`; 10 removes `recipes refresh` | Order 3 → 10 |
| 8 ↔ 9 | `src/commands/sync/plan-versions.mjs`, `versionEvidence` | 8 creates the module and the passthrough; 9 adds the preview | Order fixed |
| 6, 8, 9, 11 ↔ R11 | `sync.mjs` counted lines | each task (6 edits only a comment) | Each runs the line probe; ≤ 832 |
| 1, 6 ↔ `dashboard-server.mjs` | comments only | 1 documents presence gating; 6 renames a comment | No logic change; 6c owns logic changes there |
| 13 ↔ all | docs, the guard test | 13 enforces what 2–12 renamed | Guard lists only CLI spellings 2–12 actually retired |
| 14 ↔ all | ADRs | 14 records what shipped in 6b | Runs last; reads the code, not this plan |

| Task | Internal consistency check |
|---|---|
| 1 | Evidence kind is `host-setup` (recorded for every host), read with the exported key helper — never `readEvidence` without an `inputsKey` (that would skip PATH invalidation) |
| 2 | Plain `ak status` path untouched (zero-spawn test green); stdout purity under `--json` covers the new stage lines; bare `--refresh` never consumes a positional |
| 3 | `ak system`/`ak maintain` share one collector with their stages; `report` is read-only; `--refresh` only with `report` |
| 4 | Every former suite is reachable by an `--only` id; `mcp` now runs whenever Codex is enabled; evidence ids unchanged (R13); flake verdict reported with evidence |
| 5 | Consent mirrors the dashboard: disclosure text is one constant; managed-only; `--dry-run` sends nothing; the `page.mjs` swap is a static string, independent of 6c |
| 6 | No other command's `refresh` changes (`usage refresh openrouter`, `models refresh` stay, R10) |
| 7 | The folder travels as `cwd`, never as a Windows path argument |
| 8 | A real sync that skips nothing behaves exactly as today; the converge proof never reuses plan-time evidence for a part that was not skipped |
| 9 | `record: false` everywhere in the preview; every `npm view` uses the redirected cache, which is removed in `finally` |
| 10 | Only the user-reachable refresh path goes; store library and its tests stay (R14) |
| 11 | JSON on stdout, human text on stderr, for both parse and config errors; skipped lines once; no hint for retired spellings (R17) |
| 12 | `pick --dry-run` returns before the first write; `resolvePickDecision` mutates only the in-memory `cfg` |
| 13 | Every quoted UI string exists in `src/lib/dashboard/`; docs name only current spellings; dashboard controls still named as they exist today |
| 14 | ADR-0063's "Delivered in 6b" and "Ahead in Branch 6c" match the code; no dashboard supersession claimed before 6c |

## Review Focus (Branch 6b)

- **Dashboard cost.** 6b adds no dashboard route and no poll work. Task 1 removes the `codex app-server` spawn from `/api/limits` whenever Codex is not found and adds none; `tests/kit/dashboard-status-cost.test.mjs` stays unchanged and green; Task 5's `page.mjs` change is a static string. (The tick-3 and idle-page assertions belong to 6c.)
- **Real-state hermeticity.** A base `--refresh` constructs the Maintenance service and management facade, which write `<state>/agentic-kit/maintenance/`. Every test passing a strength injects `deps.refreshStages` or runs in `sandboxHome()`. The dry-run preview's temporary npm cache lives under the OS temp dir and is removed. No test performs a real paid connection check. Run `node scripts/run-tests.mjs unit|ui` (tripwire) after Tasks 4, 9 and 14.
- **Windows.** `--refresh=live` and `--only a,b` pass through PowerShell and cmd unchanged, but check the child-process CLI tests on the Windows CI legs; bare-`--refresh` normalization must not touch arguments after `--`; the secrets scan passes the project folder as `cwd`, never through `.cmd` shim quoting; a guarded child uses `--import=${pathToFileURL(file).href}` (6a round-1 lesson); an in-process `XDG_*` redirect also sets `APPDATA`/`LOCALAPPDATA` (`tests/kit/spawn-env-guard.test.mjs`); the preview removes its npm folder only after `npm` exits (`maxRetries`). CI on a pushed branch (with go-ahead) is the only Windows evidence.
- **A decision recorded in one place and contradicted in another.** ADR-0063's "still ahead in 6b" list and interim-boolean section, ADR-0048's 2026-09-28 line, and every doc naming a CLI spelling must match the 6b code; conversely no 6b document may claim the dashboard controls are already superseded.
- **No legacy (R17).** Reviewers reject any alias, "is now" hint, retired-spelling table in the parser, or old → new table in docs; the only mapping is in the PR body's "Breaking changes" section.
- **Scope drift from the audit's table.** `--refresh` really does run the Maintenance provider scan and inventory rebuild on `status`, `system` and `maintain` alike; reviewers should reject a task that quietly narrows the base strength to "status evidence only".
- **Complexity and line budgets.** `npx eslint src bin --rule 'complexity: [2, 50]'` passes after every task (watch `status.run`, `converge`); `sync.mjs` ≤ 832 counted lines.
- **A dependency that moves during the branch.** Before the PR, re-run the upstream watch and re-check `ruflo security secrets --path` and `codex app-server`'s read-only flags against the newest releases inside the support window.

## Closing notes for the controller

- **Pull request body:** include a "Breaking changes" section mapping each retired spelling to its replacement (source material: this plan's premise table, R5, R12 and Tasks 2–6 and 10); the same list goes into the GitHub release notes at release time and nowhere else in the repository (R17).
- **Branch 6c** starts from `main` after 6b merges; its planner begins from the section below and re-verifies every file:line against that `main`.

## Open questions for the maintainer

None.

---

## Deferred to Branch 6c

Kept intact so the 6c planner starts from it (maintainer decision B6b-D2). Dependencies on 6b name 6b's task numbers above. Line numbers are at `31a1a39b` and must be re-verified against `main` after 6b merges.

**6c-only rulings:** R6 (the dashboard control), and R16's guard extension. Order: 6c-1 → 6c-2 → 6c-3 (additive route, then client switch, then GET side effects removed — any other order leaves a commit where the client calls a 400ing route) → 6c-4 → 6c-5.

**6c file map:**

| File | Responsibility | Tasks |
|---|---|---|
| `src/lib/dashboard/refresh-api.mjs` (new) | server refresh operation (single flight), dashboard stage implementations, `POST`/`GET /api/refresh` handlers | 6c-1, 6c-3 |
| `src/lib/dashboard/client/refresh-control.mjs` (new) | the header Refresh control, its polling while its own operation runs, Reload | 6c-2 |

### 6c-1: The server refresh operation behind `POST /api/refresh` (additive)

**Depends on:** 6b Task 2 (`runRefresh`, `REFRESH_STAGES`, `REFRESH_STRENGTHS`, the R7 static assertion), 6b Task 4 (`src/lib/live-checks.mjs` `runLiveChecks`).

**Commit:** `feat(dashboard): one server refresh operation behind POST /api/refresh`

**Files:**

- Create: `src/lib/dashboard/refresh-api.mjs`.
- Modify: `src/lib/dashboard-server.mjs` — `inProcessStatus(cwd)` (`:151-169`) gains `{ refresh = false, timeoutMs = STATUS_TIMEOUT_MS } = {}`; the refresh path passes `timeoutMs: REFRESH_LOCAL_TIMEOUT_MS` (exported from `refresh-api.mjs`, 5 minutes) because `STATUS_TIMEOUT_MS` (30 s, `:143`) is sized for a warm, spawn-free read while a forced collect re-probes every kind and crosses the network — a slow machine would otherwise report the stage as "status collection timed out"; `startDashboard` gains one option, `refreshStages` (injected stage map, tests only; default `dashboardRefreshStages(...)`), so UI and API tests control stage timing without real collectors; the mutation gate (`:1413-1416,1444-1457`) admits `REFRESH_POST_ROUTES` with the same header-token and `maintenanceMutationRejection` checks as the health routes; `ROUTES` (`:2110-2129`) adds `'/api/refresh'` (GET state); build the operation once per server with `dashboardRefreshStages({...})` over the server's existing `getSystem`, `getMaintenance`, `refreshInventoryAfterProviderScan`, `getHostReadiness`. Keep net added lines small (≤ ~25); no stage logic in this file.
- Modify: `tests/kit/refresh.test.mjs` — the R7 static assertion also reads `src/lib/dashboard/refresh-api.mjs`.
- Test: `tests/kit/dashboard-refresh-api.test.mjs` (new); modify `tests/kit/dashboard-status-cost.test.mjs`.

**Interfaces:**

```js
export const REFRESH_POST_ROUTES = new Set(['/api/refresh']);
export const REFRESH_LOCAL_TIMEOUT_MS = 5 * 60_000; // bound for the forced in-process collect
export function createRefreshOperation({ stages, runRefresh }) /* → { start({ strength, projectTrees }), state() } single-flight */;
export function dashboardRefreshStages({ cwd, pkgRoot, getSystem, getMaintenance, refreshInventoryAfterProviderScan,
  getHostReadiness, statusCollect /* inProcessStatus(cwd, { refresh: true }) */, loadConfig }) /* → stages map */;
export async function handleRefreshPost(req, res, operation); // body { strength: 'local'|'live'|'machine', projectTrees?: boolean }
export function handleRefreshGet(res, operation);
// state(): { running: boolean, strength, projectTrees, startedAt, finishedAt, ok, stages: [{ id, label, state, detail, elapsedMs }] } | { running: false, lastRun: null }
```

Dashboard stage bodies: `machine` → `(await getSystem()).refreshDeep(projectTrees ? { includeProjectTrees: true } : undefined)`; `maintenance` → `(await getMaintenance()).scan({ deep: false })`; `inventory` → `refreshInventoryAfterProviderScan({ measured: strength === 'machine' })`; `live` → dynamic `import('../live-checks.mjs')` then `runLiveChecks({ cfg: loadConfig(), cwd })`; `local` → `statusCollect()` then `getHostReadiness({ force: true })` (this is what replaces "Check again"). `POST` answers `202 { started: true, state }` and runs in the background; a second `POST` while one runs answers `409 { error: 'a refresh is already running', state }`. Body validation: `readMaintenanceJson(req, { maxBytes: 4096 })`; only the keys `strength`, `projectTrees`; `strength` in `REFRESH_STRENGTHS`; `projectTrees` boolean and only with `machine`; otherwise 400. Never imports `host-health-connected.mjs` and never calls `checkConnection` (R7).

- [ ] **Step 1: Write the failing tests.** `dashboard-refresh-api.test.mjs` starts the server with injected fakes (collector, maintenance, management, `fetchStatus`, host readiness, `refreshStages` — the existing hermetic-defaults pattern; pass a sandbox control root): `POST` without the header token → 401; token only as `?token=` → 401; cross-origin headers → 403; unknown strength → 400; extra key → 400; `projectTrees` with `local` → 400; `POST {strength:'local'}` → 202, then `GET /api/refresh` until `running:false` shows `maintenance, inventory, local` done and the host-readiness fake saw `force:true`; a second POST while the first is held by a deferred fake → 409; a failing machine fake → `maintenance`/`inventory` `skipped`. Extend `dashboard-status-cost.test.mjs`: after tick 2, `POST /api/refresh {strength:'local'}` with the header token, wait until finished (`tests/kit/helpers/wait-until.mjs`), then tick 3 `/api/status` — tick 3 starts zero processes beyond the named `npm view` exception, its bytes stay within the existing budget of tick 2, and its top-level JSON keys equal tick 2's (refresh state never leaks into `/api/status`). That child server runs the **real** stages under the sandbox HOME with a broken `PATH`; first time a real `local` refresh there and record the figure in the report. **Fallback, decided now:** if it cannot finish hermetically within 60 s, the child test keeps only "the route exists and ticks 1–2 are unchanged", and the tick-3 assertions move to an in-process server started with `refreshStages` fakes (same spawn ledger via the `--import` guard, same byte and key assertions). Also assert (static) that `client/poll.mjs` never references `/api/refresh`.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/dashboard-refresh-api.test.mjs tests/kit/dashboard-status-cost.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/dashboard-hermetic-defaults.test.mjs tests/kit/dashboard-status-inprocess.test.mjs tests/kit/host-health-api.test.mjs tests/kit/maintenance-dashboard-security.test.mjs tests/kit/refresh.test.mjs`, `node tests/dashboard.test.cjs`, the complexity gate and the line probe.
- [ ] **Step 5: Commit.**

**Acceptance:** the 30-s poll's spawn and byte figures are unchanged with the route present and after a refresh; nothing in the page calls the route yet.

### 6c-2: One Refresh control; Reload re-reads the view

**Depends on:** 6c-1 (the `POST`/`GET /api/refresh` contract and the `refreshStages` server option), 6b Task 2 (`REFRESH_STAGES` labels), 6b Task 3 (the `service.mjs:61` step text), 6b Task 5 (the host-health dialog already renders `CONNECTION_CHECK_DISCLOSURE`; this task edits only the buttons around it).

**Commit:** `feat(dashboard): one Refresh control with the CLI's three strengths; Reload re-reads the view`

**Files:**

- Create: `src/lib/dashboard/client/refresh-control.mjs` — `startRefresh(strength, { projectTrees })` (one `POST /api/refresh`), polls `GET /api/refresh` every 1.5 s **only while the operation this page started runs**, renders `#refresh-status` (stage label from the server's state + elapsed), disables `#refresh-run` while running, on finish re-reads the active view and host readiness, exposes `refreshRunning()`.
- Modify: `src/lib/dashboard/page.mjs` — header per R6 (`:110-117` plus menu markup); remove `#sys-rescan` (`:222`), `#mnt-check-providers`/`#mnt-remeasure` and their help spans (`:918-921`), `#host-health-refresh` (`:162`, replaced by `#host-health-run-refresh` labelled "Refresh"); the `#sys-cons-trees` chip (`:752`) becomes a non-interactive label; `sys-asof` text (`:221`) uses "machine measurement".
- Modify: `src/lib/dashboard/client/poll.mjs:131-161,195-201` (`refreshAll` → `reloadView`, same reads, title/aria "Reload — re-read this view; runs no checks"), `client/system-projects.mjs:842-881,915-930,1035-1054` (`loadSystem()` read-only; no `?refresh=`/`&trees=`; "full scan" wording → "machine measurement"; trees chip shows the last measurement's scope; the comment at `:915-918` justifying a GET is removed), `client/maintenance-operation.mjs` (remove `mntRunOperation`/`mntRemeasureMachine`/`mntCheckProviders`; `mntWritesBlocked()` also returns true while `refreshRunning()`), `client/maintenance-workspace.mjs:437-440` (remove the two buttons' wiring), `client/maintenance-inspector.mjs:137,197`, `client/maintenance-guidance.mjs:208,285` ("Refresh evidence" wording → "Refresh"), `client/host-readiness.mjs:126,138,178` (the dialog's Refresh button calls `startRefresh('local')`; the connection check is unchanged), `client/boot.mjs`/`bootstrap.mjs` (wire the control), the matching `styles/*.mjs`, and `src/lib/maintenance/service.mjs:61` (append "or Refresh › Machine in the dashboard" to the step 6b Task 3 rewrote).
- Test: `tests/ui/dashboard-ui.mjs` (45 references to the retired controls), `tests/ui/host-readiness.mjs`, `tests/kit/maintenance-dashboard-client-labels.test.mjs`, `tests/kit/maintenance-presentation.test.mjs`, `tests/kit/system-summary.test.mjs`.

- [ ] **Step 1: Write the failing UI assertions** (in `tests/ui/dashboard-ui.mjs`, request log via Playwright `page.on('request')`; the UI server is started with 6c-1's `refreshStages` option holding deferred fakes, so each stage resolves only when the test releases it and the stage labels can be observed one at a time): (1) an idle page across two poll ticks issues **zero** requests to `/api/refresh` and zero POSTs; (2) clicking `#refresh-run` sends exactly one `POST /api/refresh` with `{strength:'local'}`, `#refresh-status` names each stage label in turn, and the active view re-reads when it finishes; (3) choosing "Refresh machine" with "Include project trees" sends `{strength:'machine', projectTrees:true}`; (4) `#poll-now` ("Reload") issues only GETs; (5) `#sys-rescan`, `#mnt-check-providers`, `#mnt-remeasure`, `#host-health-refresh` are absent; (6) Maintenance apply/undo/record controls are disabled while a refresh runs; (7) the host-health dialog's Refresh starts a `local` refresh and the connection check still requires the consent checkbox. Update `tests/ui/host-readiness.mjs` accordingly. Client-label unit tests assert the retired labels are gone from the client source.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node scripts/run-tests.mjs exec -- tests/ui/dashboard-ui.mjs` and `env -u FORCE_COLOR node scripts/run-tests.mjs exec -- --test tests/ui/host-readiness.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/maintenance-dashboard-client-labels.test.mjs tests/kit/maintenance-presentation.test.mjs tests/kit/system-summary.test.mjs tests/kit/dashboard-status-cost.test.mjs`, and the full `node scripts/run-tests.mjs ui`.
- [ ] **Step 5: Commit.**

**Acceptance:** assertion (1) holds; screenshots of the header control in light and dark themes and at 390 px width attached to the report.

### 6c-3: GET routes stop starting work

**Depends on:** 6c-2 (the page no longer calls the GET-started scans or `/api/host-health/local`), 6c-1 (the machine/inventory stages that still call `refreshMaintenanceAfterSystem`/`refreshInventoryAfterProviderScan`).

**Commit:** `fix(dashboard): start scans with POST requests`

**Files:**

- Modify: `src/lib/dashboard-server.mjs:1985-2032` — `handleSystem`: any `refresh` or `trees` query → `400 { error: 'start a refresh with POST /api/refresh' }`, never calls `refreshDeep`; delete the now-unused GET branch; `handleMaintenance`: any query key → 400 with the same message; `refreshMaintenanceAfterSystem` moves into `refresh-api.mjs` if only the machine stage still uses it (otherwise delete it).
- Modify: `src/lib/dashboard/maintenance-api.mjs:850-880` — `report()` is read-only (`service.report()`); remove its `refresh` parameter and the `afterScan` hook.
- Modify: `src/lib/dashboard/host-health-api.mjs:4,18-19` — drop `/api/host-health/local`.
- Test: `tests/kit/dashboard-get-is-read-only.test.mjs` (new); modify `tests/kit/maintenance-dashboard-api.test.mjs` (12 references), `tests/kit/maintenance-dashboard-security.test.mjs`, `tests/kit/dashboard-hermetic-defaults.test.mjs`, `tests/kit/host-health-api.test.mjs`, `tests/dashboard.test.cjs`.

- [ ] **Step 1: Write the failing test.** Table-driven over every exact route in `ROUTES` and a representative URL per `PARAM_ROUTES` pattern: each `GET <route>?refresh=deep&refresh=scan&trees=1` never calls the injected `collector.refreshDeep`, `maintenance.scan`, `management.refreshInventory` or `management.rebuildAfterMeasurement` spies; `GET /api/system/summary?refresh=deep` → 400; `GET /api/maintenance?refresh=scan` → 400; `POST /api/host-health/local` → 405.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/dashboard-get-is-read-only.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus the listed neighbors, `node tests/dashboard.test.cjs`, the UI suite, the complexity gate and the line probe (`dashboard-server.mjs` must shrink), then the gate set.
- [ ] **Step 5: Commit.**

**Acceptance:** no GET anywhere starts a scan, a provider check or an inventory rebuild.

### 6c-4: Dashboard docs speak the refresh vocabulary

**Depends on:** 6c-1–6c-3; 6b Task 13 (the guard test to extend).

**Commit:** `docs: align dashboard docs with the one Refresh control`

- Extend `tests/kit/refresh-vocabulary-guard.test.mjs` with the dashboard spellings: `/\bFull scan\b/`, `/\bRefresh evidence\b/`, `/\bRe-measure machine\b/`, `/\bCheck again\b/`, `/\brefresh now\b/`, `/refresh=(?:deep|scan)/`, `/\/api\/host-health\/local/` (same scope and exclusions, R18).
- Rewrite to the current state only (R17 — no old → new tables anywhere): `docs/DASHBOARD.md` (the Refresh control and its three strengths, the stage labels, Reload, "machine measurement", the Project-trees option inside Refresh › Machine, the POST route), `docs/MAINTENANCE.md` (control names `:26,62,66-72,301,339,462,496,544,792`), `docs/UPGRADING.md` sentences naming dashboard controls (e.g. `:141,377,391`), `docs/ddd/ubiquitous-language.md` (Reload; the dashboard Refresh), `docs/ddd/machine-footprint.md` (the POST route), `docs/ddd/maintenance.md`, and any `claude/` guidance naming a dashboard control. Every quoted UI string grep-verified under `src/lib/dashboard/`.
- Run the guard, `tests/kit/ga-surface-guard.test.mjs`, `tests/kit/doc-citations.test.mjs`, `npx markdownlint-cli2` and the internal link check; commit.

### 6c-5: ADRs record the dashboard half and the supersessions

**Depends on:** 6c-1–6c-4; 6b Task 14 (ADR-0063's "Delivered in 6b" and "Ahead in Branch 6c" sections).

**Commit:** `docs(adr): supersede ADR-0048's scan controls and ADR-0025 §5's GET refresh (ADR-0063)`

- `docs/adr/0063-…md` — `Updated`; rewrite **Supersedes** (`:17-20`) from "terminology only" to real supersession of ADR-0048's Refresh evidence / Re-measure machine controls, ADR-0025 §5's GET-started deep refresh and ADR-0045's `GET ?refresh=scan`; add **Delivered in 6c** (R6's control, `POST`/`GET /api/refresh`, the stage table on both surfaces, read-only GET routes, the Check again fold); replace "Ahead in Branch 6c" with what remains out of scope; rewrite **Relationship to ADR-0048** (`:380-390`) to the current state.
- `docs/adr/0048-…md` — Status gains "Refresh evidence and Re-measure machine superseded by ADR-0063"; `Updated` line.
- `docs/adr/0025-…md` — `Updated` + amend §5 (`:314-321`): the deep refresh starts with `POST /api/refresh`; the reasoning that it "rides a GET" is withdrawn with the reason (a GET must never start work).
- `docs/adr/0045-…md:100`, `docs/adr/0044-…md:231` — `Updated` lines (the explicit scan is `POST /api/refresh`).
- `docs/adr/0053-…md:108,164` — `Updated`: "Check again" folded into Refresh; `/api/host-health/local` removed.
- `docs/adr/README.md` — refresh the index rows these statuses touch.
- Re-read each ADR and the audit's Addendum 3 Item 4 first; then run `tests/kit/doc-citations.test.mjs`, `tests/kit/ga-surface-guard.test.mjs`, `tests/kit/refresh-vocabulary-guard.test.mjs`, `npx markdownlint-cli2` and the full gate set; commit.

### Pre-flight for 6c (carried forward)

| Pair / task | Shared file or interface | Finding |
|---|---|---|
| 6c-1 ↔ 6c-2 | `POST`/`GET /api/refresh` contract | 6c-2 uses exactly 6c-1's field names; no `only` on the dashboard |
| 6c-2 ↔ 6c-3 | old GET routes, `/api/host-health/local` | 6c-2 stops the page calling them; 6c-3 removes them; order fixed |
| 6c-1 ↔ 6c-3 | `refreshMaintenanceAfterSystem`, `refreshInventoryAfterProviderScan` | 6c-3 keeps (or moves into `refresh-api.mjs`) whatever 6c-1's stages still call |
| 6c-1 ↔ 6b Task 2 | R7 static assertion in `tests/kit/refresh.test.mjs` | 6c-1 adds `refresh-api.mjs` to it |
| 6c-2 ↔ 6b Task 5 | `page.mjs` host-health dialog | disclosure already a shared constant; 6c-2 edits only the buttons |
| 6c-2 ↔ 6b Task 3 | `src/lib/maintenance/service.mjs:61` | 6c-2 appends the dashboard half of the step |
| 6c-4 ↔ 6b Task 13 | the vocabulary guard | 6c-4 extends the pattern list only |
| 6c-5 ↔ 6b Task 14 | ADR-0063 sections | 6c-5 builds on "Delivered in 6b" / "Ahead in Branch 6c" |

### Review Focus for 6c (carried forward)

- **Dashboard cost.** The 30-second poll must not start more processes or transfer more data than on `main` before 6c. Pinned by 6c-1 (tick 3 after a completed refresh: zero spawns beyond the named `npm view` exception, bytes within the existing budget, same top-level keys; `client/poll.mjs` never references `/api/refresh`) and 6c-2 (an idle page makes zero `/api/refresh` requests and zero POSTs across two ticks). Only a user-initiated refresh does work.
- **Hermeticity.** Dashboard tests use the injected-collector pattern with a sandbox control root and `refreshStages` fakes (the server refuses default services otherwise).
- **Windows.** Dashboard tests wait for the child to exit before removing its cwd (6a round-1 lesson).
- **Decisions contradicted elsewhere.** ADR-0063's Supersedes line, ADR-0048's control statements, ADR-0025 §5's GET rationale and the comment at `client/system-projects.mjs:915-918` must not survive 6c.
- **Complexity and line budgets.** `startDashboard` stays under the complexity-50 gate; `dashboard-server.mjs` does not grow net.
