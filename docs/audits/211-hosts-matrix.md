# Issue 211: host, model, setup, and managed-reference audit

Audit date: 2026-09-09. Source baseline: `67fb5c0` (PR #210 squash merge).
Scope: all 29 assigned guide/reference/template Markdown files, read in full; every file
has a disposition below. This is a documentation audit, not a host installation, model
benchmark, entitlement probe, or production release proof. Source evidence was checked
against the baseline and selected contract tests were executed in an isolated worktree.

## Findings

| ID | Finding | Disposition |
| --- | --- | --- |
| H01 | Diagnostic pointed to deleted branch and overstated privacy/current-parser equivalence. | Fix guide; retain legacy code limitation explicitly. |
| H02 | Model guide asserted unsupported turn ratios, task-cost/quality superiority and zero billing from binding. | Remove unsupported advice; route to evidence inventory and dated pricing audit. |
| H03 | Claude native status-line scope and context capability confused with kit collector support. | Correct scope; explain native live data versus historical paired evidence. |
| H04 | Cross-surface drift could never disagree despite separate cache/capture times. | State shared collectors with freshness limits. |
| H05 | General preservation promise hid legacy whole-file router undo. | Document exact off behavior and user-edit loss risk; code follow-up. |
| H06 | Upgrade guide said no version row means repairs safe during sessions; all config session-start-only. | Remove blanket guarantee and describe host-specific reload. |
| H07 | References contradicted default AQE and daemon enablement, and claimed health proves billing. | Match default config/project setup; separate billing evidence. |
| H08 | Hook guide said generated targets cannot be repaired despite released exact-preimage migration. | Document bounded AQE exception and verified Claude profile. |
| H09 | Minimal adapter example implied passing AQE conformance; npm source implied no disk writes. | Distinguish optional hook and temporary tarball staging. |
| H10 | Hermes guide omitted actual TERMINAL_CWD propagation and implied current conformance. | Add dated source inspection; preserve isolation limits. |
| H11 | Upstream incident reports phrased as current system facts. | Label incident inventory by original evidence cutoff. |
| H12 | Local experiment promised safe sharing despite listing paths/private model IDs; stale unresolved catalogue question. | Explain review/redaction and shipped catalogue versus pending experiment. |
| H13 | Proposed MetaHarness upstream facts read as present implementation. | Add current code boundary and dated proposal scope. |
| H14 | Full reference said no LoRA field/healthy security chip/HNSW icon despite current renderer. | Replace with exact source-derived footer semantics and evidence limits. |
| H15 | Token audit inferred human/automation provenance from models, counts, or hours. | Treat those as investigative leads; require independent correlation. |

## Per-file traceability

Paths below are repository-relative. Braces denote the named source modules in one directory.
A test citation identifies relevant contract coverage, not an assertion it was executed unless
listed in Validation. “Retained” means substantive review found no necessary documentation edit.

| File | Implementation and test evidence | Findings | Disposition | Remaining boundary |
| --- | --- | --- | --- | --- |
| `docs/AUTHORING-HOST-ADAPTERS.md` | src/lib/adapters/{manifest,hook-runner,integrity,conformance,sources,aqe-provider}.mjs; tests/kit/adapter-hook-runner.test.mjs | H09 | Corrected minimal-manifest versus AQE-enabled conformance example. | Remote manifests are descriptions, not retained executable bundles; host/provider trials not run. |
| `docs/CODEX-STATUSLINE.md` | src/lib/codex-context.mjs; src/lib/codex-statusline.mjs; tests/kit/codex-statusline.test.mjs | H03 | Corrected native Claude configuration scope; separated live status input from transcript history. | Codex 0.153.4 remains the only source-verified clamp profile; no inference probe run. |
| `docs/CODEX-USAGE-DIAGNOSTIC.md` | scripts/codex-usage-diagnostic.mjs; src/lib/usage-parsers.mjs; tests/kit/usage-index.test.mjs | H01 | Replaced deleted branch download; clarified whole-file local reads and legacy parser/rate limits. | Standalone diagnostic remains old code; current accuracy requires follow-up, not doc assertions. |
| `docs/DEJA-VU.md` | src/lib/deja-vu.mjs; src/lib/adapters/deja-vu.mjs; tests/kit/deja-vu-lifecycle.test.mjs; tests/kit/fixtures/deja-vu/doctor-v2.json | — | Retained: opt-in, schema-2 doctor, separate wiring/index/package ownership and privacy boundaries match integration. | Pinned v0.19.0 contract retained; no history indexing or live package upgrade performed. |
| `docs/HERMES-HOST-ADAPTER.md` | src/lib/adapters/{admission,hook-runner}.mjs; upstream manifest/run hook checked 2026-09-09 | H10 | Dated inspected capabilities and added exact working-directory propagation caveat. | Published upstream conformance is not a local run; no Hermes or provider invoked. |
| `docs/HOOKS.md` | src/lib/hook-audit/{aqe-artifacts,providers/claude}.mjs; src/lib/hook-remediation/aqe-artifacts.mjs; tests/kit/aqe-lifecycle-migration.test.mjs | H08 | Documented reviewed AQE generated-artifact exception and Claude 2.1.266 profile. | Unknown helper preimages and unverified host versions remain non-executable. |
| `docs/HOST-ADAPTER-FREEZE-CHECKLIST.md` | src/lib/adapters/{conformance,grants,admission}.mjs; src/commands/x/host-adapters.mjs | — | Retained unchecked freeze/soak gates and distinction between grant and runtime consumption. | No external-adapter soak or contract freeze claimed. |
| `docs/HOST-SUPPORT.md` | src/lib/adapters/registries.mjs; src/lib/context-report.mjs; src/lib/usage-opencode.mjs; tests/kit/context-report.test.mjs | H03/H11 | Added host context-control/reporting boundary; labeled upstream incident inventory as dated. | OpenCode usage:false registry discrepancy retained explicitly; issue links are risk history, not present incident verdicts. |
| `docs/LOCAL-MODEL-VALIDATION.md` | docs/adr/0011-local-model-provenance-zero-cost-and-transcript-fidelity.md; src/lib/model-inventory/discovery/ollama.mjs | H12 | Corrected capture-sharing privacy claim and distinguished shipped catalogue collection from proposed transcript experiment. | ADR-0011 remains Proposed; alias/billing/transcript observations not fabricated. |
| `docs/MANAGED-TOOLS.md` | src/lib/{versions,providers,natives}.mjs; src/lib/adapters/deja-vu.mjs; tests/kit/deja-vu-lifecycle.test.mjs | H04 | Replaced impossible cross-surface agreement guarantee with shared collectors and capture-time limits. | No network package updates; installed-version and release namespace contracts retained. |
| `docs/METAHARNESS-COMPANION-PROPOSAL.md` | src/commands/run.mjs; docs/adr/0022-metaharness-as-optional-assurance-companion.md | H13 | Explicit current implementation boundary; retained upstream design as dated proposal. | No adapter/schema/promotion exists by implication; no external evaluation executed. |
| `docs/MODEL-PRICING-AUDIT.md` | src/lib/pricing.mjs; src/lib/model-inventory/discovery/anthropic-catalog.mjs | — | Retained September 8 historical price-verification record and estimator exclusions. | Not a September 9 price refresh; historical statements remain dated, no current-price guarantee added. |
| `docs/MODELS.md` | src/lib/model-inventory/{refresh,store,read-model}.mjs; src/lib/model-inventory/discovery/{claude,codex,ollama}.mjs; tests/kit/model-discovery-claude-codex.test.mjs | — | Retained separate discovery/configured/observed/entitlement states, 32 snapshots/90 days, cache-only reads and explicit refresh. | No account entitlement, live catalogue completeness or model-quality equivalence verified. |
| `docs/PROVIDERS.md` | src/lib/{providers,aqe-router,routing}.mjs; src/lib/adapters/sources.mjs; tests/kit/providers.test.mjs | H02/H05/H09 | Removed unevidenced cost/quality comparisons and $0 binding guarantee; clarified OpenCode host, loopback reads, npm staging and legacy whole-file undo. | Exact-value external-provider reconcile does not change legacy off behavior; code remediation needed separately. |
| `docs/SETUP.md` | src/commands/setup.mjs; src/lib/aqe-guidance.mjs; src/lib/config.mjs; tests/kit/setup-command.test.mjs | — | Retained actual machine/project scope, default AQE, force-init, destructive oversized-RVF warning, trust manifest and ownership boundaries. | No setup run on user state; upstream initializer behavior remains version-dependent. |
| `docs/UPGRADING.md` | src/commands/sync.mjs; src/lib/heal.mjs; src/lib/providers.mjs; official Claude statusline docs | H06 | Corrected sync two-motion wording and unsafe live-session assurance; recognized host-specific reload behavior. | Historical migration sections retained as migration history; no install upgrade performed. |
| `claude/aqe-reference.md` | src/lib/config.mjs; src/lib/aqe-router.mjs; tests/kit/guidance-budget.test.mjs | H07 | Removed assertion that aqe health establishes billing; provider/billing require separate evidence. | Compact source only; not synced into machine files. |
| `claude/dual-mode-reference.md` | src/lib/execution/{runner,adapters}.mjs; src/lib/providers.mjs; tests/kit/guidance-targets.test.mjs | — | Retained host-peer authority, deadline, optional plugin and provenance boundaries. | Guidance does not itself enforce permissions or prove runtime. |
| `claude/providers-reference.md` | src/lib/providers.mjs; src/lib/adapters/registries.mjs; tests/kit/guidance-targets.test.mjs | — | Retained host/provider distinction, external-install handling and credential boundary. | No machine projection performed. |
| `claude/ruflo-opencode-reference.md` | src/lib/opencode-core.mjs; src/lib/execution/opencode.mjs; tests/kit/opencode.test.mjs | — | Retained lazy gateway/profile semantics and host-native messaging boundary. | No OpenCode session or external gateway health claimed. |
| `claude/ruflo-preamble.md` | src/lib/blocks.mjs; tests/kit/guidance-budget.test.mjs; tests/kit/reference-command.test.mjs | — | Retained generic machine scope, authority, preservation and evidence instructions. | Repository-specific commands still belong in repository instructions. |
| `claude/ruflo-reference-full.md` | src/templates/statusline-footer.cjs; src/commands/setup.mjs; src/lib/natives.mjs; src/lib/config.mjs | H07/H14 | Removed obsolete memory diagnoses, zero context-cost/tool-count claims, incorrect AQE opt-in, misleading footer/LoRA/security claims and universal-heal promises. | Upstream CLI examples are on-demand guidance; installed help and live tool schemas remain authoritative. |
| `claude/ruflo-reference.md` | src/commands/x/reference.mjs; tests/kit/reference-command.test.mjs; tests/kit/guidance-budget.test.mjs | — | Retained bounded pointer, discovery requirements, coordination versus execution, opt-in spend. | No universal availability implied. |
| `claude/ruvnet-brain-opencode-reference.md` | src/lib/opencode-core.mjs; src/lib/ruvnet-brain.mjs; tests/kit/opencode.test.mjs | — | Retained search-only managed shim and explicit unavailable-source behavior. | Registration not live availability; no installation changes. |
| `claude/ruvnet-brain-reference.md` | src/lib/ruvnet-brain.mjs; tests/kit/brain-hook-contract.test.mjs | — | Retained managed update ownership and source-grounding boundary. | KB search provides repository evidence, not current release health. |
| `claude/superpowers-reference.md` | tests/kit/guidance-targets.test.mjs; tests/kit/guidance-budget.test.mjs | — | Retained workflow versus subsystem division and verification requirements. | Policy guidance; not a claim that a workflow tool is installed. |
| `claude/skills/ruflo-token-audit/SKILL.md` | claude/skills/ruflo-token-audit/scripts/ruflo-token-audit.py; src/commands/setup.mjs | H07/H15 | Removed origin guesses from model/time/count and MCP cost inference; corrected default daemon and opt-in AI workers. | Claude-only legacy standalone report, not all-host or subscription billing truth. |
| `src/templates/aqe-lifecycle/README.md` | src/lib/hook-audit/aqe-artifacts.mjs; src/templates/aqe-lifecycle/brain-checkpoint.cjs; tests/kit/aqe-lifecycle-migration.test.mjs | — | Retained exact preimage/compatibility provenance, timeout and data preservation contract. | No general upstream fix or unverified helper replacement claimed. |
| `src/templates/opencode-worker-prompt.md` | src/lib/execution/opencode.mjs; src/lib/usage-provenance.mjs; tests/kit/opencode-execution.test.mjs | — | Retained invocation-only provenance marker, project boundary and approval instructions. | Prompt is not a sandbox and cannot override host permissions. |

## Authoritative documentation inspected

- [Claude status line](https://code.claude.com/docs/en/statusline): user/project configuration,
  session JSON and command reload behavior; inspected 2026-09-09.
- [Claude model configuration](https://code.claude.com/docs/en/model-config): native model and
  auto-compaction controls; inspected 2026-09-09. These are not kit-managed controls.
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference): native
  context/configuration surface; installed-source conformance remains limited to the checked-in profile.
- [OpenCode models](https://opencode.ai/docs/models/) and
  [configuration](https://opencode.ai/docs/config/): model limits and native controls;
  inspected 2026-09-09, no running OpenCode session verified.
- [Hermes adapter manifest](https://github.com/adrianco/ak-adapter-hermes/blob/main/ak-adapter.json)
  and [run hook](https://github.com/adrianco/ak-adapter-hermes/blob/main/run-hook.mjs):
  inspected 2026-09-09; no conformance run or new grant.
- RuvNet Brain search located `ruflo/v3/docs/releases/v3.32.34.md` (native memory migration)
  and `ruflo/v3/docs/releases/v3.32.30.md` (package/capability boundaries). These are dated
  source records, not an installed-package health verdict.

## Validation

- `node --test tests/kit/reference-command.test.mjs tests/kit/codex-statusline.test.mjs tests/kit/aqe-lifecycle-migration.test.mjs tests/kit/model-discovery-claude-codex.test.mjs`: **31 passed**.
- `node --test tests/kit/guidance-budget.test.mjs tests/kit/guidance-targets.test.mjs tests/kit/providers.test.mjs tests/kit/adapter-hook-runner.test.mjs tests/kit/deja-vu-lifecycle.test.mjs tests/kit/context-report.test.mjs tests/kit/model-inventory-store.test.mjs`: **123 passed**.
- Markdown lint: passed across 111 configured documentation files plus the edited managed references.
- `git diff --check`: passed. Integration owner runs remaining repository-wide gates.

No host configuration, global package, transcript, database, live provider, or generated
machine guidance was changed. Test home/project fixtures remain sandboxed by the repository helpers.

## Code follow-ups kept outside documentation remediation

1. `scripts/codex-usage-diagnostic.mjs` is not current dashboard parity: old rate table,
   model fallbacks, string-only thread-source handling, and last-session-metadata behavior.
   Its source/help also contain stronger privacy claims than its whole-file reads support.
2. `undoAqeRouter` in `src/lib/aqe-router.mjs` restores/deletes a whole marked file; later
   user edits can be lost. `undoProviders` deletes named managed env keys without checking
   the last projection. Documentation now discloses this; exact-value teardown needs code work.
3. The built-in OpenCode descriptor still says `usage:false` despite the separate SQLite
   usage parser. Existing HOST-SUPPORT discrepancy remains explicit; no capability promoted.
