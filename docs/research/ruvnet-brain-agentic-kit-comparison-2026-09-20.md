# RuvNet Brain and agentic-kit: comparative source study and integration proposal

**Research date:** 20 September 2026. **Status:** proposal; no product implementation authorized or performed.

## Abstract

RuvNet Brain and agentic-kit now overlap materially in installation inspection, configuration, recommendations, maintenance, host integration, and execution support. This is no longer adequately described as a knowledge plugin beside a setup utility. Nevertheless, the inspected implementations support different centers of responsibility. Brain combines source retrieval with behavioral controls, learning visibility, corpus management, and a local console. Agentic-kit combines cross-host configuration, supervised execution, resource inventory, and maintenance transactions. The recommended direction is **federation with explicit ownership**: adopt Brain's strongest explanatory and evidence-presentation patterns; consume bounded Brain observations; delegate Brain-specific controls to their native owner; retain agentic-kit's execution and maintenance authority. Claims of uniqueness below are relative to the two inspected implementations, not the entire market.

## 1. Research questions and method

This study answers four questions:

1. What does the latest published Brain actually expose through its console?
2. How much of its host information is installation evidence, configuration evidence, authentication evidence, or runtime proof?
3. Which capabilities duplicate agentic-kit, and which remain differentiated?
4. What integration would improve the user's experience without creating competing configuration writers?

The method is a comparative source case study: release identification; retrieval-assisted discovery; inspection of executable producers, consumers, and tests; selected executable checks; and explicit separation of observations, inferences, and proposals. Source and test behavior outrank README descriptions and ADR intent. No numeric product score is assigned: the selected checks do not establish a statistically meaningful overall quality ranking.

### 1.1 Version and sampling boundary

| Object | Identity observed | Interpretation |
| --- | --- | --- |
| Brain npm `latest` | `4.3.26` | Queried live on the research date |
| Brain GitHub latest release | `v4.3.26`, published `2026-09-18T11:45:42Z` | Published comparison baseline |
| Brain tag source | `3996f502b18157fdc84e325fbe87c2a05351d58c` | Read-only checkout inspected |
| Brain `main` | `231c565640110e6cfe2a06892a4475a95fc742d5` | Six commits ahead of the tag |
| agentic-kit checkout | `4.0.0-alpha.50`, `ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c` | Local source baseline; initially clean |
| Brain retrieval corpus | Reported 3.8 days old | Discovery aid, not authority for latest-version claims |

The six post-release commits concern issue-watch scheduling, Cognitum capability disclosure, source-sidecar retirement, and corpus/runtime qualification metadata. The compare response lists no changes to the principal console, settings, host-registry, or subscription-host modules studied here. Findings are nevertheless explicitly about the release tag. Matching npm and GitHub version labels does **not** prove identical artifact bytes. The npm archive and downloaded knowledge bundle were not independently qualified. [R1–R3]

### 1.2 Evidence classes and limitations

**Observed implementation** means source was inspected. **Executed check** means a bounded assertion or test ran during this study. **Inference** means an interpretation of those observations. **Proposal** means future work.

No live console was launched, no browser usability study was conducted, no settings were changed, and no provider inference request was made. This is therefore a source-grounded functional and architectural comparison, not a certification of installed-machine health, accessibility, performance, or all-platform behavior. Project memory search returned low-value command records and contributed no capability evidence. Absence claims are restricted to the inspected surfaces.

## 2. What Brain's console now does

### 2.1 A substantial operational surface

The actual console groups controls and information around inventory, enabled capabilities, suggestions, learning, activity, memory, routing, guardrails, and provenance. Its server exposes separate read models for state, capabilities, memory, stack, activity, lessons, trust, and corpus scope. Mutation endpoints cover applying remedies, saving configuration, changing advocacy preferences, power/profile controls, refresh, undo, and lesson changes. These are implemented routes, not merely mockups. [B1–B2]

A particularly valuable design is that a recommendation requires observed evidence, a cost, a describable change, and an undo description. Machine-affecting recommendations additionally require a plain-language impact statement. The recommendation constructor enforces those fields. This establishes an explanatory contract; it does not, by itself, prove that the inverse is safe or complete. [B3]

