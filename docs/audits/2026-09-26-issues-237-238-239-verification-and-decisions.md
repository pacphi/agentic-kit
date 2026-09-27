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

## Addendum 2 — memory location and install transparency (same day)

While filing upstream reports, the reporting track returned three problems as agentic-kit's own
rather than upstream defects. Each was presented in the decision format above.

### Problem 1 — registering a provider can make Ruflo lose project memory

**The situation.** On `ak setup` and `ak sync`, ak registers each configured provider by running
`ruflo providers configure` in the project directory (`src/lib/providers.mjs:915-924`).

**The problem.** `ruflo init` writes `.claude-flow/config.yaml`, but Ruflo reads memory settings only
from `claude-flow.config.json` or `.claude-flow/config.json`. When neither exists,
`providers configure` writes a new `claude-flow.config.json` from Ruflo's defaults, including
`memory.persistPath: "./data/memory"`, and Ruflo then looks for memory in the wrong place. Reproduced
in a disposable project on Ruflo 3.45.0: `memory list` reports "Database not found", `memory store`
reports "Database not initialized", and `.swarm/memory.db` is orphaned; moving the new file aside
restores access. The Ruflo side is reported on ruvnet/ruflo#3193; ak is the trigger.

**What the user sees.** Latent on the maintainer's machine (no providers configured). The first
configured provider would silently hide project memory from the CLI and hooks.

**What should be the case.** Registering a provider never moves or hides memory.

**The choices.** A: wait for Ruflo. B: skip registration when it would move memory, and explain.
C: before registering, write a minimal Ruflo JSON configuration pinning the memory folder already in
use; if a future Ruflo overwrites it, fall back to B; `ak status` warns about an orphaned store.
D: let Ruflo write its defaults, then reset the memory setting afterwards.
Verified before recommending C: with `claude-flow.config.json` pinning `memory.persistPath: ".swarm"`,
Ruflo 3.45.0's `providers configure` keeps the value and only adds its own keys.

**Recommendation: C. Choice: C.**

### Problem 2 — Codex's Ruflo memory lands in odd places outside a Git repository

**The situation.** Codex reaches Ruflo through `ak x ruflo-mcp`, which starts Ruflo in the Git
repository Codex is working in; outside a repository it falls back to Codex's starting directory
(`src/lib/ruflo-memory.mjs:13-15`).

**The problem.** Codex often starts outside the user's work: at the filesystem root, where nothing can
be written, or inside its own `~/.codex/.chatgpt-projects/…` folders. Observed live: one Codex-launched
Ruflo server with working directory `/`, another inside a Codex ChatGPT project folder, three `.swarm`
stores under `~/.codex/.chatgpt-projects/`, and a stray `~/.swarm`. Memory in those sessions either
fails to save or lands where no other host sees it, and `ak status` does not mention it.

**What should be the case.** Memory goes somewhere sensible and predictable: the project folder when
there is one, never the filesystem root or a tool's internal folder, and ak reports which store is used.

**The choices.** A: refuse outside a Git repository. B: always use one user-level store outside a Git
repository. C: a plain work folder keeps its own `.swarm` (as with Claude and decision 2); the
filesystem root, the home folder itself, temporary folders and tool-internal folders use one
user-level store at Ruflo's own user-level convention; `ak status` shows the chosen store and reports,
never deletes, existing stray stores. D: leave as is.

**Recommendation: C. Choice: C.** Claude's user-scope registration starts Ruflo directly, without the
launcher; applying the same rule to Claude sessions would route Claude through the launcher and is
recorded as a follow-up decision.

### Problem 3 — ak edits a file inside Ruflo's install

