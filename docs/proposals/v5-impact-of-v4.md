# v5 plans measured against the v4 decisions

This review checks every v5 plan against the v4 decisions of 2026-10-01. It is an input to v5.0.0
planning and creates no v5 commitment. It was compiled on 2026-10-01 by a read-only review of the
sources in the [v5 planning sources](v5-planning-sources.md) register.

A second pass is due when 4.0.0 ships: the v5.0.0 card "Re-review v5 plans against v4 as
shipped", blocked by the `4.0.0` release card.

**Citation keys:**

| Key | Source |
| --- | --- |
| DSN | [Project-scoped management only](https://github.com/pacphi/agentic-kit/blob/docs/project-scope-only-design/docs/plans/2026-10-01-project-scope-only-design.md) (the design) |
| GA | The [v4 GA master plan](../plans/2026-10-01-v4-ga-master-plan.md) |
| ME | `meeting-evidence.md` |
| RPT | `report.md` |
| SMD | `shared-management-design.md` |
| SO | `settings-organization.md` |
| SA | `settings-audit.md` |
| PM | `panel-map.md` |
| HO | `hosts.md` |
| TE | `taxonomy-economics.md` |
| EC | `experience-contract.md` |
| RR | `role-experience-review.md` |
| NM | `navigation-memory.md` |
| A56, A57 | The proposed ADR-0056 and ADR-0057 on the taxonomy branch |

ME through NM are files under `docs/research/v5/` on `codex/v5-experience-research`.

Items about issues labelled `needs-review` are out of scope. The v5 sources never cite those
issues, but three topics overlap with them, and those rows say so:

- route intelligence: #109;
- AQE through OpenCode-managed models: #95;
- the mise install classifier: #116.

## Verdicts

Every v5 item gets one of five verdicts:

| Verdict | Meaning |
| --- | --- |
| **Delivered by v4** | v4 already does it |
| **Obsoleted** | A v4 decision makes it unnecessary or wrong |
| **Reshaped** | Still wanted, but it must change to fit v4 |
| **Conflicts** | It contradicts a v4 decision, so the maintainer must decide |
| **Unaffected** | It carries into v5 as it is |

## Summary

There are 183 items.

| Source | Items | Delivered | Obsoleted | Reshaped | Conflicts | Unaffected |
| --- | --- | --- | --- | --- | --- | --- |
| Meeting requirement candidates | 53 | 6 | 4 | 22 | 1 | 20 |
| Design proposals | 91 | 7 | 7 | 48 | 8 | 21 |
| ADR-0056 (delivery metrics) | 15 | 0 | 0 | 7 | 2 | 6 |
| ADR-0057 (taxonomy and lenses) | 13 | 0 | 0 | 5 | 0 | 8 |
| Claude artifacts | 11 | 3 | 0 | 3 | 0 | 5 |
| **Total** | **183** | **16** | **11** | **85** | **11** | **60** |

The 11 conflicts come down to seven decisions, X1–X7 below.

### Where v5 scope shrinks

1. **Machine-wide management is gone.** v5's "Manage" area becomes per-project `init`, `sync` and
   `uninstall`, plus Maintenance writing only inside opted-in roots. That removes:
   - per-machine diffs;
   - installation and profile adoption;
   - host installs and updates;
   - kit self-update;
   - coordination with native updaters.

   Sources: DSN "The rule", "What this replaces", "Commands", "Maintenance".
2. **The v5 settings catalogue and panel map are stale baselines.** Both were built at `847486c`
   (alpha.55), when everything lived in `kit.json`. The real configurable surface is now:
   - `project.json` and `local.json`;
   - a few cache preferences;
   - the Codex exception register.
3. **The "repair trust" slice moves to v4 or disappears.** Most meeting defects either go through
   v4's remediation triage, or vanish with code the redesign deletes:
   - user-level guidance blocks;
   - user-scope MCP migration;
   - the standalone AgentDB install;
   - the Brain installer.
4. **Several v5 designs are already in v4:**
   - the onboarding wizard is the `ak init` conversation;
   - the five management modes are the tool modes (cache, `system`, `project`) plus existing setups
     kept as the user's own;
   - the consequences of opting out are already shown per component;
   - upgrade availability already appears.
5. **v4's P6 delivers the observation foundation:**
   - launching from any folder, with All work as the default;
   - the host facet, places, the coverage card and `ak run` records;
   - the read-only session-source contract;
   - the managed share, the Footprint card, and telemetry v2.
6. **Migration design is obsolete.** v4 ships no migration code (GA Decision 7).
7. **Host scope narrows.** beta.1 and beta.2 cover Claude Code, Codex and OpenCode, plus the Hermes
   adapter contract. v5 keeps the Gemini CLI and Grok Build adapters, and a decision on how deeply
   ak manages hosts (X5).

### Decisions v5 must make

| # | Conflict | Items | What v4 says | Options |
| --- | --- | --- | --- | --- |
| X1 | Scheduled or unattended updates | F01, B3.4f, B6.2, B6.3, B10.8 | ak never edits launchd or systemd; `sync` never self-updates, and only `--upgrade` moves pins; the command gate refuses `launchctl` | Drop schedules; notify only, using the cached version checks; give the user a scheduler line to install themselves that runs `ak sync --all` without moving pins, with a "stage" step that only fills the cache; or add a declared exception |
| X2 | The dashboard writing configuration and running lifecycle | B3.1; also F02, F03, B4.1, B5.1 | The dashboard is read-only for project files, and lifecycle commands are shown ready to copy. The command trim rules out `ak config` and `ak operations` | A product choice, not a breach of the rule: the rule would allow a requested write into an opted-in project, and "Refresh this project" is a precedent |
| X3 | Fleet remote operations | B8.6; also campaigns, signed remote requests, cohorts, canaries | The unit of management is the opted-in project, and no machine-level configuration remains | The fleet observes and produces per-project plans. Plans run only as `ak sync` in projects opted in on that machine. Teams roll out by committing pins in `project.json` |
| X4 | A lasting home for user data that spans places | B10.2; also T03, T04, O05, B9.1, B9.4, B8.5, C56.11 | Writes go only to opted-in project roots, or to a cache that is always safe to delete | Accept cache behaviour plus export and import; amend the rule with a fifth, declared, non-disposable kit data folder; or keep labels only for managed places, in `local.json` |
| X5 | Equal management depth across six hosts | B7.5 | The Codex exception register is closed and coded, and adapters can't extend it; the registry rejects `scope: 'user'` | Observe-only plus the project-level subset; or one coded register per host, by ADR amendment. Hermes keeps configuration in profile homes, and Grok's project config covers only MCP, plugins and permissions |
| X6 | ADR-0056's command surface | C56.8 | The command surface is trimmed, and `setup` becomes `init` | Put delivery opt-in into `init` and the reports into `usage`/`dashboard`; or argue for one new verb |
| X7 | Telemetry contract version collision | C56.10 | ADR-0056 defines "schema version 2" with a `delivery` section, but v4 defines telemetry contract v2 for GA | Delivery becomes v3 after GA; v4's v2 reserves a `delivery: unavailable` section; or v2 defines an extension map for optional named sections. **This one touches v4 before the GA surface freeze** |

Separately, the v5 brief asked for a six-host "Update" axis and nightly host updates. v4
obsoletes both, because host CLIs are detected and explained, never installed. That needs
acknowledging, not deciding.

### What remains as v5 scope

- **The workbench on top of v4's P6 data:**
  - information architecture;
  - roles and attention;
  - shared panels and navigation memory;
  - the panel map, rebuilt at 4.0.0.
- **ADR-0057, rebased on P6:** the metric catalogue, the Usage split and the lenses.
- **ADR-0056:** the Delivery area. Consent is kept in the cache, `gh` is detected and never
  installed, and the export becomes v3, or uses X7's answer.
- **Organisation and money, after X4:** labels, collections, cost bases, allocation and period
  reporting.
- **Fleet and team visibility, after X3 and X4:**
  - a receiver, a roster and freshness, built on telemetry v2;
  - a shared organisation project ID, possibly carried in team-mode `project.json`.
- **New hosts:**
  - Gemini CLI and Grok Build observation adapters, through v4's session-source contract;
  - a capability matrix per metric.
- **Evidence and diagnosis:**
  - the memory chain: configured, invoked, persisted, retrieved;
  - configured versus executed routes, from `ak run` records;
  - a handoff view and a session inspector;
  - a support bundle written to the cache;
  - product-analytics consent;
  - an OTel experiment, and a retention policy.
- **Leftover dashboard behaviour:**
  - handing the terminal back, and reusing a running instance;
  - deriving live sources from managed projects;
  - testing how the browser token behaves.
- **Decisions X1–X7.**

### Items that belong on the v4 board

These are marked **→v4** in the tables and go into the v4.0.0 card inventory:

| Item | What to do in v4 |
| --- | --- |
| D01 | Usage stays empty until the browser is refreshed: triage under Decision 4 |
| D10 | An unexplained terminal fragment: triage under Decision 4 |
| D02 | P5: a test that every command named in advice still exists after the command trim |
| B0.2 | P5 acceptance: never report "all healthy" while warnings are open |
| B0.3 | P6: split the `/api/system` payload |
| D07 | P6: show where and when plan limits were last sampled, now that only the footer in opted-in projects samples them |
| B10.4 | The v4 ADR amends ADR-0014, because the dashboard gains Refresh and Forget writes |
| B7.8 | P3 follow-up: Codex per-profile config files versus the exception register |
| O06 | P6 docs: say the telemetry v2 contract is not OTLP |
| E7 | Apply the Complexity Docket limits to the P6 dashboard work |
| B3.4c | Decide the fate of `ak x harvest`, which the command fold table doesn't mention |
| Superpowers vs. the rUv Stack | Triage its "[BLOCKED]" hook exit-code finding under Decision 4 |

## A. Meeting requirement candidates

The report's M-01 to M-15 map onto these candidates:

- M-01→F02, M-02→D04, M-03→U01/U02, M-04→F01, M-05→D03/D08
- M-06→D05/D06, M-07→T02, M-08→T03/T04, M-09→O08, M-10→T01
- M-11→O03/O04, M-12→F06/D12, M-13→F05, M-14→I01/I02, M-15→O09/U09

### Defects and diagnostics

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| D01 (ME:20) | Usage, History and Models stay empty until the browser is refreshed | Unaffected. P6 rewrites the Usage readers | **→v4** reproduce on alpha.61, then triage under Decision 4 |
| D02 (ME:21) | Advice names a command that doesn't exist (`ak x blocks audit`) | Obsoleted. User-level blocks and the `x` commands are removed | **→v4** P5 test that every advised command exists |
| D03 (ME:22) | Installed Codex and OpenCode show as "unknown" | Reshaped. "Enabled" now comes from `project.json`/`local.json`; the coverage card shows whether a host is installed, readable, and since when | Split installed, authenticated, reachable and verified on top of the coverage card |
| D04 (ME:23) | Warnings persist after repeated syncs | Obsoleted. Their causes are deleted; sync reports edited files instead of overwriting them | **→v4** P5: a per-file result (applied, held or failed) |
| D05 (ME:24) | AgentDB install fails with an overwrite error | Obsoleted. The standalone install is retired, and v4 makes no global installs | None |
| D06 (ME:25) | Brain refuses a fresh install because of a private overlay | Obsoleted. The installer's user mode is unused, and an existing knowledge base is reused | Track the upstream KB-only mode under GA Decision 3a |
| D07 (ME:26) | Claude account and profile data incomplete in Limits | Reshaped. Limits stay account-wide, but samples come only from the footer in opted-in projects | **→v4** show where and when last sampled; v5 multi-account sources |
| D08 (ME:27) | Controls disabled; per-activity routing missing on one machine | Reshaped. Routing is set per project in `project.json`; an empty level gets a one-line note | Routes per managed place, with the reason a control is disabled |
| D09 (ME:28) | Second-tab and Safari token behaviour | Unaffected. Authentication (ADR-0014) is unchanged | Test fresh browsers and multiple instances once launch-anywhere lands |
| D10 (ME:29) | Unexplained "31MX" fragment in terminal output | Unaffected | **→v4** triage with the captured raw output |
| D11 (ME:30) | Hook conflicts forced manual removal | Delivered by v4. No user-level hooks; project hooks are merged with the user's kept, receipted and removable; initializers are staged; Prerequisite C | Preview conflicts and ordering between the user's hooks and ak's |
| D12 (ME:31) | Memory reported configured but not used; cross-host continuation fails | Reshaped. One store per project, through launchers that find their own root; the user-level fallback goes | Per-project memory evidence (see O02) |

### Feature requests

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| F01 (ME:39) | Optional nightly sync or update; defaults by segment; curated release sets | Conflicts (X1). Pins and personal/team defaults are delivered | X1 |
| F02 (ME:40) | One-click fix; repair one thing without refreshing everything | Reshaped. Fixes go only through Maintenance in opted-in roots, user-level fixes are copy-only, lifecycle stays as commands to copy | Per-place fixes; X2 decides whether the dashboard may run `sync` |
| F03 (ME:41) | Control surfaces for non-technical users | Reshaped. Settings are `ak init` choices, and re-running shows the diff | Depends on X2 |
| F04 (ME:42) | Show host, provider and billing mode; warn of metered fallback; spend ceilings | Reshaped. Providers and budgets are per project | Per-project disclosure before a run; account-wide alerts read-only. #95's scope stays out |
| F05 (ME:43) | Grok usage missing; does sync upgrade Grok? | Reshaped. ak never upgrades hosts; Grok comes in through a read-only session-source adapter and the coverage card | A Grok observation adapter |
| F06 (ME:44) | Checkpoint and handoff when switching between Claude and Codex | Unaffected. Both hosts share the project store in v4, but there is no handoff view | A handoff view per managed place |
| F07 (ME:45) | Configured route versus executed route | Reshaped. `ak run` records host, folder, outcome and model | Join `project.json` routes with run records. #109's scope stays out |

### Usability

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| U01 (ME:53) | Dashboard flags are hard to remember | Reshaped. Launch anywhere with no flags, defaulting to All work; `--live-source` is not addressed | Derive Ruflo and AQE live sources from managed projects |
| U02 (ME:54) | The dashboard occupies the terminal | Unaffected. Constraint: no launchd or systemd service | Detach and reuse a running instance without registering a service |
| U03 (ME:55) | What matters now, the next action, a fix-all? | Delivered by v4. The work view's Needs attention card lists each project's rows with the command to run | Critical versus optional tiers |
| U04 (ME:56) | The session view doesn't lead to an action | Unaffected | The session inspector (B8.4) |
| U05 (ME:57) | Easy and expert modes; role landing pages | Reshaped. The default landing is the v4 work view, under the scope filter | Reconcile with A57.6 |
| U06 (ME:58) | First run: where it runs, whether it's user-level, what comes next | Delivered by v4. The `ak init` conversation, with a file plan, default No and a snapshot | None |
| U07 (ME:59) | Evidence drawer, guided diagnosis, support export | Unaffected. v4 supplies the foundations: snapshot age, Managed files, receipts | The drawer and the support bundle (I01) |
| U08 (ME:60) | Discoverability, drilldown, Back, preserved filters | Unaffected. Scope is already addressable through `?project=` | Navigation memory |
| U09 (ME:61) | Less vanity; pinned panels; opt-in feedback | Unaffected | Carry |
| U10 (ME:62) | "claude-flow" versus "Ruflo" naming confusion | Reshaped. The registration name stays `claude-flow`, and a server-to-family tag is added | Copy reads "Ruflo (registered as claude-flow)" |

### Observability and economics

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| O01 (ME:68) | Live and historical session views, and why they matter | Unaffected. Reads stay; the store moves to the cache, and an opted-in badge is added | Carry |
| O02 (ME:69) | Memory configured, invoked, persisted, retrieved | Reshaped. The Footprint card counts ak MCP calls per session, which answers "invoked" | Add persisted and retrieved checks per project |
| O03 (ME:70) | Request-level telemetry; Prometheus or logs | Unaffected. New sources plug into the session-source contract | An experiment |
| O04 (ME:71) | Incomplete Claude session data; proxies | Unaffected. The coverage card shows gaps rather than zeros | A per-host list of missing facts; no proxy interception |
| O05 (ME:72) | Retention and raw-content policy | Reshaped. Derived data lives in the cache, which is safe to delete | X4 |
| O06 (ME:73) | The export is mislabelled as "OpenTelemetry format" | Unaffected. v4's v2 contract is still custom JSON | **→v4** fix the wording in the P6 docs |
| O07 (ME:74) | Separate API-equivalent, reported, billed and allocated cost | Unaffected. v4 adds only the managed share | B9.3 |
| O08 (ME:75) | Client portfolio attribution and billing back | Reshaped. v4's place rows add up to the totals | Labels and allocation over places (X4) |
| O09 (ME:76) | Too much unclassified work | Unaffected | Carry |
| O10 (ME:77) | Classifier and routing-experiment hygiene | Unaffected for classification; the routing part is #109's scope and stays out | Classification only |

### Fleet, teams and grouping

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| T01 (ME:83) | Federation across machines | Reshaped. The fleet builds on telemetry v2, with scope `all` or `managed` | A receiver; X3, X4 |
| T02 (ME:84) | Several harness setups on one machine | Delivered by v4. Per-project pins side by side, team mode pinning `kitVersion`, and `tools: "project"` isolation | Several host config homes (B7.10) |
| T03 (ME:85) | Workspace collections that overlap | Reshaped. A label layer over v4's places | X4 |
| T04 (ME:86) | Inferring which group a session belongs to | Reshaped. v4's place rules are the deterministic base | X4 |
| T05 (ME:87) | Team setup and repeatable onboarding | Delivered by v4. Team mode with a committed `project.json`, and "team project not set up here" | Person and installation identity for the fleet |
| T06 (ME:88) | Economics next to delivered work, without individual rankings | Unaffected | C56.6 |

### Implementation ideas

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| I01 (ME:94) | A local support bundle, previewed before sending | Reshaped. It has to write to the cache, not the current folder; the command trim discourages a new verb | Fold into `ak status`, writing to `cacheDir()` |
| I02 (ME:95) | Opt-in product analytics | Unaffected. A consent preference in the cache is safe, because losing it resets to off | Carry |
| I03 (ME:96) | Reusable care recipes | Reshaped. Recipes run only in opted-in roots, and emit `ak sync --upgrade` | Carry |
| I04 (ME:97) | A thin management kernel shared by the CLI and the UI | Reshaped. Its model is the project state | After P5 |
| I05 (ME:98) | Meeting users inside their host | Reshaped. Only per opted-in project, never at user level | A per-project skill or MCP surface |
| I06 (ME:99) | Scoped cleanup with data-value classes | Delivered by v4. Reclaim is rebased on the tool cache, and user-level cleanup is copy-only | None |
| I07 (ME:100) | Honest adoption metrics | Unaffected. v4 only annotates the trend break | Labels on the admin dashboard |
| I08 (ME:101) | Optional classification and routing experiments | Unaffected for classification; the routing part is #109's scope and stays out | As O10 |

## B. Design proposals

### B0. Trust defects not covered above

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B0.1 (RPT:71) | Legacy MCP migration is advertised, but the writer rejects absolute paths | Obsoleted. Local scope and launchers; no migration code | None |
| B0.2 (RPT:72) | A sync with nothing to do reports "all healthy" | Reshaped. `status` and `sync` are rebuilt on project state | **→v4** P5 acceptance |
| B0.3 (RPT:76) | `/api/system` returns one large payload | Unaffected. P6 rewrites System | **→v4** split it and measure again |

### B1. Product shape, navigation, roles and attention

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B1.0 (RPT:9-11, 96-102) | A local-first workbench plus an optional team service | Reshaped. It observes all work but manages only opted-in projects | Restate the thesis |
| B1.1 (SMD:5-11; RPT:121, 299) | Five areas (Overview, Work, Insights, Manage, History) and "Attention for" | Reshaped. The v4 work view is the landing page and the scope filter is global; Manage shrinks | Redraw from P6; settle the "Insights" name (A57.12) |
| B1.2 (RPT:119; TE:32; EC:15-17) | Scope, view and permission kept separate; this machine, selected machines, whole fleet | Reshaped. Scope is All work, Managed, One place, plus the host facet | Add the fleet as a reserved `?project=` value |
| B1.3 (RPT:110-117; RR:25-51, 93-115; TE:34-41) | Six reader roles and their first screens | Reshaped. The Operator's machine view becomes Health, Needs attention and Versions in use | Reconcile role names with ADR-0057 |
| B1.4 (EC:11-13, 82-94; SMD:7-11) | One identity per panel; an attention contract | Unaffected. v4 panels already declare the levels they support | Add `levels` to the panel descriptor |
| B1.5 (RPT:123-125; EC:141-151) | Inspector, undo, stale states, accessibility | Unaffected | Carry |
| B1.6 (RPT:104) | Workbench, command canvas and fleet cockpit explorations | Unaffected | The fleet cockpit after X3 |
| B1.7 (NM:5-10, 55-93) | A five-visit trail, remembered views, explicit resets | Unaffected. Browser-only, consistent with v4 | Carry |
| B1.8 (NM:109) | Places addressable in the URL | Reshaped. `?project=` already exists | Extend it |
| B1.9 (NM:110) | Drafts and setup progress kept in the control plane | Reshaped. Setup is `ak init`; drafts can live in the cache | Per place, in the cache |
| B1.10 (NM:111-114) | Previews tied to a revision; focus handling; explicit resets | Unaffected. v4's receipt digests support this | Carry |

### B2. Panel migration map (101 groups)

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B2.1 (PM:5-22; SMD:13-29; EC:46-80) | A one-to-one preservation contract | Reshaped. The baseline predates P6 | Rebuild it at the 4.0.0 commit |
| B2.2 (PM:30-32) | Global (3) | Unaffected | Carry |
| B2.3 (PM:33-38) | About (6) | Reshaped. Chips show pinned and cached versions; copy is rewritten for project scope; the deja-vu card goes | Remap |
| B2.4 (PM:39-53, 123) | Overview (16) | Reshaped. The work view replaces Summary and the status map; host state is per project | Map onto the work-view cards |
| B2.5 (PM:54-89, 117-122) | Usage (42) | Reshaped. The scope filter, Places instead of Projects, the Footprint card, the context-tax split | Remap with ADR-0057 |
| B2.6 (PM:90-116, 124-125) | System and Maintenance (29) | Reshaped. Tool-cache rows, read-only Runtime, gated writes | Remap |
| B2.7 (PM:126-130) | Observability (5) | Unaffected | Carry |
| B2.8 | v4 panels missing from the map | Reshaped: add the work-view cards, Managed files, the coverage card, Footprint, Older installation and Forget | Add rows |

### B3. Settings

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B3.1 (RPT:135-157; HO:56; SO:77-81) | Every managed setting editable in both the UI and the CLI; `ak config` and `ak operations` | Conflicts (X2 and the command trim) | X2 |
| B3.2 (SA:7-26; SMD:78-86) | A 330-entry catalogue over `kit.json` defaults | Obsoleted as a baseline: `kit.json` retires | Rebuild from the new schema |
| B3.3 (SO:26-32) | Entry kinds: configuration, run options, observed, setup, unavailable | Unaffected | Carry |
| B3.4a (SO:15) | Category: hosts and installations | Reshaped. Hosts are chosen per project in `init`; installs are only detected; adapter grants live in `local.json` | "Hosts for this project" |
| B3.4b (SO:16) | Category: models, routing and budgets | Reshaped. Routing in `project.json`; providers and budgets in `local.json` | Per-place editors |
| B3.4c (SO:17) | Category: memory and learning | Reshaped. Embeddings consent per project; session recall goes with deja-vu; the Brain knowledge base sits in the cache | Drop recall. **→v4** decide the fate of `ak x harvest` |
| B3.4d (SO:18) | Category: guidance, hooks and permissions | Reshaped. A 1.5 KB project rule plus skills; MCP families chosen in `init` | Project only |
| B3.4e (SO:19) | Category: projects and discovery | Reshaped. Opting in replaces the exact-projects list; roots and exclusions become cache preferences | Shrink |
| B3.4f (SO:20) | Category: updates and schedules | Conflicts (X1) | X1 |
| B3.4g (SO:21) | Category: fleet and sharing | Reshaped. Telemetry v2, with identity kept in the cache | After X3 and X4 |
| B3.4h (SO:22) | Category: data and dashboard | Reshaped. The statusline is per project; retained data lives in the cache | Shrink |
| B3.5 (SO:34-43) | Record editors | Reshaped. The guidance-block record is gone; the rest are per project, `local.json` or the cache | Derive again |
| B3.6 (SO:57-69) | Effective value, owner and scope; machine-bound drafts | Reshaped. The scopes become project, local, Claude local scope, Codex exception and cache. Turning a Codex setting off already restores the original value, through reference counting | Adopt v4's vocabulary |
| B3.7 (SO:77-81; RPT:153) | A versioned settings registry and descriptor | Reshaped. The registry becomes the `project.json`/`local.json` schema | Write it with P5 |

### B4. Onboarding and the management model

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B4.1 (SMD:31-46; EC:121-132; SA:28-34; SO:71-75) | A detect-first, six-step wizard | Delivered by v4: the `ak init` conversation | A browser wizard only if X2 allows it |
| B4.2 (SMD:38; EC:126) | Install more hosts when they're selected | Obsoleted. Hosts are detected and explained, never installed | An install hint only |
| B4.3 (SMD:48-60) | Five management modes | Delivered by v4. The tool modes, existing setups kept as the user's own, and "Yours: ak reads, never changes" | Show the mode per component |
| B4.4 (SMD:62-76; SA:36-50) | Explain what each opt-out means | Delivered by v4, through the per-project checkboxes | Copy only |
| B4.5 (EC:128; SA:32) | The native installer keeps ownership | Delivered by v4. The classifier work is #116's scope and stays out | None |

### B5. Operations and one-click fix

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B5.1 (SMD:88-96; EC:96-109; SA:52-56) | Inspect, preview, apply, verify and history, all in the UI | Reshaped. Only Maintenance, gated to opted-in roots | X2 for anything more |
| B5.2 (RPT:155) | A batch coordinator over single-action plans | Reshaped. Batches only across opted-in roots; `sync --all` already exists | Per-place batches |
| B5.3 (RPT:179; EC:115-117; SMD:96) | Truthful results, rollback per capability, a restart taxonomy | Reshaped. `uninstall` restores the snapshot; `sync --upgrade name@version` rolls a pin back; only this project's daemon is restarted, by receipt | Adopt |
| B5.4 (SMD:94) | ak self-update with a controller restart | Obsoleted. No self-update | None |
| B5.5 (EC:134-139) | Four demonstration flows | Reshaped. Flow 1 is delivered by `init`; flow 2 becomes one place; flow 3 depends on X3; flow 4 is unaffected | Rewrite the flows |

### B6. Updates and scheduling

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B6.1 (RPT:163; HO:75) | An update model: targets, resources, version, timing, rollout | Reshaped. Targets are opted-in projects, resources are pins, and versions move through `sync --upgrade` | Timing is X1 |
| B6.2 (RPT:165-171) | Policies: Manual, Notify, Stage, Managed care, Team rollout | Conflicts (X1). Manual is delivered; Notify works from cached checks; Stage could fill the cache ahead of time; Team rollout is a `project.json` pull request | X1 |
| B6.3 (RPT:173-177; SMD:102; SA:58-62; EC:119) | A scheduler, off by default, through launchd, systemd or Task Scheduler | Conflicts (X1) | X1 |
| B6.4 (SMD:100) | Upgrade availability in the Components view | Delivered by v4: the Versions in use card and the pinned/cached chip | Add candidate and hold |
| B6.5 (SMD:104; RPT:175) | One update owner; coordinate with native auto-updaters | Obsoleted | Report read-only |
| B6.6 (HO:59, 73-81) | Updating host binaries | Obsoleted. Hosts are detected and explained, never installed | Acknowledge that the brief's Update axis is dropped |

### B7. Hosts

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B7.1 (RPT:183-190; HO:30-33) | Claude Code, Codex and OpenCode | Delivered by v4, in beta.1 and beta.2 | None |
| B7.2 (HO:32, 68) | Hermes | Reshaped. An external adapter, with declared write roots and a read-only session source | How deeply to manage it (X5) |
| B7.3 (HO:34, 70) | Gemini CLI | Reshaped. Its project settings fit the projection model; observation through an adapter | A v5 adapter |
| B7.4 (HO:35, 71; ME:43) | Grok Build | Reshaped. Only the project subset (MCP, plugins, permissions); observation through an adapter | A v5 adapter; X5 for anything more |
| B7.5 (RPT:198; HO:7, 50-62) | Equal quality across six hosts (Manage, Run, Observe, Update) | Conflicts (X5). The Update axis is obsoleted | X5 |
| B7.6 (RPT:194; HO:37-48, 87) | Host versus provider versus payer; native authentication | Unaffected | #95's scope stays out |
| B7.7 (RPT:196; HO:60-62) | A parity and conformance suite | Reshaped. Add v4's "HOME unchanged" and write-root conformance tests | Extend the tests |
| B7.8 (HO:31, 67) | Codex per-profile config files | Reshaped. The register writes only `config.toml` | **→v4** P3 follow-up |
| B7.9 (HO:71) | Grok also discovers Claude hooks, so a hook can fire twice | Unaffected, but newly relevant now that ak writes project Claude hooks | The v5 adapter must remove duplicates; verify |
| B7.10 (RPT:159; HO:54) | Installation and profile identity; alternate host homes | Reshaped. Identity is observation only | Find alternate host homes in the census |

### B8. Observation, telemetry and fleet

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B8.1 (RPT:225-227) | Native adapters with provenance; "not observed" as an answer | Reshaped. v4's session-source contract, coverage card and `ak run` records | Extend the contract fields |
| B8.2 (RPT:227; TE:100-102) | An OTel GenAI mapping | Unaffected | An experiment under its own ADR |
| B8.3 (RPT:229) | An optional API gateway the user controls | Reshaped. ak can't set user-level environment, so this becomes copy-only advice | Advice only |
| B8.4 (RPT:231; TE:104) | Session inspector | Unaffected | Carry |
| B8.5 (RPT:233; TE:84-90) | Roster, enrollment, freshness | Reshaped. Built on telemetry v2 | X4 for credentials |
| B8.6 (RPT:235; SMD:92; EC:111-115) | Remote control, fleet campaigns, canaries | Conflicts (X3) | X3 |
| B8.7 (RPT:237) | A Ruflo federation prototype | Unaffected | Carry |
| B8.8 (TE:92, 96) | Aggregation rules; team privacy | Unaffected. v4's exports never carry paths | Carry |

### B9. Labels and economics

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B9.1 (RPT:202-204; TE:49-55) | A labels and collections layer | Reshaped. Built over v4's places | X4 |
| B9.2 (RPT:206-208; TE:57-59, 65) | Count distinct sessions first; allocation with an Unallocated bucket | Unaffected. Complements v4's place rows that add up to the total | Carry |
| B9.3 (RPT:210-217; TE:67-82) | Four cost bases | Unaffected | Carry |
| B9.4 (RPT:219-221; TE:61) | Labels as of a date; closing a period | Reshaped. Needs durable history | X4 |
| B9.5 (TE:22, 55) | A shared organisation project mapping | Reshaped. Team-mode `project.json` could carry the project ID | Consider |

### B10. Architecture, migration and release plan

| ID | Item | Verdict and basis | Next |
| --- | --- | --- | --- |
| B10.1 (RPT:258-269) | Bounded contexts and contracts | Reshaped. Identity is the project marker and the place; Scheduling is X1 | Revise the contract table |
| B10.2 (RPT:271) | A durable state store | Conflicts (X4) | X4 |
| B10.3 (RPT:273) | Additive migration and legacy aliases | Obsoleted. No migration code | None |
| B10.4 (RPT:84, 92, 275) | Reconcile ADR-0014, ADR-0054 and ADR-0058 | Reshaped. v4 adds dashboard writes (Refresh, Forget) | **→v4** amend them in the v4 ADR |
| B10.5 (RPT:281) | Slice 0: repair trust | Delivered by v4, through the remediation triage and P5/P7 | Leftovers go to the →v4 list |
| B10.6 (RPT:282) | Slice 1: shared foundations | Reshaped | Re-scope around place identity |
| B10.7 (RPT:283) | Slice 2: the first complete experience | Reshaped. Launching without flags is delivered | Re-scope |
| B10.8 (RPT:284) | Slice 3: managed care | Conflicts (X1). Fine-grained selection and pins are delivered | X1 |
| B10.9 (RPT:285) | Slice 4: six hosts | Reshaped. v4 covers three hosts plus the Hermes contract | Gemini CLI and Grok Build |
| B10.10 (RPT:286) | Slice 5: team visibility | Reshaped. Team mode is in v4 | A receiver after X3 and X4 |
| B10.11 (RPT:287) | Slice 6: outcomes and financial evidence | Unaffected | Carry |
| B10.12 (RPT:289) | The v5.0 commitment: slices 0 to 5 | Reshaped | Cut again |
| B10.13 (RPT:291) | The first demonstration | Reshaped. Two opted-in projects with different pins; edits through `init`; scheduling is X1 | Rewrite |
| B10.14 (RPT:293) | Performance targets | Unaffected. v4's per-project status snapshots help | Benchmark against places |
| B10.15 (RPT:295) | Usability study | Unaffected | Replace the "set an update policy" task |
| B10.16 | Move the research to `docs/proposals/v5/` | Unaffected (housekeeping) | On merge |

## C. ADR-0056 (delivery outcome metrics; Proposed)

| ID | Decision | Verdict and basis | Next |
| --- | --- | --- | --- |
| C56.1 (A56:53-68) | Two opt-in consent tiers, chosen in `setup`, kept in `kit.json` | Reshaped. `setup` and `kit.json` are gone. Reading any repository is observation, so it is allowed. Consent becomes a cache preference (losing it means off), and per-project exclusions go in `local.json` | Rewrite |
| C56.2 (A56:70-84) | Which repositories, plus branch and author rules | Reshaped. Only repository places apply; other kinds read "not applicable"; it follows the scope filter | Add the managed share |
| C56.3 (A56:86-101) | Local metrics | Unaffected; relabel the heuristics (TE:108) | Carry |
| C56.4 (A56:103-131) | Exclusions | Unaffected. v4 adds `.agentic-kit` to the excluded folders | Note it |
| C56.5 (A56:133-162) | A GitHub tier through `gh`, installed after confirmation | Reshaped. Installing is obsoleted: `gh` is detected, never installed | Add `gh` to the status Prerequisites |
| C56.6 (A56:164-170) | Effort next to output | Unaffected | Add caveats about association |
| C56.7 (A56:172-189) | Delivery as its own area | Reshaped. It follows the scope filter, and its Setup view writes only to the cache | After P6 |
| C56.8 (A56:190-196) | `ak delivery` commands and `setup` flags | Conflicts (X6) | X6 |
| C56.9 (A56:197-198) | A recap card | Unaffected | Carry |
| C56.10 (A56:200-224) | Telemetry "schema version 2" | Conflicts (X7) | X7 |
| C56.11 (A56:226-248) | A shared fleet key; taking the maximum across clones | Reshaped. The key needs storage (X4); replace the maximum with event references (TE:94) | After X4 |
| C56.12 (A56:250-257, 283-284) | Amendments to ADR-0054 | Reshaped | Rebase on v4's v2 |
| C56.13 (A56:259-275) | Alternatives, including a separate cache module | Unaffected; it lives under `cacheDir()` | Carry |
| C56.14 (A56:312-319) | Phasing | Reshaped. After GA; phase 3 becomes v3 | Sequence again |
| C56.15 (A56:321-328) | Open questions | Unaffected (command names belong to X6) | Carry |

## D. ADR-0057 (dashboard taxonomy, role lenses, metric catalogue; Proposed)

| ID | Decision | Verdict and basis | Next |
| --- | --- | --- | --- |
| A57.1 (A57:74-80) | Organise by question, not by role | Unaffected | Carry |
| A57.2 (A57:82-102) | Domains, an evidence grade, a scope axis | Reshaped. The scope vocabulary becomes session, place, managed, all work and fleet | Update the vocabulary |
| A57.3 (A57:104-107) | Delivery as a primary area | Unaffected | See C56.7 |
| A57.4 (A57:108-125) | Score renamed Summary; split into Spend and Practice | Reshaped. Projects becomes Places, and the Footprint card needs a home | Remap after P6 |
| A57.5 (A57:127-135) | The other Usage views unchanged; a grouped second row | Unaffected | Carry |
| A57.6 (A57:137-160) | Role lenses | Reshaped. Everyone and the Operator land on the v4 work view; a lens never changes the scope filter; keeping the lens in the browser is fine | Revise the lens table |
| A57.7 (A57:162-178) | One metric catalogue | Unaffected | Include the P6 metrics |
| A57.8 (A57:180-186) | Vocabulary | Unaffected | Carry |
| A57.9 (A57:188-200) | "What leaves this machine" | Reshaped. Add v4's network traffic: npm installs into the tool cache, the Brain knowledge-base download, and the staged initializers | Inventory again |
| A57.10 (A57:202-216) | A redirect for `#usage/score` and an alias for `ak usage score` | Unaffected; the `usage` command stays | Carry |
| A57.11 (A57:218-229) | Order of work | Reshaped. Start after P6, to avoid churning the same views twice | Sequence again |
| A57.12 (A57:241-242) | Rejects an "Insights" area | Unaffected by v4, but it contradicts v5's own "Insights" area (SMD:7) | Resolve within v5 |
| A57.13 (A57:280-290) | Open questions | Unaffected; keeping lenses across browsers touches X4 | Carry |

## E. Claude artifacts

| Artifact | Idea | Verdict and basis | Next |
| --- | --- | --- | --- |
| Delivery Scorecard | Two-tier opt-in; "unknown is not zero"; keyed-hash export | Reshaped, as C56.1 and C56.10 | Follow the ADR-0056 rows |
| Scorecard Additions | The stat-tile contract; a host-coverage line on each panel | Unaffected; it can reuse the coverage-card data | Carry |
| Dashboard Lenses | Domains, evidence and scope axes, lenses | Reshaped, as A57.2 and A57.6 | Reconcile the role names |
| Metric Evidence Matrix | Per-host coverage for each metric | Reshaped. v4 delivers coverage per host | Cite it in v5, and extend it per metric |
| Room for More Hosts | One registry; capabilities earned through conformance; honest gaps | Delivered by v4 | None |
| Adapter Contract Dossier | Adapters as data plus approved subprocess hooks | Delivered by v4 (P3) | None |
| Complexity Docket | Engineering limits for a bigger dashboard | Unaffected | **→v4** apply them to P6 |
| Prompts Explorer Directions | Prompt text hidden by default; a coaching ledger | Unaffected; the ledger lives in the cache | Carry |
| Superpowers vs. the rUv Stack | Installed versus active; context cost per layer | Delivered by v4. Superpowers guidance appears only with evidence, and always-on guidance drops from about 10.5 KB to 1.5 KB | **→v4** triage its "[BLOCKED]" finding under Decision 4 |
| Paddling Upstream | A six-host hook and consent table | Unaffected (v4 covers three hosts) | Carry |
| One Brain, Every Assistant | Connector status per assistant | Unaffected (context only) | None |