The server uses project-scoped caches for state, capabilities, and memory, while the stack cache is machine-scoped. It attaches freshness information and has a 15-minute maximum-age policy. Runtime receipts distinguish console generation and scope; an identity endpoint supports checking which runtime is listening. These are useful patterns for preventing stale or wrong-project information from appearing authoritative. They also mean that “live console” should not be interpreted as “every displayed fact was just reprobed.” [B1, B4]

### 2.2 Controls and configurability

| Control | Source-observed semantics | Integration implication |
| --- | --- | --- |
| Brain power | A persistent `brain-off` sentinel is authoritative; the settings boolean is a mirror. The console reports disagreement. | Read the effective state through Brain; do not implement another power flag. |
| Corpus profile | Complete Brain versus RuVector-only; reports installed stores/bytes and available restoration path. | Surface storage and coverage consequences before changing profile. |
| Learning scope | `off`, `project`, `user`; default `project`. | Cross-project learning is a distinct data-flow decision. |
| Advocacy | Levels 1–5, default 3; controls unsolicited advocacy/promotion, with failure alarms and named-lesson controls separate. | A verbosity control must not silently become an authorization control. |
| Automatic remedies | Default off; eligible console remedies are filtered to project scope and explicit remedy eligibility. | Do not interpret it as permission for agentic-kit maintenance. |
| New-project defaults | Opt-in seeding of selected preferences into a project file; existing initialization is preserved. | Show inherited versus project-overridden values. |
| Provider, routing, QE preference | Console configuration plus a runtime preference layer; selected project values override user values. | Avoid a second, contradictory provider/routing preference in agentic-kit. |
| Nightly refresh | Separates saved choice, scheduler enforcement, and last-run evidence. | Best candidate for a general evidence-presentation pattern. |
| OpenRouter credential | Environment support; new console storage uses SOPS+age, with read-only compatibility for legacy plaintext configuration. | Consume credential availability, never copy secrets into inventory. |
| Managed-memory boundary | Schema/runtime support for `advise`, `read-only`, `block`; default `advise`. | Configuration support is not proof that a corresponding console widget is exposed. |

Sources: settings schema, runtime preferences, console handlers, and scheduler implementation. [B1, B5–B7]

Two subtleties are important. First, ordinary console user-preference editing explicitly selects four keys: learning scope, advocacy, auto-apply, and new-project defaults; power and profile have separate handlers. The memory-boundary setting exists in the schema/runtime, but it is not in that four-key console list. Second, older comments still describe the scheduler as macOS-only, while executable scheduler code has launchd, cron, and Windows Task Scheduler paths. Current implementation should win over stale explanatory comments; cross-platform correctness remains untested here. [B1, B5–B7]

### 2.3 Knowledge and learning information worth integrating

The installed-corpus read model exposes store name, source repository, source commit, build time, byte size, embedding model, and a private/update-managed indicator. Its scope endpoint derives additional corpus coverage information from installed receipts. This is more useful than a single “Brain installed” badge: it can explain why retrieval cannot answer a question or why disk usage changed. [B1]

The console also has dedicated learning and memory views rather than presenting memory as merely an installed dependency. Agentic-kit should expose concise health/coverage summaries and link to Brain's detailed workflow, while avoiding replication of its learning engine or editable lesson store. This is a proposal based on the relative specialization of the inspected read models. [B1–B2, A3]

## 3. What its installed-host information actually proves

“Host” is overloaded: it can mean the computer, an agent CLI, an inference provider, an installed plugin, or a release-test fixture. Treating these as one entity would produce incorrect conclusions.

| Brain surface | What it observes | What it does not establish |
| --- | --- | --- |
| Console host header | Username, OS platform, Node version, npm prefix, Brain version | Agent-session readiness |
| Wiring survey | Project Claude settings/local settings and `.mcp.json`; user Claude hooks and enabled plugins | Complete Codex/OpenCode configuration or actual hook execution |
| Stack inventory | Relevant npm-global packages, Claude plugin installation records, scoped instances, npx shadows | Which highest-version copy actually wins in every running session |
| Provider/subscription detection | Credential-file/keychain presence and selected environment-variable presence | Valid entitlement, remaining quota, or successful inference |
| Subscription deliberation probes | Native Claude auth status and Codex login status, with stricter subscription classification | Unlimited capacity or successful completion of a future task |
| Host registry | Tracked Claude/Codex adapter descriptors, modes, supported OS vocabulary, digest | Installed-machine inventory; these are product descriptors |
| Host-install matrix | Machinery for isolated Claude-only, Codex-only, and dual installations and checks | That every release or this user's installation passed those checks |

