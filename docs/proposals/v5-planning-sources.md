# v5 planning sources

Collected on 2026-10-01 as input for the **v5.0.0** board. This register records where the v5
thinking lives and what each source contributes. It is not a v5 decision. Nothing here is
accepted architecture, and every mockup uses illustrative data.

Read the sources against two later facts:

1. **Project-scoped management.** The
   [project-scoped management design](../plans/2026-10-01-project-scope-only-design.md) (accepted
   2026-10-01) postdates all of these sources. The v5 mockups assume machine-wide management:
   machine scope, nightly updates, user-level registration. Each idea has to be re-read against
   project-only management with all work observed.
2. **The `needs-review` label.** Issues labelled `needs-review` are excluded from v5 planning, as
   they are from every board.

## 1. Research snapshot (`codex/v5-experience-research`)

**Where it is.** Branch
[`codex/v5-experience-research`](https://github.com/pacphi/agentic-kit/tree/c95315948c59aec10b75383d4ed5de4024487f98/docs/research/v5),
at `c953159`. It holds two commits from 2026-09-25: "capture research and dashboard mockups" and
"navigation memory for the management workbench". The folder has 30 files, and its
`manifest.json` lists every one with a SHA-256.

**Before it can merge.** The branch is behind `main`, and it predates the docs reorganization:
`docs/research/` is no longer an allowed folder. Bringing it to `main` means moving it to
`docs/proposals/v5/`.

**Documents:**

| Document | What it holds |
| --- | --- |
| `README.md` | Start page, the mockup evolution table and a traceability index |
| `report.md`, `report.html` | The full cited report: meeting findings, implementation comparison, host compatibility, economics, architecture and delivery recommendations |
| `meeting-evidence.md`, `attention.json` | 53 requirement candidates (defects D01–D12, feature requests F01 onward), each with a certainty label and a citation into the meeting transcripts |
| `implementation-audit.md` | The implementation and defects at `847486c`, with source evidence |
| `hosts.md` | Claude, Codex, Hermes, OpenCode, Gemini CLI and Grok interoperability research |
| `taxonomy-economics.md` | Comparison with the taxonomy branch, labels, cost bases and fleet semantics |
| `panel-map.md`, `panels.json` | One destination for each of 101 existing panel or capability groups |
| `settings-audit.md`, `settings-organization.md`, `settings.json`, `settings-taxonomy.json` | 330 settings, eight purpose categories, and the ownership and scope distinctions |
| `lifecycle.json`, `packaging.md` | Lifecycle ownership and packaging notes |
| `shared-management-design.md`, `experience-contract.md`, `role-experience-review.md` | Design rationale, shared panels and attention, and the role reviews (each marks what later work superseded) |
| `navigation-memory.md` | The deep-jump audit and the five-visit Back/Forward trail |
| `verification.md` | The checks performed (64 browser scenarios) and the prototype's stated limits |

**Mockups.** These are self-contained HTML with embedded SVG. Clone the branch to run them;
GitHub shows only the source.

| Iteration | Standalone preview | Status in the research |
| --- | --- | --- |
| Initial v5 concept | `previews/agentic-kit-v5-concept.html` | Historical |
| Role compositions | `previews/role-workbench.html` | Historical. Separate role navigation was superseded |
| Shared management and onboarding | `previews/management-workbench-before-grouping.html` | Historical |
| Shared workbench with grouped settings and navigation memory | `previews/management-workbench.html` | Latest concept |

The editable fragments sit beside the previews in the same folder, without the `previews/`
prefix.

## 2. Proposed ADRs (`docs/dashboard-taxonomy-delivery-metrics`)

Branch
[`docs/dashboard-taxonomy-delivery-metrics`](https://github.com/pacphi/agentic-kit/tree/7b9093ef3e6d4c0efb9453ee5e48532a2064e612),
at `7b9093e` (2026-09-25). The v5 research names it as its taxonomy source.

| File | Status |
| --- | --- |
| `docs/adr/0056-delivery-outcome-metrics.md` | Proposed |
| `docs/adr/0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md` | Proposed (dated 2026-09-21) |
| `docs/research/ruvnet-brain-agentic-kit-comparison-2026-09-20.md` | Research |
| `explainer.html` | Reworked explainer |

ADR numbers 0056 and 0057 are still unused on `main`, so they remain reserved for these
proposals.

## 3. Claude artifacts

Thirteen of your claude.ai artifacts were reviewed on 2026-10-01. The v5 research already cites
the first three, as UX1–UX3. Private artifacts open only for their owner.

| Artifact | Updated | Kind | Relevance | What v5 planning should carry forward |
| --- | --- | --- | --- | --- |
| [Delivery Scorecard](https://claude.ai/artifact/V9Pk6Mj7VEe5SELXCUoLat) | 2026-09-21 | Interactive HTML and SVG mockup | High | Two-tier delivery opt-in (local git, then the user's own `gh`); "unknown is not zero" pills; effort beside output (cost per merged PR, rework within 48 h); keyed-hash fleet export |
| [Scorecard Additions](https://claude.ai/artifact/7kcwvZZmuzuNfwxNfQM8FT) | 2026-08-28 | Annotated HTML mockup (cited by ADR-0038) | High | The stat-tile contract (value, signed delta, sparkline); honest labels (response latency, API-equivalent cost, medians); a host-coverage line on every panel |
| [Dashboard Lenses](https://claude.ai/artifact/M4UFzPKoTo9NdbR3MQou5g) | 2026-09-21 | Interactive HTML and SVG mockup | High | Eight question domains; evidence and scope axes on every metric; a lens is a landing view, brief and report preset, never access control; its role names differ from the v5 research's and must be reconciled |
| [Metric Evidence Matrix](https://claude.ai/artifact/3nDzuQRDXGzZTLBkeQB8mC) | 2026-08-28 | HTML report (cited by ADR-0038) | High; **not yet cited by the v5 research** | Matrix A: per-host coverage for about 20 metrics. Matrix B: host-specific captures. Adapter fit for Hermes and Gemini CLI; `byProvider` needs a "Not recorded" bucket; OTel would need its own ADR |
| [Room for More Hosts](https://claude.ai/artifact/KAcZ7gQbr5B34mVR1vXsos) | 2026-08-16 | Explainer with SVG (archived as `docs/archive/2026-08-16-artifact-host-extensibility-explainer.html`) | High | One host registry; leading versus supervised hosts; capabilities earned through conformance tiers; honest gaps for Hermes and Gemini CLI |
| [Adapter Contract Dossier](https://claude.ai/artifact/TSBiKmxwuygtk1D8f4NiQU) | 2026-08-15 | Report with SVG (archived as `docs/archive/2026-08-14-artifact-adapter-contract-dossier.html`) | Medium | Adapters are data plus approved subprocess hooks; a vocabulary for how a host is driven; describe hosts by what they can do, not by tier names |
| [Agentic-Kit Complexity Docket](https://claude.ai/artifact/DCYzAztLUYTyYWRji9XPn2) | 2026-08-27 | Review report | Medium | The engineering limits a bigger dashboard must fit: complexity lint at 50, the UI suite in CI, one shared decode layer, a registry pattern for panels |
| [Prompts Explorer Directions](https://claude.ai/artifact/RyV8z82asrtaZ8k3cfiMic) | 2026-08-31 | Interactive mockup | Medium | Prompt text hidden by default; coaching grouped by fix, with a ledger of adopted and dismissed fixes; a host interplay panel with an unequal-window caveat |
| [Superpowers vs. the rUv Stack](https://claude.ai/artifact/9LH8eVHqabw2pxn6sunk7D) | 2026-09-28 | Scrollytelling audit | Medium | Installed versus active; fixed context cost per layer before the first prompt; describes, instructs or enforces; the "[BLOCKED]" exit-code finding |
| [Paddling Upstream](https://claude.ai/artifact/RtwXsztmgYHXu2smHgvcqU) | 2026-09-30 | Scrollytelling explainer | Low | The six-host hook and consent table; designed, fixture and real evidence badges |
| [One Brain, Every Assistant](https://claude.ai/artifact/6eiVn5ic8wVy71vpy5ZGcQ) | 2026-09-23 | Personal field guide | Low | September 2026 connector status per assistant |

Reviewed and not relevant: *Progressive Reveal Audit* (a personal-site UX audit) and *Skill
library audit* (account skills, none from the rUv stack).

Referenced by these artifacts but not reviewed:

- the "Host & Provider Consistency — agentic-kit" artifact, which the Dossier names as its master
  document;
- the three Riverwright specs that *Paddling Upstream* refers to.

## 4. Meeting transcripts

The v5 research's requirements come from two meetings. The links are private Granola notes.

- **Stuart discussion**, 2026-09-24 —
  [Granola](https://notes.granola.ai/d/d513ea2e-3b15-48a9-b08e-42c78e627532).
- **Hackerspace / Agentics Foundation discussion**, 2026-09-25 —
  [Granola](https://notes.granola.ai/d/6416b991-34b4-428c-85bb-951c5e0442d4).

`meeting-evidence.md` cites them by turn number. It also explains which turns are excluded, and
why a demonstration report is not a reproduced defect.

## 5. Host adapter work set aside from v4

v4 retires the experimental external host-adapter contract and its Hermes integration
([design Decision 10](../plans/2026-10-01-project-scope-only-design.md#setting-host-adapters-aside-for-v5)).
v5 plans first-class support for Grok, Gemini, Hermes, OpenCode, Claude (Code, claude.ai, Desktop)
and ChatGPT/Codex. It should start from this work rather than from nothing.

**Where it is.** At the annotated tag `archive/v4-host-adapters`, which marks the `main` commit the
code was archived at: `6362ee11e689a46e58b7ec8b9e3399f9deb18bea`, tagged on 2026-10-05. The code
also stays on `main` until the P0 removal lands.

| Part | Files |
| --- | --- |
| Commands | `src/commands/x/host-adapters.mjs`, `host-adapters-grants.mjs`, `aqe-provider.mjs` |
| Admission, consent and grants | `src/lib/adapters/{admission,admitted,consent,grants,integrity,manifest,sources}.mjs` |
| Conformance | `src/lib/adapters/conformance.mjs`; `docs/host-adapter-freeze-checklist.md` |
| Execution | `src/lib/adapters/hook-runner.mjs`, `src/lib/adapters/aqe-provider.mjs`, `src/lib/execution/{admitted,adapters}.mjs` |
| Hook audit | `src/lib/hook-audit/providers/external.mjs` |
| Lifecycle | The external entries in `src/lib/adapters/lifecycle-registry.mjs` |
| Tests | `tests/kit/adapter-*.test.mjs`, `admitted-grants`, `conformance-tiers`, `host-adapters-cli` and `live-adapters`; the removal card lists the exact set |
| Decisions | ADR-0029 (extension point) and ADR-0031 (capability graduation), both "Withdrawn from v4; carried to v5" |
| Guides | `docs/hermes-host-adapter.md`, `docs/authoring-host-adapters.md` |
| Community adapter | [`adrianco/ak-adapter-hermes`](https://github.com/adrianco/ak-adapter-hermes), maintained outside this repository |

**Worth carrying into v5:**

- hash-pinned consent;
- fail-closed admission;
- conformance tiers earned by recorded evidence;
- capabilities granted only on that evidence;
- subprocess supervision with timeouts and usage reporting.

**Not carried:**

- the plug-in contract itself;
- the consent and grant stores in `~/.config/agentic-kit`.

## 6. Plans recovered from the maintainer's Mac

A read-only inventory of the maintainer's Mac on 2026-10-01 (master plan Decision 8) found plans
that had never reached GitHub. They are now on `main` (archived or, for the two designs, under
`docs/proposals/v5/`), and section H of the
[supersession ledger](../plans/2026-10-01-v4-supersession-ledger.md) triages them.

| Plan | Where | What v5 should take from it |
| --- | --- | --- |
| Issue #239 closure and the v5 foundation | `docs/archive/2026-09-29-plan-issue-239-closure-and-v5-foundation.md` | The #239 acceptance map (§6), reused as the mapping comment on #239; the read-only probe results (§3); declared provider versus observed model (D-28). Its D-20, which moved four #239 items out of v5, waits on a decision |
| Execution evidence and upgrade acceptance | `docs/archive/2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md` | The execution evidence contract (E1), the fault-injection worker (E2), and cancellation states and fencing (D-22, D-23). The upgraded-install matrix is superseded |
| Session organization, meaningful titles and Activity classification | `docs/proposals/v5/2026-09-30-session-organization-and-activity-design.md` | One Sessions catalog, titles, and Activity gates (unknown Activity under 10%, accuracy of at least 95%). It must sit on the v4 dashboard's places and rebase on its "Places" naming. Its retention choice waits on conflict X4, and its "admitted external host" wording predates the v4 adapter retirement |
| Conversation Activity and Topic taxonomy | `docs/proposals/v5/2026-09-30-conversation-activity-and-topic-taxonomy-design.md` | Broad Activity families plus a separate Topic hierarchy, including consumer chats. It depends on v5's claude.ai and ChatGPT support |

The inventory also found two maintenance-overhaul files from 2026-09-06 to 09-09
(`progressive-inventory.html` and `option-a-validation.md`) that were never committed and no
longer exist anywhere.

## 7. Gaps

These sources could not be reached on 2026-10-01:

- **ChatGPT conversations**, including any HTML or SVG mockups that exist only in ChatGPT. They are
  not reachable from a Claude session.
- **Google Drive** returned nothing relevant.

Local Codex and Claude Code session transcripts on the Mac were searched on 2026-10-01 (section 6).
Their v5 mockups are earlier drafts of what is on `codex/v5-experience-research`.

The `codex/v5-experience-research` branch holds the Codex-produced research and mockups that were
committed. Anything that exists only in ChatGPT or in local transcripts needs to be exported and
added to that branch, or linked here, before v5 planning can use it.