**The situation.** Ruflo pins better-sqlite3 ≥ 12.8.0 because AgentDB's optional `^11.8.1` has no
Node 24–26 binaries and falls back to a non-persistent engine (`ruflo/scripts/audit-better-sqlite3-override.mjs`,
ruvnet/ruflo#2219). When npm's install-script policy blocks that native build, ak's repair
(`ensureNativeBsq3`, `src/lib/heal.mjs:60-74`) installs the native binding into Ruflo's install and,
because npm otherwise fails with EOVERRIDE, first rewrites the better-sqlite3 lines in the bundled
AgentDB `package.json`.

**The problem.** The repair matches Ruflo's intent, but ak edits another tool's installed files
without recording, showing, or being able to undo the change.

**What should be the case.** Memory persists as Ruflo intends; any change ak makes inside another
tool's install is recorded, visible and reversible, and done the least invasive way that works.

**The choices.** A: keep as is. B: keep the repair; record a receipt (file, field, old and new value,
time), show it in `ak status` and About citing ruflo#2219, restore the originals on `ak uninstall`,
re-check after Ruflo upgrades. C: report only and give the reinstall command. D: first reinstall the
same Ruflo version with the native build allowed so Ruflo's own pin applies; fall back to B.

**Recommendation: B, and test D during implementation, reporting back before switching.
Choice: B.**

### Plan changes

**Stage 5 — memory location and install transparency** runs after Stage 4, built on the integrated
branch:

| # | Commit | Addresses |
|---|---|---|
| 5.1 | `fix(providers): pin the Ruflo memory root before registering providers` | Problem 1 |
| 5.2 | `fix(ruflo-mcp): keep Codex's Ruflo memory out of system and tool folders` | Problem 2 |
| 5.3 | `fix(natives): record, show, and reverse ak's edits inside Ruflo's install` | Problem 3 |

## Follow-ups outside this plan

M1b (a failed source's banner outlives its Discovery row), N4 (preserved memory files, with #213),
N5 (accuracy of the partial Codex parsing advisory), L4b ("CONNECTING" needs a browser trace), F1
(worker early-warning monitor), a per-machine hook-contract acknowledgment, and a dashboard "Run
live checks" button.

## Implementation status (integration/237-238)

This section was added the same day, after implementation. The opening paragraph ("Nothing in
this record is implemented") describes the record as it was written against `847486c`.

This section records what then landed on the local branch `integration/237-238`, which was built
from `3505a29` (the Addendum 2 commit). Every SHA below is on that branch.

- The branch is not merged into `fix/audit-237-238-remediation` or `main`.
- The implementation lanes and integration stages pushed nothing, released nothing and posted
  nothing.

### How it was built

- **Lanes.** Each lane built its commits test-first in its own worktree: a failing regression test
  came before each fix.
- **Integration.** An integrator cherry-picked the commits in plan order with `git cherry-pick -x`.
  Conflicts were resolved so that both sides' intent was kept. After each pick the integrator ran
  that pick's focused tests and ESLint.
- **Stage 5** was written directly on the integrated branch.
- **Commit count: 50** at `737562c`, not counting the commit that adds this section. The eleven
  later commits and the review fix wave are listed under "Plan items and commits".
  - 45 are cherry-picks, and each carries its `cherry picked from` line.
  - 4 were written in place for Stage 5.
  - 1 is an integrator fix, `259f075`.
  - No commit has a `Co-Authored-By` trailer.
- **How the checks ran.** They are the `check` and `test:ui` equivalents, run with `node` and `npx`
  directly rather than through `pnpm`. The worktree's `node_modules` is a link to the main checkout's,
  and pnpm's dependency check would try to remove it.

### Plan items and commits

#### What the evidence columns mean

- The evidence is the focused `node --test` run after the commit was integrated, written as passed
  out of run.
- Where a run skipped a test, the skip was the Windows-only test that is skipped on macOS.
- `dashboard.cjs` means `tests/dashboard.test.cjs`.

#### Before Stage 1

These two problems were found while taking the baseline:

- `pnpm test` had one failure on `847486c`.
- A baseline `pnpm test` rewrote the real project's statusline to show Ruflo "9.9.9", and removed
  its memory and AQE environment pins.

| # | Commit | SHA | Focused evidence |
|---|---|---|---|
| 0b | `test(telemetry): keep the hermetic export from reading real host sessions` | `8fc4797` | telemetry-cli 22/22; the baseline failure passes |
| 0c | `test(isolation): run lifecycle sync and setup tests in a sandbox project` | `5618e97` | 13 files, 198/198 |
| 0d | `fix(statusline): stop overwriting Ruflo's baked version` | `b6c8dae` | 97/97 |
| 0e | `feat(status): flag a statusline that shows a different Ruflo version than installed` | `7b9f7cd` | 223/223 |

#### Stage 1

| # | SHA | Focused evidence |
|---|---|---|
| 1 | `8596f21` | 105/105 |
| 2 | `cea1783` | 186/186 |
| 3 | `7fac767` | 71/71 |
| 4 | `0ee005f` | 309/309; dashboard.cjs 86/86 |
| 5 | `5e02beb` | 347/347; dashboard.cjs 86/86 |
| 6 | `4525733` | 116/116 |
| 7 | `35ce7ce` | 149/149 |
| 8 | `8ad8b8a` | 84/84 |
| 9 | `07ca201` | 162/162 |
| 10 | `7e3cbe2` | 138/138 |
| 11 | `01c775d` | 73/73 |
| 12 | `6c6912d` | 442/442 (every sync, status, natives, setup and Codex MCP suite) |

#### Stage 2

| # | SHA | Focused evidence |
|---|---|---|
| 13 | `88b2296` | 74/74 |
| 14 | `5e8d431` | 279/279 |
| 15 | `c804d9a` | 383 passed, 1 skipped |
| 16 | `9b18fda` | 214/214 |
| 17 | `85c0ebc` | 305/305 |
| 18 | `31294f2` | 258/258 |
| 19 | `1829241` | 154/154; statusline-brain.cjs 10/10 |
| 20 | `5b83626` | 31/31 |
| 21 | `6ea0124` | 117/117 |

#### Stage 3

Two rows here are not numbered in the plan:

- 26+ is a review fix to 26: `fix(live): keep the exact-folder correlator across the metadata bootstrap`.
- 29+ is a docs fix: `docs(maintenance): qualify fresh-install coverage wording for absent hosts`.

| # | SHA | Focused evidence |
|---|---|---|
| 22 | `50b9491` | 113/113 |
| 23 | `4d5ee52` | 221/221 |
| 24 | `b10a344` | 487/487 |
| 25 | `0e04519` | 493/493; dashboard.cjs 86/86 |
| 26 | `cbd8ff3` | 502/502 |
| 26+ | `679532c` | 503/503; dashboard.cjs 86/86 |
| 27 | `6d3d9c4` | 682/682 |
| 28 | `93ee66a` | 545/545 |
| 29 | `80f1f6f` | 709/709 |
| 29+ | `8bd3c6b` | 275/275 (documentation guards) |
| 30 | `5d5c288` | 436/436 |
| 31 | `e487900` | 448/448 |
| 32 | `7a21e7d` | 506/506; dashboard.cjs 86/86. A test isolation defect in this commit is fixed by `259f075` (see Open items) |

#### Stage 4

The first addendum's "Plan changes" describes this stage in prose. The labels 4.1–4.7 are
this section's own.

| # | Commit | SHA | Focused evidence |
|---|---|---|---|
| 4.1 | `refactor(exec): share a process-tree kill helper` | `7c9bf4f` | 348 passed, 1 skipped |
| 4.2 | `feat(verify): prove the memory route across CLI and MCP` | `1c95991` | 598 passed, 1 skipped |
| 4.3 | `feat(status): gate memory routing claims on observed release evidence` | `594eabe` | 723 passed, 1 skipped |
| 4.4 | `fix(setup): remove the setup memory probe from every store` | `e397f6d` | 601 passed, 1 skipped |
| 4.5 | `feat(status): report the canonical memory store, its size, and stray stores` | `0d86dbc` | 611 passed, 1 skipped |
| 4.6 | `feat(status): report memory backup and distillation age` | `f015df0` | 1,180 passed, 1 skipped |
| 4.7 | `test(live): run the qe-court live test in a disposable project` | `c9c1987` | 1,136 passed, 1 skipped |

#### Stage 5

| # | SHA | Focused evidence |
|---|---|---|
| 5.1 | `72506d3` | The new pin test passes 9/9. The provider, memory and sync suites pass 85/85 and 197/197. A real Ruflo 3.45.0 run in a disposable home registered a provider and kept memory at `.swarm`. |
| 5.2 | `1274262` | The new location test passes 8/8, and a 322-test focused batch passes. |
| 5.3 | `b036f7c` | The new receipt and About tests pass 8/8 and 2/2. heal-natives passes 28/28, and a 361-test focused batch passes. |
| 5.3+ | `719b048` | This docs commit is `docs(adr): record the About install-edit line in ADR-0026`. The documentation guards pass 36/36. |

#### Integration fix after Stage 5

| Commit | SHA | Evidence |
|---|---|---|
| `test(system-summary): keep the deep-refresh test out of the real maintenance state` | `259f075` | Each kit test file was run alone with `XDG_STATE_HOME` redirected. Before the fix, system-summary was the only file that wrote any file there: 8 maintenance files. After the fix it passes 8/8 and writes nothing. |

#### Stage 6 (upstream watch) and records

These eleven commits landed after this section was first written. Addendum 3's plan changes map
them to Stage 6 and the program plan. The Branch 0 Step 1 gate on `5764c51` checked them together
and every gate passed (see the results table below), so the last column names the suite that covers
each commit rather than a separate focused run.

| Commit | SHA | Covered by |
|---|---|---|
| `docs(adr): propose ADR-0060 session surface, initiator and official product names` | `854576f` | markdownlint and the documentation guards |
| `docs(audits): record Addendum 3 decisions for the remediation` | `d2a5241` | markdownlint and the documentation guards |
| `fix(packaging): ship the upstream constraint registry with ak` | `24ddc42` | `build-check`: `npm pack` lists 522 files at `5764c51`, the registry included |
| `feat(upstream): watch every upstream thread ak depends on` | `07c2694` | `upstream-watch-registry` |
| `feat(upstream): deterministic upstream status check` | `47acb1b` | `upstream-watch-script` |
| `feat(skills): upstream-status maintainer skill for Claude and Codex` | `3f0a7fe` | `upstream-watch-skill` |
| `docs(upstream): one registry for constraints and watched threads` | `357f465` | markdownlint and the documentation guards |
| `chore(upstream): re-verify constraints against 2026-09-26 evidence` | `de88fdd` | `upstream-watch-registry` and `hook-upstream` |
| `test(upstream): derive test clocks from the registry's verification date` | `5d7698a` | `upstream-watch-registry` and `upstream-watch-script` |
| `fix(upstream): one ledger line per upstream comment` | `184b14c` | `upstream-watch-script` |
| `docs(plans): plan the remediation program across ten branches` | `5764c51` | markdownlint |

#### Review fix wave (Branch 0 Step 2)

An adversarial review of `3505a29..5764c51` in five dimensions (correctness, security, hermeticity,
documentation and contracts), each finding checked by an independent refuter, confirmed 32
findings. They were fixed test-first from `5764c51`, one commit per finding. The evidence is the
focused run after the fix; the failing test was run first and seen to fail.

| Finding | SHA | Focused evidence |
|---|---|---|
| A held Brain refresh erased by the sync that records it | `726df78`, `77faf7a` | new sync-level test; 86/86 across the Brain, heal, sync and setup suites |
| `mcp.register: false` rows promising a sync repair | `430a82d` | 26/26; command suites 153/153 |
| `--skip providers` leaving Codex MCP fixes unresolved | `539809e`, `d0b728f` | 75/75; the follow-up, which still proves a partly skipped subsystem's planned fixes, 92/92 |
| `--skip` still writing through a shared step | `9f8925b` | 90/90 |
| A temp-root project routed to the user-level memory store (and its Windows duplicate) | `f953146`, `fbb6507` | 54/54 |
| The setup probe left in a redirected memory root | `675d6c4` | 40/40 |
| Distillation that could not run counted as a pass | `b7e83c2` | 28/28 |
| The upstream ledger trusting any commenter | `92e87c4` | 28/28 (a guard on the routine prompt) |
| Stage 6 recorded as unimplemented on this branch | `e1abc37` | markdownlint |
| The split Stage 6 table | `1115b24` | markdown-it renders one table |
| The host-status test's fake codex on Windows | `472c71a` | 26/26 |
| The unguarded stamp removal aborting sync | `f8e2e13` | 13/13 |
| The blocked version repair not marked manual | `abee0fc` | 80/80 |
| A crashed native probe reported as "exited 1" | `ee9eaa8` | 81 passed, 1 skipped |
| About cards without the manual label | `babd9b1` | `dashboard-ui` 492/492 |
| The skill omitting report groups | `f3e25d5` | 3/3 |
| The report table omitting "Could not check" | `be257df` | markdownlint |
| An inline AQE Codex entry called a warning | `e161d9b` | markdownlint |
| The sweep's opened/commented split | `80dec49` | registry: 56 filed, 12 commented |
| ADR-0033's decision citations | `c6103e5` | markdownlint |
| Main help missing `--live`, `--skip` and `--json` | `d9c3b73` | cli-help 9/9 |
| "now" in TROUBLESHOOTING | `9a45965` | markdownlint |
| ruvnet/ruflo#3473 missing from the watch | `eb1b806` | 40/40 |
| A second opencode guidance writer | `14cf2df` | 203/203; host suites 380/380 |
| Proofs pinned to an enclosing repository's store | `54c116f` | 41/41; status-live 11/11 |
| The abort comment's overclaim | `ad36ab2` | comment only |

`f6a7856` links ruvnet/ruflo#3473 in Item 6; it answers no finding. The review also found that
this section had no rows for the eleven later commits; the two tables above are that fix. Not
changed in this wave:

- Whether a fail-level manual row fails sync. Today it depends on whether anything else is planned;
  choosing one rule is a maintainer decision, and the same class predates this branch. Decided
  afterwards: see Decision 10 in Addendum 3.
- Stopping the whole process tree on an abort. It needs Windows CI to prove; only the comment was
  corrected.
- Tests that leave temporary folders behind, and pre-existing tests that write into an enclosing
  repository when `TMPDIR` is inside one. Both belong to the test-hermeticity branch.
- A worktree `.claude` modification time that changed during the review. It came from concurrent
  runs, and no user state changed.

#### Remediation program Branch 1 (`fix/imported-rollout-origins`, 2026-09-27)

Added after the fact. This branch was built from `be1c1d47` for the
[remediation program](../superpowers/plans/2026-09-26-remediation-program.md), not on
`integration/237-238`, and it is not merged. It implements ADR-0060 §3 for project discovery: a Codex
rollout imported from a Claude Code transcript gives a folder no project, Codex host or Desktop
origin, and discovery counts it in `importedExcluded`, which the System KPI note shows. A read-only
count on this machine on 2026-09-27 found 924 imported rollouts (the 874 above was 2026-09-26) and
32 folders whose Desktop origin came only from imports (23 above). Commits: `0c56f48f` (discovery),
`a76738a4` (System note), `7e73a324` (ADR-0052), `bcdf9f89`, `c5f4e701`, then a review fix wave that
advances the footprint snapshot schema to v8 so a snapshot taken before the change is not shown
with the old origins. What remains is listed under Open items.

### Full-suite results at each stage end

#### Baseline on `847486c`

- The kit suite passed 4,485 of 4,492, with 6 skipped and the one 0b failure.
- All nine `.cjs` suites passed.
- Commit 5 retired two of those `.cjs` suites (agentdb and harvest), leaving seven.

| After | Tip | Kit tests: passed / skipped / failed (of total) | Coverage: lines / branches / functions (%) | `.cjs` suites |
|---|---|---|---|---|
| 0b–9 | `07ca201` | 4,580 / 6 / 0 (4,586) | 92.64 / 81.82 / 91.96 | 7 of 7 pass |
| 10–21 | `6ea0124` | 4,779 / 6 / 0 (4,785) | 92.74 / 81.96 / 92.05 | 7 of 7 pass |
| 22–32 | `7a21e7d` | 4,877 / 6 / 0 (4,883) | 92.81 / 82.16 / 92.20 | 7 of 7 pass |
| Stage 4 | `c9c1987` | 4,982 / 6 / 0 (4,988) | 92.92 / 82.32 / 92.32 | 7 of 7 pass |
| Stage 5 | `719b048` | 5,009 / 6 / 0 (5,015) | 92.99 / 82.37 / 92.44 | 7 of 7 pass |
| Stage 6 and records | `5764c51` | 5,047 / 6 / 0 (5,053) | 92.95 / 82.22 / 92.34 | 7 of 7 pass |
| Review fix wave | `d0b728f` | 5,068 / 6 / 0 (5,074) | 92.98 / 82.29 / 92.36 | 7 of 7 pass |

#### Checks that passed at every stage end

- The typecheck was clean.
- ESLint reported 0 errors and no new warnings. Warning sets were compared by file, rule and message;
  there are 69 warnings at the tip.
- The complexity-50 gate was clean.
- markdownlint found 0 issues in 162 files (165 from `5764c51` on).
- `build-check` passed.
  - `npm pack` grew from 505 to 520 files as new runtime modules shipped, and lists 522 at
    `5764c51` and after the review fix wave.
- After the review fix wave, `npx eslint .` also reads the review's git-ignored scratch folder
  (`.superpowers/`, copies of the repository and reproduction scripts) and reports errors only
  there; with that folder ignored it reports 0 errors and the same 69 warnings as at `5764c51`.
- Regenerating the status golden file changed nothing.
- The main checkout stayed at `3505a29` with a clean tree.
- The files watched by the tripwire from commit 0c did not change.

#### Final checks

- **Kit suite after the fix.** After `259f075`, the kit suite ran again with `XDG_STATE_HOME`
  pointed at a temporary folder.
  - Result: 5,009 passed, 6 skipped and 0 failed, of 5,015.
  - Coverage: 92.97 / 82.31 / 92.36. It is slightly lower because the fixed test no longer drives
    the default maintenance services.
  - The only thing written into that folder was an empty `opencode` folder, which six test files
    create. `opencode.test.mjs` does the same at `3505a29`. On this machine
    `~/.local/state/opencode` already exists and did not change.
- **UI suites.** These use the system Chrome and fixture data.
  - `dashboard-ui` passed 491/491, with no console errors and no failed or off-origin requests.
  - The seven `node:test` UI files passed 10/10.
  - These include the unmanaged-host readiness test from commit 27 and the System page fixtures for
    the summary endpoint from commit 32.
- **Stage 5's ruflo About line.** A scratch browser check, not committed, confirmed that the line:
  - shows the `natives` row verbatim;
  - escapes markup;
  - is visible on the card;
  - leaves the chip unchanged.

### Deviations from the plan

#### Integration

- Commit 4 adds `isolateProject()` to its new test. Lane H's isolation census requires it.
- Manifest changes are inside the commits that need them:
  - Commit 5 drops the retired agentdb and harvest `.cjs` suites from `test`.
  - 4.4 adds the `test:ruflo-memory-live` script.
  - 4.7 adds its helper to `files`.
- Restructured ADR headers:
  - The GA surface guard reads only the first 1,200 characters, and the ADR-0012 and ADR-0016 Update
    notes must fall inside that limit. Each header is now one short `Updated` line. The detail moved,
    verbatim, into an end-of-file amendment: "live acquisition" in ADR-0012 and "project memory" in
    ADR-0016.
  - The ADR-0023, ADR-0033 and ADR-0055 headers each merge several lanes' 2026-09-26 notes.
- Commit 30 re-anchors the `quota.mjs` line citations in USAGE-SCORECARD-METRICS, because the
  commit moved those lines.
- In 4.6, the daemons-status tests expect `repair: null`. That is commit 4's row contract, which the
  lane's base did not have.
- 26+ and 29+ were kept as separate commits, not squashed.
- `259f075` is an integrator fix made after Stage 5.

#### Lanes

Behavior that differs from, or goes beyond, the plan text.

- **0b:** The cause was a gap in the test harness, not the product. The test inherited
  `XDG_DATA_HOME`, which is where OpenCode keeps its store. The commit title is therefore
  `test(telemetry)`.
- **0c:**
  - Two more test files are isolated: uninstall-command and deja-vu-teardown-verify.
  - The tripwire watches more project files than the four the plan named.
- **2 and 4:**
  - Status reads the target project's MCP scopes.
  - More rows are manual-only than the plan listed: host login, models, the OpenCode configuration
    rows, and the user-owned Codex `mcp-server` row.
  - When only manual rows remain, sync prints "nothing sync can do — N item(s) need a manual step".
  - The statusline sync step also fires for `statusline/cve`.
- **5:**
  - `ak x verify harvest` fails, rather than skips, when Ruflo is absent.
  - The About agentdb card reads "state unknown".
- **8 and 9:**
  - An inconclusive native probe is a warning. As a result, `ak status` exits 0 when the probe times
    out twice.
  - The heal removes an unloadable binding before it rebuilds, and probes again afterwards.
- **10–12:**
  - Convergence counts the rows where `fix && repair !== 'manual'`.
  - `--skip` also accepts comma-separated names.
  - The JSON result adds:
    - `error`;
    - a `reason` on each unresolved entry;
    - `converged: null` when a run stops before a verdict.
- **14 and 15:**
  - Harvest and learning results are not recorded, because they have no evidence id.
  - `--live` sends the embedding request only for a kit-managed backend.
  - The providers check runs `aqe health` only where `.agentic-qe` exists.
- **16–18:**
  - The TOML table has 29 cases, 3 more than the planned 26.
  - An inline Codex AQE registration is now a conflict. Dotted and quoted ones were already refused,
    and now get a more specific message.
  - `npx agentic-qe mcp` and `.ps1` shims are not recognized.
  - Lock contention never hides an embedding initialization failure.
- **23:**
  - There are two new source states: `awaiting-file` and `no-events`.
  - The `codex-state` live source reports `unavailable` on every Claude-only machine, so that
    state is not counted as a source issue.
- **26:** The folder correlator's secret belongs to each collector and is never serialized.
- **27:**
  - The same management words appear in `ak host status`, `ak about` and the `ak status` providers
    rows.
  - A fourth label, "Not managed", covers a host that has not been assessed.
- **30:**
  - There are two classes beyond the three planned: `project-helper` and `unknown`.
  - The payload fields are `claudeChannel` and `codexUnavailable`.
- **4.2–4.4:**
  - Each doc change is in the commit whose behavior it describes.
  - The memory check in `ak status --live` does not observe routes.
- **4.5 and 4.6:**
  - The memory section resolves the repository root when run from a subfolder.
  - Backup age also counts manual `ruflo memory backup` files.
  - Messages say "at most daily".
- **4.7:** The qe-court live test was not run, because it is paid.
- **5.1:**
  - A provider step degraded by the memory guard reports `ok: false`, so `ak sync` always prints it.
  - One test, for an unwritable pin, was added after the implementation and was not observed failing
    first.
- **5.2:**
  - "Temporary folder" means the temporary root itself. As a result, the sandbox used by
    `ak x verify memory` keeps its own store.
  - The tool-folder list is wider than the plan's. It adds:
    - `~/.claude-flow` and `~/.ruflo`;
    - `~/.local` and `~/.cache`;
    - `~/Library/Caches` and `~/AppData`;
    - the `XDG_*`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` overrides.
  - The user-level store is `~/.claude-flow/memory`. Ruflo defines no user-level memory store, so
    this location follows Ruflo's `~/.claude-flow` state folder by analogy.
  - A new `user-memory` status section reports this store and any stray stores.
  - `memoryProjectRoot` changes only for a Git repository at `$HOME` or `/`, or inside a tool folder.
- **5.3:**
  - **Option D was tested in disposable install prefixes and was not adopted.**
    - Only 1 of 4 runs ended with a working native binding.
    - Ruflo's own `better-sqlite3` override never applied to a global install.
    - A fresh 3.45.0 install needed no manifest edit.
  - One test, "every heal re-checks receipts first", was added after the implementation.
  - An extra docs commit, `719b048`, records the About line in ADR-0026.

### Open items

#### Needs the maintainer's action

- **A test overwrote the real maintenance state.**
  - What was written: `~/.local/state/agentic-kit/maintenance/latest-scan.json` and
    `management/*` were rewritten from the fixture in the `system-summary` test.
  - When: every run of that test until `259f075`.
    - Observed: the full-suite runs after Stage 4 (14:46) and Stage 5 (15:35 local time, 22:35 UTC,
      on 2026-09-26, the last write).
    - Inferred from the same mechanism: lane F2's runs and the run after Stage 3.
  - What is there now: `management/locators.json` holds 90 fixture paths (`/Users/someone/…`).
  - What was not touched: `preferences.json` and `transactions/`.
  - The earlier content cannot be recovered from here.
  - To repair it:
    1. Run **Re-measure machine** in the dashboard's Maintenance area.
    2. Check that `locators.json` no longer mentions `/Users/someone`.
- **Run a Full scan after Branch 1 lands.** The footprint snapshot schema moves to v8, so System
  and the Maintenance session-origin facet show the Projects section as not measured until **Full
  scan** or `ak system --deep` writes a new snapshot. Before that, the 49 folders the v7 snapshot
  lists with a Codex Desktop origin include the false ones.
- **Left open by Branch 1.** ADR-0060's status (it is still Proposed, and Branch 7 waits for its
  acceptance). The Intelligence census line, the System → Projects liner and the `ak system` text
  output show the smaller counts without the imported-copy count (ADR-0060 Implementation status).
  6 of the 924 imported rollouts hold a later turn that is not an import and has real token usage,
  which whole-rollout exclusion drops. The maintainer decided on 2026-09-27 to count them in
  Branch 8 (decision 12 below).
- **The dashboard server's hermeticity guard has a gap.** It fires only when a maintenance service
  is injected without a control root. A caller that injects only a System collector still gets the
  default maintenance service and management facade, and both write real state. This product-side
  follow-up is not fixed here.

#### From Stage 5

- **Unreceipted edits.** This machine already carries three edits that ak made before receipts
  existed. Each sets `better-sqlite3` to `^12.10.0`:
  - bundled `agentdb` `optionalDependencies`;
  - `@claude-flow/memory` `optionalDependencies`;
  - `@claude-flow/cli` `overrides` and `optionalDependencies`.

  There are no original values, so ak cannot show or restore these edits. The docs tell the user
  to reinstall Ruflo to get pristine files.
- **Claude-side memory outside a project.** Claude's direct `ruflo mcp start` registration, and
  Claude-side harvest and setup, still use `<cwd>/.swarm` outside a project. This is a follow-up
  decision under Addendum 2.
- **`ak x host --dry-run`.** The command declares `--dry-run` but never reads it; this is
  pre-existing. Its provider registration, and now the memory pin, run even with that flag.
- **Status wording.** When both the repository root and the folder are unsuitable, the status reason
  names the repository root's reason ("the home folder") rather than the tool folder's. This is
  cosmetic.
- **Resolved during development.**
  - A heal test briefly wrote a real `install-edits.json` holding only temporary fixture paths, then
    pruned it. The test is now sandboxed, and no such file exists after the final runs.
  - The option D runs went through mise's npm wrapper. Its reshim hook failed in the sandbox and
    changed nothing.

#### Carried from the earlier stages

- **AQE embedding conflicts fail every sync.** An AQE embedding projection conflict gives the status
  row a sync fix that sync cannot perform, so on such a machine every `ak sync` exits 1. Commit 16
  made an inline Codex AQE registration, which was previously read as absent, a conflict. The upgrade
  note calls this a "warning". This comes from reading the code and was not executed. The owner's
  decision is needed on marking a conflict-only row `manual`.
- **The bare `ak` hint counts only rows with a fix.** A machine whose only warnings have
  `fix: null`, such as a stale backup or two memory stores, prints "0 item(s) need attention — run:
  ak sync".
- **Sync.**
  - `ak sync --json` with an unknown option prints help, not JSON.
  - A configuration error under `--json` loses its recovery text.
  - With `--skip`, the `skipped by request` lines print twice.
  - `src/commands/sync.mjs` is 1,004 lines, close to the max-lines limit.
- **Status.**
  - With an unwritable evidence store, `ak status --live --json` can print a non-JSON warning on
    stdout.
  - `--deep` is declared but never read.
  - `ak x verify aqe` records failures of an unmanaged backend.
- **Limits.** `readLimits` starts `codex app-server` whatever the Codex host setting says. This needs
  a policy decision.
- **Memory.**
  - Old `_setup/verify-*` rows in existing MCP stores: clean them up once, or leave them.
  - AQE's relative `AQE_MEMORY_PATH`: file it upstream, or anchor it in ak's projection.
  - Observed routing evidence is macOS-only.
  - The two-store warning is permanent (N4).
  - `ak setup` sets `daemon.autoStart: false`, so Ruflo's backups stop. This needs a decision.
- **Live.**
  - No real producer of a structured live-events file exists, so that path has fixture evidence only.
  - The plain-folder bind has not been observed on a real machine.
  - A file that re-enters the window at restart is read from its start.
- **Usage.**
  - The Claude statusLine classifier does not read managed settings.
  - A shell wrapper around the footer helper is classed as `custom`.
  - Other spawn tests still inherit the developer's `XDG_*` variables.
  - M1b is still open.
- **ADR index.** In `docs/adr/README.md` the index table ends at ADR-0052; later ADRs appear only as
  bullets or sections. This predates the branch.
- **UI suite outside `test:ui`.** `tests/ui/maintenance-focus.mjs` fails "polyglot cards expose
  labelled language badges" at `3505a29` too. That file is not part of `test:ui`.

#### Not run

- Windows CI. It is the gate for:
  - the `ps` paths with spaces;
  - junction-based symlinks;
  - the `codex.cmd` and `.cmd` transport recognition;
  - `taskkill` process-tree kills;
  - the `%APPDATA%`, `%LOCALAPPDATA%` and `AppData` tool-folder branch.
- `tests/live/*`.
  - The memory-routing test uses the real home folder.
  - The qe-court test is paid.
- Per-lane browser checks against real data:
  - Live source health and the zero-operations note;
  - host badges and About chips;
  - Discovery "Not installed";
  - the Limits empty states;
  - the transfer size of `/api/system/summary` against `/api/system`.
- A human review of the UI screenshots in `.ui-artifacts/`.
- The Stage 5 About line has no committed rendered test.
- External link checking.
- The end gates from "Gates" above: AQE coverage-gap analysis and an adversarial review of the full
  diff.

## Addendum 3 — daemon, stray stores, verification, upstream watch and product names (same day)

The implementation lanes returned seven further findings, and the maintainer asked two new
questions: how to tell where sessions came from, and how to keep upstream issues watched without a
person. Each finding was presented in the decision format above. Evidence was observed on Ruflo /
`@claude-flow/cli` 3.45.0, agentic-qe 3.14.3, npm 11.17.0 and macOS (arm64).

### Item 1 — Ruflo's backups and distillation are not running

**The situation.** Ruflo's daemon runs a daily memory backup and a 30-minute distillation
(`services/worker-daemon.js:31-39`). Ruflo starts the daemon on any command only when auto-start is
allowed; its own `init` writes `claudeFlow.daemon.autoStart: false` (`init/settings-generator.js:123`)
and `ak setup` starts the daemon once, turning a `true` back to `false` (`src/commands/setup.mjs:575-585`).
AI workers are opt-in since Ruflo #2661, so these local workers spend no tokens.

**The problem.** Even when started, the daemon stops itself about 60 seconds later: its idle check
uses each worker's last-run time restored from the previous run (`worker-daemon.js:671-679, 1016,
1027-1038`, ruvnet/ruflo#3194). This repository's daemon log shows 915 starts and 859 idle
shutdowns; the last backup ran on 2026-09-10 and the last distillation on 2026-09-11. On macOS the
daemon also defers work for "low memory" because `os.freemem()` excludes reclaimable cache
("3.9% free", ruvnet/ruflo#2935). Ruflo's supported settings are flat keys in
`.claude-flow/config.json` (`daemon.idleSecs`, `daemon.resourceThresholds.minFreeMemoryPercent`).
`ruflo config set` must not be used to write them: in a disposable project it wrote a full default
configuration to `claude-flow.config.json`, including `memory.persistPath: "./data/memory"`, after
which `ruflo memory store` failed with "Database not initialized"; the key it wrote never reached the
daemon, and a value of `0` was rejected.

**What the user sees.** Nothing: no backups, no distillation, and no status row saying so.

**What should be the case.** In managed projects, backup and distillation run, and `ak status` says
when each last ran.

**The choices.** A: turn auto-start on and add a status row. A+: A, plus a minimal ak-managed
`.claude-flow/config.json` with flat keys only (`daemon.idleSecs: 0` until #3194 is fixed; a lower
macOS memory threshold until #2935 is fixed), never written through `ruflo config set`, proven in a
disposable project, and removed by version once Ruflo ships the fixes. C: ak runs Ruflo's backup and
distillation commands itself during sync. D: no change.

**Recommendation: A+. Choice: A+** (first chosen as A, then revised when the idle-shutdown defect
was found). The daemon file must coexist with Addendum 2 Problem 1's memory pin in
`claude-flow.config.json`: the daemon reads only `.claude-flow/config.json`, and memory resolution
reads `claude-flow.config.json` first.

### Item 2 — AQE scatters memory stores into subfolders

**The situation.** AQE looks for its store by walking up from the working directory.

**The problem.** A command started in a subfolder first creates `<cwd>/.agentic-qe`, then finds it
(agentic-qe#735). This repository holds nine such stores: about 70 patterns each, mostly AQE's
starter set, and 0–66 captured experiences each (about 99 in total). `AQE_PROJECT_ROOT` makes AQE use
the root (`dist/kernel/project-root.js:42-45`). AQE's own merge tool, `aqe brain export` / `aqe brain
import`, aborts on these stores with `UNIQUE constraint failed: qe_patterns.name, qe_patterns.qe_domain,
qe_patterns.pattern_type` for every strategy while its dry run reports no conflicts. Removing
duplicate patterns from a scratch copy first works: on copies, the root went from 314 to 370
patterns and from 4,623 to 4,689 experiences, with integrity and foreign-key checks clean. The root
store's audit chain was already broken at entry 135 before any merge.

**What the user sees.** Learning split across folders; stray folders in the repository.

**What should be the case.** One AQE store per project, whatever folder a command starts in.

**The choices.** A: pin an absolute `AQE_PROJECT_ROOT` in `.claude/settings.local.json` and the
Codex launcher, and list strays in status. B: make `AQE_MEMORY_PATH` absolute only. C: wait for
upstream. D: status warning only. For existing strays: merge then archive; archive only; delete after
backup; or archive now and merge after the upstream fix.

**Recommendation: A, with merge then archive. Choice: A, with merge then archive.** The merge
action previews, backs up the root, merges each stray through AQE's own export and import after
removing duplicate patterns from a scratch copy, verifies counts and integrity, and moves the stray
into a dated backup folder.

### Item 3 — `ak x verify providers` writes where it runs

**The situation and problem.** It runs `aqe health` and `ruflo providers list` in the current folder
(`src/commands/x/verify.mjs:207,214`), creating an AQE store there, and reads AQE's router file from
the current folder (`:220,227`), reporting false drift from subfolders.

**What should be the case.** Verification only reads, and always checks the project root.

**The choices.** A: resolve the project root, run there with item 2's pin, read from the root, skip
project checks outside a project, and test that no store is created. B: run in a temporary folder.
C: drop the `aqe health` check. D: no change.

**Recommendation: A. Choice: A.**

### Item 4 — `ak status --deep` does nothing

**The situation and problem.** `--deep` is declared and documented (`src/commands/status.mjs:18,32`)
but never read. Decision 9's `--live` now does what it promised, while `ak system --deep` and
`ak maintain scan --deep` mean "re-measure the machine" and `ak usage prompts --deep` means "show
prompt text".

**Maintainer direction.** Revisit every way ak scans and measures so the CLI and the dashboard use
one vocabulary and, preferably, one flag; carry no legacy behaviour.

**What the inventory found.** 34 CLI entry points and 21 dashboard routes, controls and timers perform
11 distinct operations: read recorded evidence, incremental local re-read, quick local re-probe, heavy
Ruflo component re-probe, network metadata lookup, free live round trip, paid inference, full machine
re-measure, discovery walk, inventory rebuild, and configuration re-seed. `--deep` has four meanings
(none on `status`; re-measure on `system`; re-measure first on `maintain`; reveal prompt text on
`usage prompts`), and "refresh" names about ten operations, including `ak host refresh`, which only
rewrites routing. "Full scan" and "Re-measure machine" start the same server chain, while their CLI
counterparts differ. Plain `ak status`, and every 30-second dashboard poll through
`ak status --json`, spawns host `--version`, native load tests and a cached `npm view`, against its
"read-only" help and a code comment (`src/lib/dashboard-server.mjs:463-467`). The same live suites are
called "quick, free" (`status --live`) and "slow" (`x verify`); the security suite also runs
`ruflo security secrets` in the current folder. Results are recorded unevenly across about fifteen
staleness windows in two directories and process memory. Plain defects: `ak x verify all` omits `mcp`
and ignores `--json`; the main help lists stale flags; `ak maintain recipes refresh` can never succeed;
`sync --skip versions` still performs the online lookup; two GET routes start work; two documented UI
messages do not exist; the documentation misdescribes the Maintenance poll.

**The choices.** Flag shape: `--refresh[=live|machine]`; `--check[=live|machine]`; or separate
consistently named flags. Plain reads: re-check only expired evidence and compute dashboard status
in-process; never probe without `--refresh`; or keep probing and say so. Evidence: one store that every
check records to; or separate stores with aligned wording. `ak x verify`: fold into
`--refresh=live`; or keep it as an expert command.

**Recommendation and choice: `--refresh[=live|machine]`; re-check only expired evidence; one
store; fold `ak x verify` into `--refresh=live`.** The design:

| Strength | Does | Replaces |
|---|---|---|
| (none) | Shows recorded results with their age; re-collects quick local evidence only when it has expired | today's probing plain status |
| `--refresh` | Re-runs every local check, the online version lookup, and the Maintenance evidence and inventory | `status --refresh`, `maintain scan [--refresh-inventory]`, "Refresh evidence", "Check again" |
| `--refresh=live` | Adds live round trips; `--only <test>` selects one; slow proofs run only when named | `status --live`, `ak x verify` |
| `--refresh=machine` | Adds the full machine re-measure, with project trees as an option on both surfaces | `system --deep`, `maintain scan --deep`, "Full scan", "Re-measure machine" |

The paid connection check is never a strength of `--refresh`; it stays a separate consent-gated action
with a CLI twin. Operations that are not refreshes are renamed: `ak host refresh` →
`ak host reset-routes`; `ak usage prompts --deep` → `--show-text`; the dashboard header's
"↻ refresh now" → "↻ Reload". The dashboard offers one Refresh control with the same three strengths,
running the same server operation as the CLI and reporting its stages the same way.

### Item 5 — plain npx spellings of AQE's server are not recognized

**The situation and problem.** Decision 3's shared rule accepts npx only as
`npx -y agentic-qe@latest mcp`. AQE's own code and changelog also use `npx --yes agentic-qe mcp` and
`npx agentic-qe mcp`, and pinned versions are common; npm assumes `--yes` when standard input is not
a terminal (`npm-exec.md:29`), so all of them start the same server.

**The choices.** A: accept `npx [-y|--yes] agentic-qe[@latest|@<exact version>] mcp` with no other
arguments. B: keep the rule. C: loose matching (rejected before).

**Recommendation: A. Choice: A.**

### Item 6 — new upstream evidence

**Choice: file and comment.** Filed on 2026-09-26, each with a disposable-environment reproduction
and the installed versions:

- [ruvnet/ruflo#3450](https://github.com/ruvnet/ruflo/issues/3450): `memory purge` and `memory delete`
  leave the AgentDB mirror, so purged data stays readable through MCP.
- [ruvnet/ruflo#3449](https://github.com/ruvnet/ruflo/issues/3449): `config set` cannot configure the
  daemon (wrong file, nested keys, a value of 0 rejected); the memory-root relocation it shares with
  #3193 is linked there.
- [proffesor-for-testing/agentic-qe#736](https://github.com/proffesor-for-testing/agentic-qe/issues/736):
  `brain import` aborts on the pattern uniqueness constraint while `--dry-run` reports no conflicts.
- [ruvnet/ruflo#3473](https://github.com/ruvnet/ruflo/issues/3473): `security defend` crashes on every
  detected threat, so its exit 1 comes from the error handler and cannot tell a detection from a
  crash (the defend item of the closed-upstream review below; still present in 3.46.1).
- Evidence comments on [ruvnet/ruflo#3194](https://github.com/ruvnet/ruflo/issues/3194#issuecomment-5850006786)
  (idle self-shutdown on 3.45.0) and
  [ruvnet/ruflo#2935](https://github.com/ruvnet/ruflo/issues/2935#issuecomment-5850007657) (macOS
  memory gate on 3.45.0).

The #3194 reproduction also showed that a background `ruflo daemon start --ttl <n>` drops the numeric
value and runs with the 12-hour default; it shares #3449's parsing cause and is described there.

Held back: MCP `memory_store` rejecting a custom database path (needs a clean reproduction); the
broken AQE audit chain (needs investigation); AQE's `RUVECTOR_USE_RVF_PATTERN_STORE` switch having no
effect because `initFeatureFlagsFromEnv()` is never called (ak does not use the switch); and AQE
refusing to store pattern embeddings in a fresh home with `VECTOR_SPACE_UNVERIFIED` (possibly
intended).

### Item 7 — leftover files from the test incident

**Choice: delete the three incident files.** Done on 2026-09-26: the memory-pin backup (identical to
the restored settings), the intermediate AQE backup and the damaged copy. ak keeps a new safety copy on
every settings write and never prunes them; undo uses receipts, not these copies
(`src/lib/owned-env-projection.mjs:138-155`). Pruning is a follow-up.

### Upstream watch and dispatch

**The situation.** Upstream fixes were tracked through issues a person had to watch; one release
watcher routine kept running daily for a release that shipped months earlier.

**Maintainer direction.** An agent watches upstream issues and dispatches the matching ak change;
each event is recorded; stale watchers are cleaned up.

**Choices made.**

- A repository registry of watched upstream items: the upstream issue, what "fixed" means (closed
  and released), the ak workaround it affects, and the change ak makes when it lands. A test fails
  when source code cites an upstream issue missing from the registry.
- A deterministic check script (GitHub and npm) reporting maintainer activity, questions addressed to
  us, fixed-but-unreleased, released, and reopened.
- A daily cloud routine on this repository that runs the script, exits on quiet days, and on
  "released" creates `upstream/<id>`, makes the registered change test-first, runs the checks, pushes,
  and opens a draft pull request. It never merges.
- A pinned "Upstream watch" issue records one comment per event, with a machine-readable line that also
  prevents repeated actions; each dispatch pull request updates the registry entry.
- Each entry moves from watching to fixed-unreleased, released, dispatched, adopted and retired; the
  watcher proposes retirement itself, flags 90 days without upstream activity and upstream
  "not planned" closures, and reports when nothing is left to watch. There is one watcher: #240 and
  the upstream remainder of #213 move into the registry when it goes live.
- The routine is created after the registry reaches `main`. The stale release watcher routine was
  disabled on 2026-09-26.

### Ruflo support window

**The situation.** ak declares no minimum Ruflo version; it installs the latest release and gates
features one by one. A review of the ten closed upstream issues ak still cites found that removing
workarounds such as the retired CVE overlay (ruvnet/ruflo#2694, fixed in 3.32.2) is a policy change
without a floor. Ruflo ships minors in bursts (3.43.0–3.46.0 between 2026-09-23 and 2026-09-26; no
new minor between 3.38.0 on 2026-08-11 and 3.39.0 on 2026-09-08), so a window counted in minors alone
swings from days to months.

**The choices.** n-3 minors (3.43.0+ today, three days); n-5 minors (3.41.0+, sixteen days); n-5
minors but never less than the minors released in the last 30 days (3.39.0+); or no floor.

**Choice: n-5 minors, never less than 30 days, rolling** (first chosen as n-3, then widened). Below
the window, `ak status` reports the version as unsupported and points to `ak sync`. The watcher
proposes removing a workaround once the oldest supported version contains its upstream fix. The
policy is recorded with the Ruflo dependency policy in the constraint registry.

### Ruflo 3.46.0 (released 2026-09-26)

3.46.0 closed ruvnet/ruflo#3194 (PR #3421, stale daemon state), #3415 (PR #3423, MCP policy
enforcement in the stdio launchers), #3166 (PR #3441, agent-browser doctor check) and #3167 (PR #3434,
init opt-out flags), and merged the YAML configuration fix for #3193 (PR #3420; the issue remains open).
Item 1's `daemon.idleSecs` override is therefore needed only for supported versions below 3.46.0, and
ADR-0058's governance, the Brain/agent-browser doctor row and the init flags need re-verification
against 3.46.0 before Stage 6 builds on them.

### Retroactive upstream sweep and reactions

A search of every issue and pull request the maintainer opened or commented on outside their own
repositories found 68 threads on agentic-kit's upstreams (56 opened, 12 commented): Ruflo 23 open and
12 closed, Agentic QE 4 and 10, RuVector 1 and 9, AgentDB 3 open, RuvNet Brain 3 open, Codex 2 and 1.
All of them move into the upstream watch.

- **Waiting on us.** ruvnet/ruflo#3046 asked which backend boundary downstream tools want; the
  maintainer's answer (a discovered manifest and subprocess protocol, per ADR-0029) was posted.
  ruvnet/ruflo#2885's triage asked for a macOS arm64 test of single-threaded ONNX Runtime sessions;
  the test was run in a disposable project.
- **Closed upstream but still cited by ak.** A read-only review of ten such items found one
  unconditional removal (the AQE solver heal, agentic-qe#617), one removal that needs the support
  window (the CVE overlay, ruvnet/ruflo#2694), wording and gate fixes for the security check
  (ruvnet/ruflo#2670, fixed in 3.32.2 with a built-in engine), a stale "#2986 pending" note, and
  codex#15451 closed without a fix (ak's wrapper stays). The review also found that
  `ruflo security defend` still crashes after a detection, so its exit code cannot distinguish a
  detection from a crash; the maintainer approved filing it, and it was filed as
  [ruvnet/ruflo#3473](https://github.com/ruvnet/ruflo/issues/3473) and added to the upstream watch.
- **Registry.** agentic-kit already keeps upstream constraints in
  `config/agentic-dependency-constraints.json` (ADR-0041 §7). The watch list extends that registry
  rather than adding a second one. The file is not in the npm package although shipped code reads
  it, so installed copies run the hook audit without constraints; that is fixed with the watch.

### Session origin and product names (staged)

The maintainer asked whether sessions started from Claude Desktop or the ChatGPT app can be told
apart from Claude Code and Codex sessions, and asked for official product names throughout.
[ADR-0060](../adr/0060-session-surface-initiator-and-product-names.md) (Proposed) records the
findings and the proposed model: a session surface and an initiator derived from declared log fields,
the raw value always kept, folders only as explanation, and one table of official names. The key
finding for current views: all 874 rollouts labelled `Codex Desktop` are Claude Code transcripts
imported by the ChatGPT desktop app. Usage already excludes them (ADR-0052), but project discovery
does not, so 23 project folders on this machine show a Desktop origin they never had. The work is
staged as follow-on, starting with that exclusion. (That exclusion is now implemented on Branch 1; see its entry under
Implementation status.)

### Plan changes

**Stage 6 — daemon, AQE stores, verification and upstream watch** runs after Stage 5 on the integrated
branch:

| # | Commit | Addresses |
|---|---|---|
| 6.1 | `feat(status): show whether Ruflo's backup and distillation are running` | Item 1 |
| 6.2 | `feat(ruflo-daemon): enable auto-start with Ruflo's supported daemon settings` | Item 1 |
| 6.3 | `fix(aqe): pin AQE to the project root and list stray stores` | Item 2 |
| 6.4 | `feat(aqe): merge stray AQE stores into the project store, then archive them` | Item 2 |
| 6.5 | `fix(verify): run provider checks from the project root without writing` | Item 3 |
| 6.6 | `refactor(evidence): one evidence store for every remembered check` | Item 4 |
| 6.7 | `perf(status): re-check only expired evidence; compute dashboard status in-process` | Item 4 |
| 6.8 | `feat(refresh): one --refresh flag with live and machine strengths across status, system and maintain` | Item 4 |
| 6.9 | `refactor(verify): fold ak x verify into ak status --refresh=live` | Item 4 |
| 6.10 | `feat(dashboard): one Refresh control with the CLI's three strengths; Reload re-reads the view` | Item 4 |
| 6.11 | `feat(host): consent-gated connection check from the CLI` | Item 4 |
| 6.12 | `refactor(cli): rename operations that are not refreshes` | Item 4 |
| 6.13 | `fix(security-check): scan the project folder and say so` | Item 4 |
| 6.14 | `fix(sync): --skip versions also skips the online version lookup` | Item 4 |
| 6.15 | `fix(dashboard): start scans with POST requests` | Item 4 |
| 6.16 | `refactor(maintain): remove recipe refresh until a registry exists` | Item 4 |
| 6.17 | `docs: align help, README and dashboard docs with the refresh vocabulary` | Item 4 |
| 6.18 | `fix(aqe): recognize every plain npx spelling of AQE's server` | Item 5 |
| 6.19 | `feat(upstream): registry of upstream issues and the ak changes they unblock` | Upstream watch |
| 6.20 | `feat(upstream): deterministic upstream watch check` | Upstream watch |
| 6.21 | `docs(upstream): the watch-and-dispatch routine, its ledger and its lifecycle` | Upstream watch |
| 6.22 | `feat(versions): support a rolling window of Ruflo minors (n-5, at least 30 days)` | Support window |
| 6.23 | `fix(security): stop reporting defend as non-functional when Ruflo ships the built-in engine` | ruflo#2670 review |
| 6.24 | `refactor(heal): remove the AQE solver heal that never installs anything` | agentic-qe#617 review |
| 6.25 | `refactor(statusline): remove the retired CVE-counter overlay` | ruflo#2694 review, after 6.22 |
| 6.26 | `docs(status): drop the stale "#2986 pending" note` | ruflo#2986 review |

6.1 precedes 6.2; 6.2 gates the idle override to versions below 3.46.0; 6.3 precedes 6.4 and 6.5, which use the root pin; 6.5 precedes 6.9, which moves the
verification code; 6.6 precedes 6.7–6.9; 6.8 precedes 6.10; 6.19 precedes 6.20. The `ak x verify`
defects (`all` omitting `mcp`, unread `--json`) are resolved by 6.9 rather than patched in place.

**Update, 2026-09-26: Stage 6 split by the program plan.** Stage 6 no longer runs as one stage on
this branch. The upstream watch (6.19–6.21) landed here as eight commits whose subjects differ from
the table: `24ddc42` (ships the constraint registry with ak, which the table did not list), `07c2694`
(6.19), `47acb1b` (6.20), `3f0a7fe` (the `upstream-status` skill, not listed), `357f465` (6.21),
`de88fdd`, `5d7698a` and `184b14c`. Every other item moved to the
[remediation program plan](../superpowers/plans/2026-09-26-remediation-program.md): 6.22, 6.1, 6.2,
6.23, 6.25 and 6.26 are Branch 3's items 1–6; 6.3, 6.4, 6.5, 6.18 and 6.24 are Branch 5's items 1–5;
6.6 and 6.7 are Branch 6a's items 1–2; 6.8–6.16 are Branch 6b's items 1–9 and 6.17 its item 11.
The order constraints above still hold across those branches.

**Follow-on (not on this branch).** ADR-0060: removing imported copies from project discovery is
done on Branch 1; saying how many were set aside in the Intelligence census line, the System →
Projects liner and the `ak system` text output remains, then the shared surface vocabulary; pruning of ak's settings safety
copies; the AQE audit-chain break; Cowork as a discovery source.

### Decision 10 — sync's exit code and hand-fix rows

The Branch 0 correctness review (finding `correctness-manual-fail-exit-flips`) left one question
for the maintainer. It was presented in the decision format above.

**The situation.** Every `ak status` row with a fix says who performs it: an `ak sync` step
(`repair: 'sync'`) or you (`repair: 'manual'`, shown as `→ manual:`). Sync plans only the first
kind. After applying its plan it re-checks status and exits 1 when a planned repair did not take
or a fail-level row remains.

**The problem.** A fail-level manual row was judged two ways. With nothing else planned, sync
stopped at "nothing sync can do" and exited 0. With any planned fix, `convergenceVerdict` in
`src/commands/sync.mjs` counted every fail-level row as still failing, manual or not, and sync
exited 1.

**What the user sees.** The same machine passes or fails `ak sync` depending on unrelated drift. A
custom recursive `[mcp_servers.codex]` table (a manual fail row) exits 0 on its own, but exits 1 on
any machine with a managed AQE embedding backend, whose check sync always plans. A CI gate on
`ak sync --json` flips for a reason it does not show.

**What should be the case.** One rule, whatever else the plan holds.

**The choices.**

- **A. Sync's exit code reflects only what sync can repair.** A fail- or warn-level manual row never
  flips the exit code or the converged verdict, whether or not the plan is empty. Every such row is
  listed after the verdict under a "needs your action" heading, and in a `needsYourAction` array in
  `--json` (subsystem, level, message, fix). `ak status` stays the overall-health answer and is
  unchanged.
- **B. Every fail-level row fails sync, manual or not,** including when the plan is empty. Sync then
  fails on work it never performs, on every run, until the user acts.

**Recommendation: A.** It matches the repair contract (sync never plans or claims a manual fix) and
keeps `ak sync` a usable gate for what it owns, while `ak status` reports the whole picture.
Options offered: **A: the exit code reflects only what sync can repair (Recommended)** · B: every
fail-level row fails sync.

**Choice: A.** Implemented test-first in `4dc1544`, with
[ADR-0033](../adr/0033-retire-codex-mcp-and-bound-qe-court-participants.md) §9, `ak sync --help`
and [UPGRADING](../UPGRADING.md) updated to match. When a failing manual row remains, the verdict
reads "converged — nothing left that sync can repair" rather than "no failing subsystems". A manual
row of a subsystem named by `--skip` is listed under "needs your action" rather than "skipped by
request".

### Decisions 11 and 12 — imported copies (Branch 1, 2026-09-27)

Both questions came from Branch 1 and were presented in the decision format above.

**Decision 11 — folders named only by imported copies.** On this machine 5 folders appear only in
Codex rollouts that the ChatGPT desktop app imported from Claude Code transcripts. With imports
excluded from discovery, they leave the "ever seen" project count (113 → 108). The choices were to
drop them, since an imported copy is not a session on this machine (ADR-0060 §3), or to credit the
sighting to Claude Code. **Recommendation: drop them. Choice: drop them.**

**Decision 12 — real turns inside imported copies.** 6 of the 924 imported rollouts hold later turns
of real work in the ChatGPT desktop app, with token usage. Whole-rollout exclusion drops them from
usage (ADR-0052) and from discovery. The choices were: exclude per turn in Branch 8, which owns the
usage parsers; do it in Branch 1; or keep whole-rollout exclusion. **Recommendation: per turn, in
Branch 8. Choice: per turn, in Branch 8.** Imported turns are never counted, and later real turns
count as Codex usage in the ChatGPT desktop app and give their folder a genuine Desktop origin.