Sources: console producers, stack-sync, subscription-hosts, host-registry, and host-install-matrix. [B1, B8–B11]

### 3.1 A material discrepancy: subscription display versus execution eligibility

The console's `detectSubscriptions()` marks Claude subscription presence from a credentials file or keychain entry. It marks OpenAI/Codex presence from selected auth-file fields. It also treats the existence of Google application-default credentials as a subscription signal. Those are credential observations; they are insufficient on their own to establish paid-plan entitlement. [B1, `detectSubscriptions`, lines 2192–2240]

The separate subscription execution helper is more discriminating: Claude must report a first-party `claude.ai` login and a nonempty subscription type; Codex must report “Logged in using ChatGPT.” It removes a defined list of provider billing environment variables before child execution. These source distinctions are real, but environment filtering is not a universal proof against every possible billing configuration. [B9]

**Recommendation:** preserve separate fields for credential presence, native authentication classification, entitlement evidence, capacity, and connected inference. Never translate a console `subscription: true` directly into `ready`, `free`, or authorized spending. Agentic-kit already distinguishes local checks from an explicitly requested, expiring provider-inference check; that model should remain authoritative for its own actions. [A1–A2]

### 3.2 Host support is not host inventory parity

Brain has explicit Claude and Codex host adapters and dual-host release fixtures. Its inspected console wiring survey remains oriented toward Claude files. These statements are compatible: first-class plugin support does not imply equal discovery coverage in every console card. Similarly, Brain's `host-registry.mjs` is a validated product registry, not a discovery registry of arbitrary installed hosts. [B1, B10–B11]

This is a reason to integrate facts at their actual scope and evidence level, not to import a blanket “dual-host healthy” result.

## 4. Comparative capabilities

| Domain | Brain 4.3.26 | agentic-kit alpha.50 | Decision |
| --- | --- | --- | --- |
| Source grounding/corpus | Core retrieval, corpus provenance, power/profile controls | Brain lifecycle integration and static selected-plugin inspection | Let Brain own it; improve visibility in kit. |
| Console explanations | Benefit, downside, impact, evidence, remedy, undo | Existing maintenance guidance, preservation boundaries, inspector detail | Borrow consistency of presentation, not a second guidance engine. |
| Installation inventory | Ruv-oriented packages, Claude plugins, wiring and shadows | Resource/placement/artifact/binding/environment model | Keep kit's broader resource model. |
| Host readiness | Console credential observations; stronger separate subscription probes | Installation/config/model/auth checks plus expiring connected proof | Keep kit's separation; import only bounded Brain facts. |
| Native host support | Explicit Claude/Codex descriptors | Claude/Codex/OpenCode execution; external adapter admission model | Keep kit's broader execution coverage. |
| Execution | Specialized subscription-only dual-host deliberation | Bounded dependency graph, host adapters, deadlines, cleanup, escalation, handoffs | Integrate deliberation as a workflow if needed, not a replacement runner. |
| Maintenance | Remedy registry, revalidation, undo journal, stack sync | Exact action identity, expiring plans, provider verification, durable receipts and recovery | Preserve kit's transaction boundary. |
| Learning | Learning scope, lesson controls, activity and memory views | Integration and operational observation | Delegate learning semantics to Brain/owning memory tools. |
| Model visibility | Candidate economics, learned/cold-start router status, routing decisions/receipts | Configured/observed models, alias drift, consumer bindings, lifecycle evidence | Combine summaries; keep meanings distinct. |
| Context visibility | No equivalent established by this console study | Codex catalog/config-derived context and compaction reporting with explicit limits | Retain kit's scoped context reporting. |
| Release provenance | Runtime identity, host registry, install matrices, corpus receipts | Integration-specific version/hook inspection and project operational receipts | Borrow artifact-specific evidence patterns; do not infer execution from registration. |

Sources: [B1–B12, A1–A8]. Rows describe inspected implementation, not exhaustive feature inventories or measured product superiority.

### 4.1 What agentic-kit still does distinctively

**A host-neutral supervised execution contract.** The runner bounds readiness, preparation, launch, and observation against a deadline, coordinates dependency handoffs, blocks failed descendants, and handles cancellation/cleanup. Its escalation logic excludes permission-required outcomes. Brain's dual-host deliberation overlaps in coordinating native hosts, but the inspected implementation is a specialized review workflow rather than the same general execution abstraction. [A4, B12]

