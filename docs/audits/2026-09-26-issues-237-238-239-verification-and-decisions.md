# Issues #237, #238, #239 — verification and maintainer decisions — September 26, 2026

Source baseline: `847486c` on `main` (agentic-kit 4.0.0-alpha.55 plus #236). The reporter tested
the installed 4.0.0-alpha.55 package. Nothing in this record is implemented: it records verified
findings, the decisions the maintainer made on them, and the remediation plan those decisions
authorize. A planned commit is not evidence that the behavior changed.

## Scope

- [#237](https://github.com/pacphi/agentic-kit/issues/237): sync and dashboard health audit, its
  body plus four follow-up comments.
- [#238](https://github.com/pacphi/agentic-kit/issues/238): dashboard display and diagnostic
  defects, body plus one comment.
- [#239](https://github.com/pacphi/agentic-kit/issues/239): the reporter's v5 readiness tracker;
  every item maps onto #237/#238 findings or upstream work.
- The "PR" is not a GitHub pull request. It is five diffs attached to the #237 comment of
  2026-09-26 13:32 UTC: two for this repository (`agentic-kit-dashboard-and-inspector.patch`,
  `agentic-kit-native-probe.patch`) and three editing agentic-qe's installed `dist/` output.

## Method and limits

Six Agentic-QE specialists (AQE 3.14.3, hierarchical fleet) verified disjoint claim groups using
the sherlock-review method: observe the code path on `main`, deduce, eliminate alternative
explanations, reproduce, conclude. Groups: sync/status predicates and dashboard live/host state
and dashboard usage/payload (`qe-root-cause-analyzer`), dependency repair and upstream routing
(`qe-integration-reviewer`), and the two attached kit patches (`qe-code-reviewer`, which applied
them to an exported copy of `main` and ran the focused suites: 84/84 pass with and without them).
A `qe-devils-advocate` pass then challenged every verdict and changed six of them.

Every agent was read-only toward the checkout and the machine. Reproductions imported repository
functions with fixture inputs under a sandboxed `HOME` with every `XDG_*` variable unset. No
mutating kit command ran against the real machine and nothing was posted upstream. The
reproduction scripts were session-local and are not retained here; each planned commit's
regression test replaces its reproduction.

Limits: macOS only; no rendered-browser verification (UI conclusions come from client source plus
fixtures); Windows branches were read, not executed; upstream claims were checked against the
installed packages and the upstream repositories as of this date.

Verdict vocabulary: `CONFIRMED`, `PARTIAL`, `REFUTED`, `DESIGN-DECISION` (intentional under a
cited ADR or commit), `UPSTREAM(owner)`, `UNVERIFIABLE-HERE`.

## Verdicts

| ID | Claim (source) | Verdict | Disposition |
|---|---|---|---|
| S1 | Legacy `ruflo` MCP entry reported as migrated but kept (237 §1, §B) | CONFIRMED. Status promises a migration `register()` never performs; keeping the entry is correct (ADR-0016). The reporter's option (a) is unsafe. | kit fix |
| S2 | False `blocks` drift (237 §2, §A) | CONFIRMED, broader: all four intent-gated detectors, both directions; regressed in #196; also a "stripp" label bug | kit fix |
| S3 | Sync reports "converged" with promised repairs pending (237 §F) | CONFIRMED, including planned subsystems that no sync step handles. A naive fix creates permanent failures from advisory rows. | kit fix + ADR-0033 amendment |
| S4 | aqe-embedding: sync ✗ vs status info; "Install Ollama" when installed but stopped (237 #5) | PARTIAL. The refused-connection cause is swallowed (defect); the severity split is ADR-0055 design. | kit fix + decision 9 |
| S5 | No per-component sync exclusion (237, 239 P1) | CONFIRMED feature gap | decision 5 |
| D1 | agentdb `EEXIST` on every sync; reported "not installed" (237 §3, §D) | CONFIRMED. `present()` and `have()` disagree; the npm causal line is dropped; the existing `agentdb:false` opt-out is never mentioned. | kit fix |
| D2 | Brain refresh always uses the fresh-install path (237 §4, §C) | CONFIRMED; also stamps the requested release rather than the observed one. Severity lowered to Medium: the refusal is loud and `--no-upgrade` avoids it. | kit fix |
| D3 | Brain private-overlay preflight and corpus freshness (237 comments) | UPSTREAM(stuinfla/ruvnet-brain): `--update` runs the installed, possibly stale updater. Kit must stop re-promising the refresh. | upstream + kit fix |
| D4 | Brain 4.3.28 hook-contract warning is permanent (237 #6) | DESIGN-DECISION (reviewed pin, #224) plus missing guidance | decision 4 |
| D5 | agent-browser outside Ruflo's range stays amber (237 #6) | DESIGN-DECISION (ADR-0043) plus missing guidance | kit fix (message) |
| L1 | Codex labelled "Disabled" while in use; "Check local setup" does nothing (238 #1) | Policy upheld (ADR-0053) but the presentation is a defect: `codex:false` is the default, not an intentional choice, and the Limits panel already spawns `codex`. The button reports "Check completed." without evidence. | decision 1 |
| L2 | Live omits sessions in non-Git folders (238 #2) | DESIGN-DECISION (ADR-0012). The reporter's fix causes false joins (reproduced: same-basename folders share a key). "Never appear" is overstated. | decision 2 |
| L3 | `ps` parser drops executable paths with spaces (238 #3) | CONFIRMED (73 of 984 rows here); desktop-hosted Claude CLI then mislabelled or absorbed | kit fix |
| L4a | Live Codex session shows 0 operations (238 #4) | CONFIRMED (overturned from design): an idle stop/restart re-tails from the end of each file, losing appended operations; ADR-0012 promises retained offsets. Both reporter hypotheses refuted. | kit fix |
| L4b | Session stream stuck "CONNECTING" (238 #4) | UNVERIFIABLE-HERE; the server opens the stream in 1.6 ms; needs a browser network trace | follow-up |
| L5 | Coverage reports complete while capped (238 #5) | CONFIRMED; the file counter also grows on every restart | kit fix |
| L6 | Missing `--live-source` files show "ok" (237 §E) | CONFIRMED, broader: unreadable, malformed and schema-rejected sources also show "ok"; records in late-created files are lost; the client's issue count checks a status never emitted | kit fix |
| M1 | io-failure banner with nothing failed in Discovery (238 #6) | CONFIRMED. Absent roots are scanned; the mapping is in the orchestrator, not the function the reporter named; banner and Discovery read different state. | kit fix |
| M2 | Findings and Score disagree for one project (238 #7) | CONFIRMED: folder-label vs Git-repository grouping. The subagent theory is refuted. | kit fix |
| M3 | Claude limits "no data" advice unactionable (238 #8) | PARTIAL. "More sessions never fill it" is refuted; the advice hides the statusline condition. | kit fix |
| M4 | `GET /api/system` returns ~23 MB (237 #7) | CONFIRMED: two of three large arrays are never read and about 0.4% of items bytes are used; `/api/system` is a documented contract | decision 8 |
| P1 | Dotted root TOML keys block AQE embedding projection (237 comment, patch) | CONFIRMED. Patch is safe with changes: no tests, needs a shared key decoder; inline AQE registrations flip from a false "absent" to "conflict". | kit fix |
| P2 | Absolute `aqe ["mcp"]` transport unrecognized (patch) | DESIGN-DECISION (#230 allow-list); the patch misses `aqe-v3` and OpenCode's separate check | decision 3 |
| P3 | Native probe discards its cause (patch) | CONFIRMED plus a deeper defect: heal checks that the binding file exists while status load-tests it, so sync never rebuilds a present-but-unloadable binding. Land the state split before the heal change; heal only on `unavailable`. | kit fix |
| P4 | Codex quota "no data" text guesses the cause (patch) | CONFIRMED; the server should carry the reason | kit fix |
| U1, U2 | agentic-qe `fleet run` and `task submit` CLIs start without domain plugins, count acceptance as completion, exit 0 on failure | UPSTREAM(proffesor-for-testing/agentic-qe); 3.14.3 is latest; not yet reported. The kit never calls these commands. | upstream |
| U3 | agentic-qe falls through to create after a live RVF lock, then reports `FsyncFailed` | UPSTREAM: agentic-qe#574 and partial PR #719 (both open) | upstream |
| U3k | `ak x verify aqe` fails on lock contention (new) | CONFIRMED: the classifier checks `FsyncFailed` before the live-lock pattern | decision 7, [#240](https://github.com/pacphi/agentic-kit/issues/240) |
| U4 | Ruflo MCP memory operations omit the canonical database path | UPSTREAM(ruvnet/ruflo#3196), same defect as #213; the reporter's `dist/` patch is unsafe | #213 |
| N1 | Codex MCP AQE warning ignores `aqe:false` (new) | CONFIRMED | kit fix |
| N2 | `ak sync --json` advertised but never read (new) | CONFIRMED (`sync.mjs:95,110`) | decision 6 |
| N3 | Non-Git readiness hints say "run setup here" (new) | CONFIRMED; plain `ak setup` in a non-Git folder is machine scope only | kit fix |
| N4 | "Two preserved memory files" warning is permanent | CONFIRMED class (no acknowledgment path) | with #213 |
| N5 | "Partial historical Codex usage parsing" advisory | Not verified; mechanism located in `usage-index.mjs:301-320` | follow-up |
| M1b | A failed source's banner outlives its Discovery row after restart | CONFIRMED; not cured by the M1 fix | follow-up |
| F1 | #239 P0-3 worker early-warning monitor | New capability, not a defect | follow-up |

Refuted or overstated: "every warning card says run ak sync" (cards render a fix only when one
exists); the dashboard's foreground lifetime is already documented; #239's host-vs-provider
identity point is already disclosed; the three agentic-qe patches and the Ruflo path patch edit
installed `dist/` output that upgrades overwrite; the agentic-qe task-submit patch changes that
CLI's contract.

## Decision walkthrough

Nine findings required a maintainer decision. Each was presented, one at a time, in plain
language using this exact format:

1. **The situation** — what the part does and why it exists.
2. **The problem** — what goes wrong, with file references.
3. **What the user sees** — the reporter's actual experience.
4. **What should be the case** — the target behavior.
5. **The choices** — every option, including rejected ones and why.
6. **Recommendation** — exactly one, with the reason.

The maintainer then chose from the offered options or answered in their own words. Free-text
answers are quoted below with spelling corrected. Where the maintainer's answer changed the
proposal, the challenge round that followed is recorded too.

### Decision 1 — Codex shows "Disabled" when it is in use (L1)

**The situation.** ak routes work to three hosts: Claude, Codex and OpenCode. A setting in
`kit.json` says which hosts ak routes to; by default only Claude. The setting cannot tell "you
chose to leave Codex out" from "you never changed the default."

**The problem.** The dashboard treats "ak doesn't route to Codex" as "Disabled" and refuses to
run even the free local health checks for it (`src/lib/host-readiness.mjs:35-39,88-90`). Yet the
Limits panel talks to Codex anyway to show its quota (`src/lib/quota.mjs:319-328`).

**What the user sees.** Codex did 51% of the spend, its weekly limit reads 11% used, and four
Codex processes run, yet the pill says **Disabled**, every health line says **Unknown**, and
"Check local setup" reports "Check completed." without running any check.

**What should be the case.** "ak doesn't route to Codex" and "Codex is broken or off" are
different facts, and the screen says which one is true. A button never claims a check it did not
run.

**The choices.**

- **A. Fix the words and the button only.** Rename to "Not used by ak"; grey out the button with
  a reason. No checks run; health stays blank.
- **B. Run the free checks on request.** Label "Not used by ak"; "Check local setup" runs the
  three free, read-only checks; nothing runs in the background; the paid "Check connection" stays
  for routed hosts. Small ADR-0053 amendment and one new test.
- **C. Run the free checks automatically.** Probe every installed host on each dashboard load so
  the pill shows installed and signed-in state at a glance. Reverses ADR-0053's rule and its test.
- **D. Go fully hands-off.** Also stop the Limits panel calling Codex for unrouted hosts.
  Consistent, but users lose the quota view.
- Not offered: automatically enabling routing when activity is seen (changes setup without
  consent; the reporter also advised against it).

**Recommendation: B.**

**Maintainer's answer (own words):**

> We are distinguishing that host is or is not "under management". If codex is detected, but not
> "under management" - i.e., user didn't opt-in with flag, then we should report that status. Then
> on health check status info in dashboard, if codex is found, we should make the checks and
> report - no need for user to interact or force a manual check. When dashboard shows what
> hosts/models are capable of participating in swarm, aqe, dual - we would show some message
> saying Codex is "not participating", and then user would be given instruction hint for how to
> enable. Does this make sense? Challenge me if it does not.

**Challenge round.** The model makes sense (it is option C with clearer words). Four refinements
were proposed after checking the code:

1. Only tool-level checks (installation, configuration, model, authentication) are meaningful for
   an unmanaged host. The ak-wiring (MCP transport alignment) check is shown as FYI only, because
   ak was never asked to wire that host.
2. Problems on an unmanaged host are information, not warnings, so the dashboard's warning total
   does not grow from a host the user never opted in.
3. The enable hint is built from the current host set. `ak host pick --host` takes the complete
   list (`src/commands/x/host.mjs:51-54`), so a naive `--host codex` would disable Claude. The
   hint is copyable text, never a button that edits configuration.
4. The paid "Check connection" stays managed-only.

Cost: at most a few bounded local commands per host per minute while the dashboard is open
(`codex doctor` remains excluded because it touches the network). Paperwork: amend ADR-0053 and
rewrite its "disabled hosts are neutral" test.

Options offered: **Yes, refined model (Recommended)** · Yes, but count as warnings · Yes, but skip
wiring check.

**Choice:** "Yes, refined model, we should make sure all hosts supported have this consistent
reporting behavior."

**Decided.** Three states — **Managed by ak**, **Found, not managed**, **Not installed** — with
the same words everywhere and the same behavior for every supported host (Claude, Codex,
OpenCode). Tool checks run automatically; the wiring check is FYI-only and problems are
information for unmanaged hosts; participation views show "not participating" with a hint built
from the current host set; the paid check stays managed-only.

### Decision 2 — Sessions in non-Git folders drop out of Live (L2)

**The situation.** Live links two clues to call a session alive: a heartbeat (a running host
process) and a diary (its transcript). A Git project has a strong ID based on its real location;
a plain folder's ID is a hash of its name only, so two different `scratch` folders look identical.

**The problem.** To avoid linking the wrong heartbeat to the wrong diary, ADR-0012 allows
heartbeats only for Git projects.

**What the user sees.** A Claude Code session in a plain folder appears in System → Runtime but
shows in Live only while it is actively writing (`src/lib/live/projection.mjs:472-475`); while it
waits for input it disappears.

**What should be the case.** A running session in a folder appears in Live and is never confused
with a different folder of the same name.

**The choices.**

- **A. Keep the rule and explain it** on the Live screen, pointing to System → Runtime.
- **B. Match by exact folder.** Link clues only when the full folder path matches, using an
  in-memory value scrambled with a per-run secret, never saved or shown. ADR-0012 amendment and
  two tests.
- **C. The reporter's fix: match by folder name.** Rejected: reproduced linking a session in one
  `scratch` folder to a process in another.
- **D. Change every plain folder's project ID to use the full path.** Root fix, but it splits
  existing usage history and needs a migration.

**Recommendation: B.** Options offered: **B: exact-folder match (Recommended)** · A: keep rule,
explain it · D: full-path project IDs.

**Choice: B.**

### Decision 3 — Which AQE server entries ak may edit (P2)

**The situation.** ak writes one setting (`AQE_EMBEDDER_ENDPOINT`) into AQE's MCP server entry in
each host's configuration. To avoid editing someone else's entry, it edits only entries whose
start command exactly matches a form AQE's own setup writes: `aqe-mcp` or
`npx -y agentic-qe@latest mcp` (the #230 allow-list).

**The problem.** AQE installs `aqe`, `agentic-qe`, `aqe-v3` and `aqe-mcp`; the first three are
one program, so `aqe mcp` starts the same server. ak does not recognize it, and OpenCode's check
accepts only `aqe-mcp` (`src/lib/opencode-core.mjs:115`).

**What the user sees.** Entries of the form `/path/to/aqe mcp` are left alone as "unrecognized AQE
MCP transport preserved", so the embedding warning persists after a correct manual setup, with no
instruction.

**What should be the case.** An entry that starts AQE with one of AQE's own programs is recognized
the same way on every host; an entry ak leaves alone comes with exact instructions.

**The choices.**

- **A. Keep the list; give a clear instruction**, and align OpenCode to the same two forms.
- **B. Recognize all of AQE's own programs with one shared rule:** `aqe-mcp` with no arguments;
  `aqe`, `agentic-qe` or `aqe-v3` with exactly `mcp`; `npx -y agentic-qe@latest mcp`; `.cmd`
  variants on Windows; used by Claude, Codex and OpenCode. Extra flags and wrappers stay preserved.
- **C. The reporter's patch** (`aqe`/`agentic-qe` + `mcp`, Claude and Codex only).
- **D. Loose matching** on name prefix and argument prefix. Rejected: edits customized entries.

Risk noted for B: a user's own script named `aqe` taking exactly `mcp` would receive the setting,
which is a non-secret loopback address that ak records and can undo; ak already trusts any
program named `aqe-mcp` this way.

**Recommendation: B.** Options offered: **B: all AQE programs, one rule (Recommended)** · A: keep
list, clear instruction · C: reporter's patch.

**Choice: B.**

### Decision 4 — The Brain 4.3.28 "hooks changed" warning (D4)

**The situation.** RuvNet Brain adds hooks to Claude Code and Codex, some of which add text the
model reads. ak keeps an exact list of reviewed Brain hooks (4.3.17 and 4.3.26) and warns when a
Brain release changes them (#224).

**The problem.** Brain 4.3.28 added one hook. The warning never says what changed or what to do,
and sync cannot clear it.

**What the user sees.** A permanent amber card with no action.

**Review of the new hook.** `capacity-aware-parallel-work` runs on every prompt submission in
Claude and Codex, reads up to 32 KiB of the prompt, samples memory pressure with three system
commands (about 450 ms), and on some prompts tells the model: "If a real agent-spawn/task tool is
available and slots remain, launch actual workers now…". It writes no files, times out after 2 s
and fails open. It is declared `offBehavior: "run"` — it keeps running when the Brain is switched
off, unlike Brain's other prompt hooks (plugin 4.3.28 `hooks/hook-contracts.json:242-251`,
`scripts/hook-shim.mjs:89`, `scripts/capacity-aware-parallel-work.mjs:147,175`).

**What should be the case.** The warning says exactly what changed and what the user can do; "off"
means off.

**The choices.**

- **A. Accept 4.3.28.** The warning disappears; ak vouches for a hook that ignores the off switch.
- **B. Hold, explain, ask upstream.** The warning names the hook, the concern and the options; ask
  Brain's maintainer (the reporter) to set `offBehavior: "silence"`; accept the first release that
  does.
- **C. B plus a per-machine "I reviewed this" acknowledgment** bound to the exact hook fingerprint.
- **D. Ignore added hooks.** Rejected: an added prompt-injecting hook is what the check exists for.

**Recommendation: B.** Options offered: **B: hold, explain, ask upstream (Recommended)** · A: accept
4.3.28 now · C: B + per-machine accept.

**Choice: B.**

### Decision 5 — Leaving one part alone during `ak sync` (S5)

**The situation.** `ak sync` repairs about 25 subsystems. Its only brakes are `--dry-run` and
`--no-upgrade`. Permanent `kit.json` opt-outs such as `ruvnetBrain: false` stop management
entirely and have side effects.

**The problem.** There is no one-run exclusion, and several steps fire as side effects of others
(`src/commands/sync.mjs:253-484`; for example, a version upgrade triggers natives, blocks and
statusline, and one step runs every time).

**What the user sees.** Wanting to repair everything except Brain, the reporter could not run sync
at all: "Today's read-only preview still included a Brain refresh, so no broad sync was applied."

**What should be the case.** "Fix everything except X this time" truly leaves X untouched,
including side-effect triggers, and does not then report X as unfixed.

**The choices.**

- **A. Document only.**
- **B. Add `--skip <part>`:** repeatable, name-checked, applied to the plan, every step trigger and
  the convergence check; prints "skipped by request"; not counted as a failure.
- **C. Add `--only <part>`.** Riskier: partial runs can leave dependent steps half-done.
- **D. Both.**

**Recommendation: B**, landing after the convergence fix. Options offered: **B: add
`--skip <part>` (Recommended)** · A: document only · D: both `--skip` and `--only`.

**Choice: B.**

### Decision 6 — `ak sync --json` is advertised but does nothing (N2)

**The situation.** `ak status --json` prints machine-readable output that the dashboard uses.
`ak sync --help` promises the same.

**The problem.** The flag is declared (`sync.mjs:95`) and described (`sync.mjs:110`) but never
read; output stays human text.

**What the user sees.** A script calling `ak sync --json` receives text and breaks. Nothing in the
repository, its tests or its documentation uses the flag.

**What should be the case.** Every advertised option works as described.

**The choices.**

- **A. Remove it** — two lines; passing `--json` becomes a clear unknown-option error.
- **B. Build it** — human lines go to stderr; stdout carries one JSON result (plan, steps,
  unresolved, skipped, exit code). Lands after the convergence fix and `--skip`. Medium effort.
- **C. Keep it marked "not implemented."** Rejected.

**Recommendation: A.** Options offered: **A: remove it (Recommended)** · B: build it.

**Choice: B.** The maintainer chose to build the feature rather than remove it.

### Decision 7 — `ak x verify aqe` fails when AQE is merely busy (U3k)

**The situation.** `ak x verify aqe` runs `aqe status` and classifies its startup output. AQE keeps
its store in one file; only the lock holder, usually the AQE MCP server inside a Claude Code
session, may write it.

**The problem.** On a live lock, agentic-qe 3.14.3 logs a correct "degrading to SQLite" warning,
then a misleading "unusable but its lock is held" line, then `FsyncFailed` from a create attempt
it should not make (agentic-qe#574). Nothing is damaged. The kit checks `FsyncFailed` first
(`src/lib/aqe-readiness.mjs:30`) and never reaches the busy rule (`:34`), deliberately, so that a
lock cannot hide a real storage error.

**What the user sees.** During normal use, verification reports AQE as failed. The reporter worked
around it by editing AQE's installed files, which upgrades overwrite.

**What should be the case.** Contention reads as busy; a real disk error still fails.

**The choices.**

- **A. Fix the classifier now, with an expiry.** Only the exact three-line fingerprint (keyed on
  the middle line, which AQE emits only from its live-owner branch) reads as busy; a bare
  `FsyncFailed` still fails; a comment and test tie removal to the AQE release carrying PR #719.
- **B. Wait for AQE.** PR #719 is open with no release date; false failures continue meanwhile.
- **C. Treat any `FsyncFailed` plus a lock as busy.** Rejected: could hide a real disk error.
- **D. Patch AQE's files locally.** Rejected: edits another package; upgrades erase it.

**Recommendation: A.** Options offered: **A: fix now, with expiry (Recommended)** · B: wait for AQE.

**Choice: A.** The maintainer also asked for a tracking issue; it was created as
[#240](https://github.com/pacphi/agentic-kit/issues/240) ("Tracking: remove temporary AQE
live-lock busy rule once fixed upstream (agentic-qe#574 / #719)"), following the format of #70.

### Decision 8 — The System tab downloads ~23 MB and repeats it every 30 seconds (M4)

**The situation.** The System tab draws ak's machine inventory from `GET /api/system`, which
`docs/UPGRADING.md:316` documents as sharing the shape of `ak system --json`.

**The problem.** The endpoint sends the whole catalog. Two of its three large arrays are never read
and the page uses about 0.4% of the third; facts repeat across five places. The Runtime view
re-fetches it every 30 seconds (`src/lib/dashboard/client/poll.mjs:154`).

**What the user sees.** A slow tab and tens of megabytes parsed every 30 seconds, growing with each
project.

**What should be the case.** The page downloads only what it shows; scripts can still get
everything.

**The choices.**

- **A. Leave it.**
- **B. A slim endpoint for the page** (`/api/system/summary`) with only what the page draws,
  including `presence[].provider`; the page and its poll use it; `/api/system` and
  `ak system --json` stay exactly as documented.
- **C. Slim `/api/system` itself with `?full=1`.** Changes a documented endpoint; needs an upgrade
  note.
- **D. Paging.** More work than needed.

**Recommendation: B.** Options offered: **B: slim page endpoint (Recommended)** · C: slim
/api/system + ?full=1 · A: leave it.

**Choice: B.**

### Decision 9 — `status` and `sync` disagree about AQE's embedding service (S4)

**The situation.** `ak status` (and the dashboard) reads configuration only and never contacts the
embedding service, so it reports "configured-unverified" as information. `ak sync` sends a real
request and fails when the service does not answer (ADR-0055: missing Ollama is "never a green
result").

**The problem.** Status never learns what sync found.

**What the user sees.** `ak sync` printed "✗ aqe-embedding: Local embedding setup incomplete" while
the dashboard showed a grey information dot; the cause was Ollama installed but not running.

**What should be the case.** Both views tell the same story; status stays fast but is honest about
what the last real check found and when.

**The choices.**

- **A. Reword only**, pointing to `ak x verify aqe` or `ak sync` for a live check.
- **B. Remember the last live check:** sync and `ak x verify aqe` save pass/fail, reason and time;
  status shows it (failed as a warning, passed as green with its age); a configuration change
  clears it; old results are labelled stale; status itself never probes. Precedent: the Brain
  release lookup cached in `kit.json` (`src/lib/ruvnet-brain.mjs:150-175`).
- **C. Make status probe live.** Rejected: slower status and dashboard; breaks the no-live-calls
  design.

**Recommendation: B.**

**Maintainer's answer (own words):**

> I like remember last live check, but I also feel we should have an opt-in option for ak status
> to test all live services.

**Challenge round.** `ak x verify` already provides live suites; every suite that writes test data
uses a temporary directory. Five guardrails were proposed for an opt-in `ak status --live`:

1. Reuse the `ak x verify` checks rather than creating a second copy.
2. Only quick, free checks: AQE embedding request, MCP initialize/tools-list, provider wiring,
   security package load, deja-vu structural check, memory store/retrieve in a temp directory.
   Excluded: the slow learning and harvest suites, and the paid host connection check.
3. Checks run in parallel with per-check timeouts; a timeout reads "inconclusive", not failed.
4. One evidence store for all live results, written by `ak sync`, `ak x verify` and
   `ak status --live`; plain `ak status` and the dashboard show each result with its age.
5. The dashboard's regular refresh stays non-live; a "Run live checks" button is a later
   follow-up.

Options offered: **Yes, B + --live as described (Recommended)** · Yes, but --live runs every suite
· Yes, plus a dashboard button.

**Choice: Yes, B + `--live` as described.**

## Remediation plan

Branch `fix/audit-237-238-remediation`, one commit per point, each with its regression test written
first and its documentation and ADR updates. Commit 4 is the single architectural change: it adds a
repair contract to status rows, which sync planning and dashboard rendering both consume, and
commit 10's correctness depends on it.

### Stage 1 — truthful repair rows and sync results

| # | Commit | Addresses |
|---|---|---|
| 1 | `fix(blocks): read guidance drift from the writer's dry-run in status and nudge` | S2 |
| 2 | `fix(mcp): share one legacy-ruflo ownership predicate between status and register` | S1 |
| 3 | `fix(codex-mcp): honor aqe:false in the Codex MCP topology row` | N1 |
| 4 | `fix(status): mark manual-only remediation rows so sync never plans them` | repair contract |
| 5 | `refactor(agentdb): retire the standalone agentdb install and harvest's skill step` | D1, decision A (addendum) |
| 6 | `fix(brain): refresh existing installs through the updater; stamp only the observed release` | D2 |
| 7 | `fix(brain): hold a refused refresh as blocked until the release pair changes` | D3 |
| 8 | `fix(natives): keep the native probe cause; separate unavailable from inconclusive` | P3 |
| 9 | `fix(natives): rebuild a binding that exists but will not load` | P3 |
| 10 | `fix(sync): report promised repairs that did not converge` | S3, ADR-0033 amendment |
| 11 | `feat(sync): add --skip for one-run subsystem exclusions` | decision 5 |
| 12 | `feat(sync): emit one JSON result with --json` | decision 6 |

### Stage 2 — diagnostics, evidence and guidance

| # | Commit | Addresses |
|---|---|---|
| 13 | `fix(aqe-embedding): say Ollama is not running when it is installed` | S4 |
| 14 | `feat(status): remember the last live check and show it with its age` | decision 9 |
| 15 | `feat(status): add opt-in --live running the quick, free verify checks` | decision 9 |
| 16 | `fix(aqe-embedding): accept unrelated dotted root TOML keys` | P1 |
| 17 | `fix(aqe): share one AQE MCP transport recognizer across all hosts` | decision 3 |
| 18 | `fix(aqe): treat live RVF lock contention as busy in verify` | decision 7, #240 |
| 19 | `fix(status): name the unreviewed Brain hook delta and the options` | decision 4 |
| 20 | `fix(status): list options for an out-of-range external agent-browser` | D5 |
| 21 | `fix(status): point non-git project hints at ak setup --project` | N3 |

### Stage 3 — dashboard truth

| # | Commit | Addresses |
|---|---|---|
| 22 | `fix(live): parse ps paths containing spaces; classify desktop-hosted Claude CLI` | L3 |
| 23 | `fix(live): report live source health truthfully` | L6 |
| 24 | `fix(live): reflect the discovery file cap in coverage; stop the files counter drifting` | L5 |
| 25 | `fix(live): keep tail offsets across idle stop and restart` | L4a, ADR-0012 note |
| 26 | `feat(live): show non-git folder sessions through an exact-folder match` | decision 2, ADR-0012 |
| 27 | `feat(hosts): report managed, found-not-managed, and not-installed hosts consistently` | decision 1, ADR-0053 |
| 28 | `fix(maintenance): do not scan or count absent source roots` | M1 |
| 29 | `fix(usage): rank project concentration by repository identity` | M2 |
| 30 | `fix(usage): explain an empty Claude limits panel when the user statusLine is custom` | M3 |
| 31 | `fix(usage): show why Codex limits are unavailable` | P4 |
| 32 | `perf(dashboard): serve the System page from a slim summary endpoint` | decision 8 |

### Gates

A `pnpm test` baseline on `main` before branching; a failing test before each fix; focused
`node --test` and ESLint per commit; `pnpm run test:ui` plus a rendered-browser check for dashboard
commits; `pnpm run check`, AQE coverage-gap analysis and an adversarial review of the full diff at
the end; Windows CI green for the agentdb bin-owner and `ps` census changes. Commit messages carry
no `Co-Authored-By` trailer. Nothing is pushed, released or posted without maintainer approval.

## Upstream and replies

- Created: [#240](https://github.com/pacphi/agentic-kit/issues/240), tracking agentic-qe#574 and
  PR #719.
- Drafts for proffesor-for-testing/agentic-qe: a new issue for the `fleet run` and `task submit`
  CLI defects (plus MCP `task_submit` reporting a failed task as "queued"); a note on #574 that PR
  #719 still attempts the create after the live-lock warning.
- Drafts for stuinfla/ruvnet-brain: set `offBehavior: "silence"` on
  `capacity-aware-parallel-work`; `--update` runs the installed, possibly stale updater; corpus
  freshness.
- ruvnet/ruflo#3196 is already tracked with #213.
- Replies to #237, #238 and #239 with these verdicts.

## Addendum — AgentDB and Ruflo memory alignment (same day)

Before implementation, the maintainer asked whether ak manages AgentDB setup, configuration,
monitoring and maintenance in a way that supplements Ruflo rather than duplicating it, and set the
principle: **ak facilitates and monitors what Ruflo, AQE and the Brain do; it does not run parallel
copies.** Goals: memory carried between tools, backups, and distillation, as supported.

### Findings (Ruflo 3.45.0, bundled agentdb 3.0.0-alpha.20, this repository)

- **ak's standalone AgentDB is a redundant, worse copy.** It was added in #32 so `ak x harvest`
  could run `agentdb skill consolidate`, on the belief that Ruflo's bundled copy had no CLI. The
  bundled package does ship one (`agentdb/dist/src/cli/agentdb-cli.js`) and runs on native
  better-sqlite3; the standalone global is alpha.17 on the WebAssembly fallback, and ak repins only
  on a core-version skew. Its install is on by default while harvest is off by default, which is
  the root of #237 §3.
- **Harvest consolidates an empty store.** The AgentDB CLI reads only `AGENTDB_PATH` or
  `./agentdb.db` (`agentdb-cli.js:1592`); `./agentdb.db` has 0 episodes. Ruflo's own skill path
  (post-task feedback with quality ≥ 0.9 promotes patterns, `memory-bridge.js` ~2122) has produced
  0 skills in every store here; MCP `agentdb_consolidate` calls a stub.
- **Cross-host memory, proven live.** A key stored through Claude's MCP server (`ruflo mcp start`,
  working directory = repository root) was found through Codex's launch path (`ak x ruflo-mcp`).
  `ruflo memory retrieve` in the same repository did not find it, and Ruflo itself warned that
  18,608 entries sat in `.swarm/agentdb-memory.db`, unsearched. MCP writes that store; the CLI,
  hooks, backup and distillation use `.swarm/memory.db` (ruflo#3196, #213). Ruflo's own source
  intends one canonical file unless encryption at rest is on
  (`memory-bridge-canonical-path-2810.test.ts`).
- **What is at risk.** The 168 MB MCP store is about 98% `commands` hook log (18,239 rows written by
  `hooks post-command`, no expiry). About 250 valuable rows (`decisions`, `project-decisions`,
  `claude-memories`, `agentic-kit`, `patterns`) exist only there. Ruflo's daemon backup (nightly,
  keep 7, optional GCS) and distillation (every 30 minutes, ADR-174) workers are hard-coded to
  `.swarm/memory.db`, and the daemon was stopped: last backup 2026-09-10, last distillation
  2026-09-11. ak's daemons row reported "none running" as OK.
- **Stray stores, traced to owners.** `./agentdb.rvf` (Ruflo MCP; bundled AgentDB's RVF backend
  defaults to the working directory), `./ruvector.db` (`ruvector mcp start`), `./agentdb.db` (ak
  harvest), `.swarm/.swarm/agentdb-memory.db` (the Brain's continuity writer runs Ruflo from inside
  `.swarm`, and Ruflo's CLI mirror derives its path from the working directory rather than
  `--path`), `.agentic-qe/` directories under `docs/`, `docker/` and `claude/` (created where AQE
  commands ran; owner not yet confirmed), and `.claude-flow/config.yaml` (written by `ruflo init`,
  `init/executor.js:1403`, while the memory root is read from JSON configuration only).
- **ak polluted real memory.** `tests/live/qe-court-participant-transport.test.mjs` left 118 rows in
  30 `ak-qe-court-live-*` namespaces of the real MCP store.

### Decisions

Presented in the same format as decisions 1–9.

- **Decision A — retire ak's own AgentDB install?** Options: (1) retire the install and harvest's
  skill step; harvest keeps `ruflo hooks post-task` and may trigger Ruflo's own distillation;
  (2) drive Ruflo's bundled CLI against Ruflo's store (unverified schema fit; a whole-file-rewriting
  writer next to a live store risks corruption); (3) keep it and fix only the path (consolidates
  nothing). Recommendation: 1. **Choice: 1.** It replaces commit 5.
- **Decision B — where does the new memory work go?** Options: (1) split by topic, with a separate
  memory branch built on the #213 work; (2) all into this branch as a fourth stage; (3) a new branch
  ignoring #213. Recommendation: 1. **Choice: 2** — the maintainer chose one branch.
- **Follow-up — the uncommitted #213 worktree changes.** Options: bring them into Stage 4 as its
  first commits, or leave them and rework later. Recommendation and **choice: bring them into
  Stage 4.**
- **Decision C — memory databases and git.** Pros of committing: memory follows the repository,
  history, a free offsite copy. Cons: the 168 MB store exceeds GitHub's 100 MB file limit;
  binary files cannot be diffed or merged; live WAL files commit torn states; this repository is
  public and memory holds prompt fragments and decisions; the schema is alpha and version-bound.
  Options: keep raw databases out of git, or commit curated `ruflo memory export` JSON.
  Recommendation and **choice: keep raw databases out of git** (`*.db` is already ignored); ADRs and
  docs are the committed knowledge; Ruflo backups, monitored by ak, provide recovery.
- **Action — remove the 118 leaked test rows.** Approved and done: a WAL-safe backup of the store to
  `.swarm/backups/pre-test-row-cleanup-2026-09-26/`; per-namespace dry runs; a one-namespace canary
  confirmed a native transactional delete (main file unchanged); the remaining 29 namespaces
  purged. Result: 0 test rows, 18,608 → 18,490 rows, `quick_check` ok, valuable namespaces intact.

### Plan changes

- Commit 5 becomes `refactor(agentdb): retire the standalone agentdb install and harvest's skill
  step`, including correcting the "same store" and "cannot drift" claims in code comments, the
  About directory, README and MANAGED-TOOLS. ak stops installing and monitoring the standalone
  global; it does not uninstall it automatically.
- **Stage 4 — memory alignment** (after Stage 3): the #213 work first (cross-interface probe in
  `ak x verify memory`, evidence-bound routing contract, setup probe removal from every store,
  verify isolation, the opt-in live routing test), then: a memory status row naming the canonical
  store, its size and WAL, top namespace and expiry, and stray or nested stores (report only); last
  backup and distillation age from `.claude-flow/metrics`, with the daemons row no longer "ok" when
  backups depend on a stopped daemon; `AGENTDB_PATH`/`CLAUDE_FLOW_MEMORY_PATH` isolation in verify;
  the qe-court live test moved to a disposable project; harvest reduced to `ruflo hooks post-task`
  from the project root plus an optional `ruflo memory distill run`.

### Upstream candidates (not yet filed)

`ruvnet/ruflo`: backup and distillation ignore the MCP store (none found); `hooks post-command`
embeds every command with no expiry or cap (none found); the CLI mirror ignores `--path` (shape
covered by #3196/#3143); `agentdb_consolidate` is a stub that drops its parameters (partly #2977);
`memory stats` ignores `--path` (none found); YAML configuration written but never read (not yet
searched); post-task skill promotion never fires here (not yet searched). `ruvnet/agentdb` or Ruflo:
`agentdb.rvf` created in the working directory; `skill`/`reflexion` ignore `--db` (search
incomplete). `stuinfla/ruvnet-brain`: the continuity writer runs Ruflo with `cwd=.swarm` (none
found). RuVector: `ruvector.db` in the working directory. agentic-qe or ak's AQE hook: `.agentic-qe/`
created in subdirectories (owner to confirm). `ruvnet/ruflo#3195` already covers `doctor` checking
`memory.db` only.

## Follow-ups outside this plan

M1b (a failed source's banner outlives its Discovery row), N4 (preserved memory files, with #213),
N5 (accuracy of the partial Codex parsing advisory), L4b ("CONNECTING" needs a browser trace), F1
(worker early-warning monitor), a per-machine hook-contract acknowledgment, and a dashboard "Run
live checks" button.