**Maintenance authority attached to exact resources.** The current coordinator accepts exactly one action ID per apply request, validates digest/expiry/provider identity, records preimage and verification evidence, and retains recovery states. This is more precise than “has an undo button.” It also means the older ADR's general batch discussion is not the final word on current behavior. [A5–A6]

**A richer operational object model.** Resources, placements, artifacts, consumer bindings, environments, and provenance remain distinct. One package or plugin can have several placements and consumers. That is necessary for questions such as “which project uses this copy?” and “what depends on it?” A version-maximized package summary is insufficient. [A3]

**Model lifecycle and scoped context evidence.** The model read model separates configured and observed state, alias changes, stale sources, and consumer drift. Lifecycle migration requires cited first-party evidence. Context reporting distinguishes configured/catalog-derived values from unverified running-session behavior. [A7–A8]

These are defensible differentiators against the reviewed Brain release. Neither “we have a dashboard” nor “we support Claude and Codex” remains a persuasive differentiator on its own.

## 5. What to borrow—and what not to copy

### 5.1 Priority adoptions

1. **Intent / enforcement / outcome presentation.** Generalize Brain's nightly pattern to kit-managed integrations and scheduled operations. Display disagreement as a finding, not as whichever boolean is easiest to obtain. Build on existing evidence objects rather than replace them. [B1, A1, A3]
2. **Explanatory contracts for controls.** Require owner, scope, benefit, downside, effective value, source, activation/restart condition, and recovery semantics. Kit already has substantial maintenance guidance; the opportunity is consistent coverage across controls. [B3, B5, A6]
3. **A compact Brain subsystem view.** Show installed product/runtime/KB identities separately, corpus freshness/coverage, power state, learning scope, and available native-console navigation. Expose unknowns and disagreements. [B1, B4, A9]
4. **Evidence freshness as a first-class UX property.** Preserve timestamps and project/source identity when consuming Brain facts. Stale evidence must lose action eligibility rather than merely acquire a small warning icon. [B1, A1, A5]
5. **Release-artifact conformance fixtures.** Borrow the principle of testing one-host and dual-host installation modes against the actual candidate artifact, with explicit separation between automated hook execution and interactive user trust. Do not copy fixture bypasses into ordinary installation policy. [B11]

### 5.2 Do not copy these semantics wholesale

**Package repair scope.** `planFor('sync:ruflo')` resolves to `stack-sync.mjs --sync`; it does not pass a package-specific target. That script audits and repairs eligible packages and purges stale shadows across its selected stack. This is a concrete scope mismatch risk for an adapter presenting the action as one-resource maintenance. It is not a claim that an exploit was demonstrated. Kit must either receive an exact-target native operation or present the complete broader plan under a different action contract. [B8, B13]

**“Reversible” as a blanket adjective.** Brain's registry itself marks some database-distillation restoration unavailable and represents cache refill as an automatic rebuild. Reinstalling a previous package version or refilling a cache is not byte-for-byte restoration. Preserve kit's distinctions between reversible, compensating, and irreversible actions. [B13, A5]

**Credential presence as subscription truth.** Retain the qualifications in Section 3. Do not label inferred subscriptions as verified entitlement or guaranteed zero cost. [B1, B9]

**A second scheduler, router, or memory writer.** Brain already has preference consumers and scheduler ownership. Kit should not mirror those settings into independently enforced flags or manipulate Brain's learning database directly. Shared visibility does not imply shared mutation authority. [B6–B7]

**Copying the console server.** Its server module exceeds 3,000 lines, while this repository's standard calls for files under 500 lines. Adopting small contracts and adapters preserves kit's architecture and limits dependency coupling. The upstream source is MIT-licensed; any literal reuse should retain its attribution/license notice. [B1, B14]

## 6. Proposed architecture: federated operations with one owner per control

The intended user experience is one coherent view of the stack, with a visible native owner for specialized actions. Agentic-kit remains responsible for cross-host operations it actually implements. Brain remains responsible for retrieval, corpus/profile changes, learning preferences, its lesson workflow, and its scheduler.

### 6.1 Observation contract

Introduce a versioned, read-only `BrainObservation` adapter. Prefer an upstream-supported JSON export or documented CLI contract. The current `/api/*` routes demonstrate available read models; they should **not** be assumed to be a stable public integration API.

Each imported fact should contain:

- subject and scope: machine, host, project, runtime, or corpus;
- producer identity and version, schema version, capture time, and source identity;
- configured intent, observed effective state, and last successful outcome as separate values;
- evidence class: file/registry, native command, live connection, or execution receipt;
- freshness/expiry, limitations, and any disagreement;
- native owner and permitted navigation/action references, without secrets or arbitrary commands.

Unknown, absent, disabled, unchosen, stale, and contradictory are different states. Existing kit inventory/evidence types should be reused wherever possible. The adapter must reject incompatible schemas and retain sanitized diagnostics instead of manufacturing empty healthy output.

### 6.2 Action ownership

| Operation | Recommended authority |
| --- | --- |
| Inspect Brain versions, corpus, preferences | Brain produces facts; kit validates and displays them |
| Open native Brain console | Kit offers explicit navigation/launch with verified scope/runtime identity |
| Change Brain power, corpus, lessons, learning scope | Brain-native operation; initially use the native console |
| Change kit activity routes or enabled hosts | agentic-kit |
| Repair kit-owned projection | agentic-kit maintenance provider |
| Update shared upstream package | One selected owner, full impact preview, serialized execution, postcondition verification |
| Run provider inference readiness check | Existing kit explicit connected-check contract |
| Repair AgentDB/AQE memory | Owning tool's supported operation; neither inventory layer edits stores ad hoc |

The smallest useful integration is read-only plus native navigation. Direct Brain mutation from kit is a later step, contingent on an exact-target operation, compatible receipts, and a demonstrated verification/recovery contract. No browser-token scraping or private config-file rewriting should be necessary.

### 6.3 Candidate implementation locations

Extend the existing Brain integration around `src/lib/ruvnet-brain.mjs` and `src/lib/ruvnet-brain-plugin.mjs`; add a small observation adapter rather than importing the console. Project its observations through the existing maintenance management/evidence model. Reuse host-readiness concepts for probe strength and expiry, and the dashboard's existing system/maintenance surfaces for navigation. Add a maintenance provider only after the upstream action contract meets the conditions above. These are proposed locations, not edits made by this study. [A1, A3, A5, A9]

## 7. Delivery sequence and evaluation

| Phase | Deliverable | Acceptance evidence | Relative effort |
| --- | --- | --- | --- |
| 0: Contract agreement | ADR defining owners, evidence levels, schema, scope and compatibility policy | Each shared resource has one explicit mutation owner; unresolved upstream contracts listed | Small |
| 1: Read-only integration | Brain observation adapter and subsystem summary/native-console link | Works with absent, disabled, stale, malformed, mismatched, and partial installs; passive reads change no managed settings | Medium |
| 2: Control explanations | Consistent intent/enforcement/outcome and benefit/downside presentation | Users correctly identify what is enabled, what ran, and which scope changes | Medium |
| 3: Optional action bridge | A single bounded Brain-native operation | Exact target, stale-state refusal, serialized ownership, verified result, honest rollback class | Medium–large; upstream-dependent |
| 4: Coexistence qualification | Installed-artifact tests across host shapes and supported OSs | No duplicate hooks/jobs, no lost settings, no cross-project data leakage, correct downgrade/unknown behavior | Large |

Effort is ordinal, not a calendar estimate. A staffing estimate should follow agreement on the export/action contract.

### 7.1 Falsifiable success criteria

**H1—better comprehension:** users identify active state, scope, and corrective action more accurately with the revised view. Evaluate through counterbalanced diagnostic tasks against the current dashboard; report task success, time, incorrect conclusions, and uncertainty intervals. A small formative study can guide design but should not be represented as population-level proof.

**H2—less duplicated configuration:** scripted coexistence scenarios produce no duplicate managed hook or scheduler registration and preserve user-owned settings. Compare before/after manifests and native inspection output, including concurrent-change cases.

**H3—no false readiness inflation:** a credentials file without valid native login, expired connection proof, and a configured but never-run job must not produce a verified-ready label. Use synthetic fixtures and separate connected tests.

**H4—bounded actions:** a supposedly single-resource action cannot alter an additional resource without that scope being represented in its plan. Explicitly test the broad stack-sync case, changed source state, partial failure, and recovery.

**H5—responsive without stale claims:** benchmark cold and warm dashboard reads with many projects, unavailable upstream sources, and old caches. Report latency distributions and stale-evidence handling together; no latency target is claimed as achieved by this study.

A follow-up Agentic-QE assessment can implement the test plan against real artifacts. MetaHarness can separately evaluate harness economics. Neither an automated score nor a source review substitutes for these acceptance results.

## 8. Verification performed and residual uncertainty

Executed against agentic-kit: `node --test tests/kit/host-readiness.test.mjs tests/kit/ruvnet-brain-plugin.test.mjs tests/kit/maintenance-one-action.test.mjs` — **26 passed, 0 failed, 0 skipped**. This supports only the exercised contracts, not full repository coverage.

Executed against the Brain tag: six direct assertions checked non-escalating settings defaults, positive mocked Claude subscription classification, positive mocked Codex ChatGPT classification, negative mocked API-key classification, removal of a fixture billing variable, and the broad `sync:ruflo` argument mapping. **All six passed.** They used mocked inputs and did not authenticate hosts or change settings. Upstream Vitest regression sources for nightly three-fact display and plugin wiring were inspected but not executed.

Residual unknowns include live browser behavior, installed artifact parity, all-platform scheduler behavior, current entitlement/quota, and upstream willingness to stabilize an integration API. These are explicit phase gates, not reasons to defer the read-only proposal.

**Decision requested:** adopt the ownership architecture and authorize a separate Phase 0/1 implementation. The highest-value initial work is a trustworthy Brain subsystem view and consistent evidence semantics—not merging consoles or adding another orchestration engine.

## 9. Follow-up: depth of other-host console controls

**Investigated 20 September 2026 against the same 4.3.26 tag.** The additional choices are not all native execution hosts. The console labels `anthropic`, `openai`, `codex`, `google`, and `xai` as Claude, ChatGPT, Codex, Gemini, and Grok. The implemented depth differs:

| Surface | Verified depth | Limit |
| --- | --- | --- |
| Model-house selector | UI schema → `saveConfig` → persisted config → provider detection/catalog frontier → console economics | Does not install, authenticate, or select a native Gemini/Grok host. |
| Claude/Codex native integration | Host descriptors, separate plugin manifests/hooks, installer paths, native deliberation execution code | Product-level host support does not establish parity in every console panel. |
| Codex routed launch | `codex-routed.sh` consults the router then executes `codex --model` | Explicit wrapper path; no observed console provider-selection wiring into that decision. |
| Gemini/Grok entries | Provider catalog, credential observations, frontier/baseline lookup | No corresponding native host descriptor in the inspected registry; native host launch not established. |
| Cross-provider execution | `route-cheap.mjs` invokes installed agentic-flow with an explicitly selected allowed model and OpenRouter credential | Independent API execution path; selecting a house does not launch it. Its model allowlist is narrower than the provider catalog. |
| Routing/QE switches | Managed CLI boundary checks routing before agentic-flow and QE before selected fleet mutations | Not universal policy over direct CLIs, independently registered tools, or every router wrapper. |

### 9.1 Concrete executable findings

Using the upstream console-child isolation helper and temporary configuration directories, all five named providers passed save-success, persisted-value, runtime-preference-read, and nonempty catalog-frontier assertions. This confirms the settings are functional, not decorative. No real account settings were changed and no provider inference was requested.

A second fixture fixed the router candidate/policy to a synthetic Codex model. With saved provider set first to `google`, then `xai`, and routing set to `off`, the standalone engine still returned that Codex/OpenAI decision both times. Source inspection explains why: `model-router-engine.mjs` reads its own catalog/profile/policy and harness argument, not the console provider/routing preference. This proves a decision-layer separation, not an unauthorized network call. The Codex wrapper calls that engine and launches Codex without consulting the toggle; conversely, `route-cheap.mjs` and the managed CLI interface explicitly check routing enablement. [C1–C4]

The Development table in `console/app.js`, around lines 2146–2157, filters candidates to `harness.includes('claude-code')` and labels the view “you, in Claude Code.” Changing the model house does not change that filter. The inspected installed-router browser test also exercises Claude models, not a Codex/Gemini/Grok host-switching workflow. This is a concrete host-specific presentation limitation. [C5]

The provider setting has a real consumer in the console: `gatherState()` selects a catalog frontier and passes it into utilization calculations. The same setting is not automatically a constraint on the separate candidate/policy engine. Therefore “changes the comparison baseline” and “changes the model that executes my task” must be presented as different effects. [B1, C1, C6]

### 9.2 Architectural status and revised assessment

ADR-013 is **Accepted** and records an implemented console plus a requirement to distinguish working controls from persisted preferences. ADR-015 is **Superseded in part**, dated 15 July and updated 27 July: its former router optimizer was deleted; historical prose about house-specific escalation should not be treated as the current execution contract. ADR-061 remains **Proposed**, updated 11 September, awaiting the second architectural review even though native dual-host execution code exists. Decision acceptance and implemented code are separate axes.

The refined verdict is **functional provider settings and genuine Claude/Codex integration, with incomplete cross-host console parity and separate routing paths**. It would be inaccurate to call all the extra choices fake, or to count every provider chip as a fully integrated agent host. Before borrowing these controls, agentic-kit should require an explicit contract stating whether each choice changes presentation, policy, execution, or all three.

Additional pinned sources:

- [C1: Router decision engine](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/model-router-engine.mjs).
- [C2: Codex launch wrapper](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/codex-routed.sh).
- [C3: Explicit cross-provider execution](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/route-cheap.mjs).
- [C4: Managed CLI preference enforcement](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/plugin/mcp/managed-cli-interface.mjs).
- [C5: Console Development table](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/console/app.js#L2146).
- [C6: Model-house lookup](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/model-catalog.mjs).

## References

All Brain source links below are pinned to the inspected release commit; all agentic-kit links are pinned to the inspected local commit. Online metadata was accessed 20 September 2026.

- [R1: Brain npm latest metadata](https://registry.npmjs.org/ruvnet-brain/latest).
- [R2: Brain v4.3.26 release](https://github.com/stuinfla/ruvnet-brain/releases/tag/v4.3.26).
- [R3: Published tag to observed main comparison](https://github.com/stuinfla/ruvnet-brain/compare/3996f502b18157fdc84e325fbe87c2a05351d58c...231c565640110e6cfe2a06892a4475a95fc742d5).
- [B1: Console server and read/write models](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/onboarding-console.mjs).
- [B2: Console information architecture](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/console/index.html).
- [B3: Recommendation contracts](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/console-engine.mjs).
- [B4: Console runtime identity](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/console-runtime-identity.mjs).
- [B5: User settings schema](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/plugin/scripts/user-settings.mjs).
- [B6: Runtime preference and credential handling](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/plugin/scripts/runtime-preferences.mjs).
- [B7: Cross-platform nightly scheduler](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/plugin/scripts/nightly-scheduler.mjs).
- [B8: Stack inventory and synchronization](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/stack-sync.mjs).
- [B9: Subscription authentication probes](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/subscription-hosts.mjs).
- [B10: Product host registry](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/host-registry.mjs).
- [B11: Host installation verification matrix](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/host-install-matrix.mjs).
- [B12: Dual-host deliberation](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/dual-host-deliberation.mjs).
- [B13: Remedy execution and inverse registry](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/scripts/remedy-registry.mjs).
- [B14: Brain license](https://github.com/stuinfla/ruvnet-brain/blob/3996f502b18157fdc84e325fbe87c2a05351d58c/LICENSE).
- [A1: Host readiness and connected-proof lifetime](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/host-readiness.mjs).
- [A2: Native host setup probes](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/host-readiness-probes.mjs).
- [A3: Management inventory projection](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/maintenance/management/projection-builder.mjs).
- [A4: Supervised execution runner](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/execution/runner.mjs).
- [A5: Maintenance transaction coordinator](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/maintenance/coordinator.mjs).
- [A6: Maintenance guidance admission](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/maintenance/management/guidance.mjs).
- [A7: Model inventory and lifecycle read model](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/model-inventory/read-model.mjs).
- [A8: Scoped context reporting](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/context-report.mjs).
- [A9: Static Brain plugin inspection](https://github.com/pacphi/agentic-kit/blob/ad7c7e77b9332a70f9900c3fee8a85dc1dcc955c/src/lib/ruvnet-brain-plugin.mjs).

Reproduction: fetch the pinned sources, inspect the named producer/consumer functions, query the release/npm metadata afresh, and rerun the three named agentic-kit suites. Historical metadata may change; the commit-pinned source comparison remains reproducible.
