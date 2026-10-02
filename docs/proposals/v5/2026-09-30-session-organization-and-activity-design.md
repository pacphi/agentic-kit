# Session organization, meaningful titles, and Activity classification

## Status

**Blocked** and deferred to M3 after the maintainer returned focus to remediation on 2026-09-30.
Preserve the accepted design; no further research, sampling or implementation is in the M1 batch.
Execution authorization and exact private-sampling/processing details remain pending.
No implementation, commits, pushes, publication, installation, data operations or cleanup is authorized.
Written 2026-09-30 against main 0511d575; this is a proposed design, not a delivered capability.

The maintainer approved organization option B: one Sessions catalog, independent filters,
native/user titles, and opt-in bounded context for better titles. The maintainer also requires
strictly fewer than 10% of sessions to have Unknown Activity. That requirement does not authorize
fabricating labels, changing thresholds without evidence, or accessing private transcript bodies.
The source currently calls this Activity outcome Unclassified; display naming is a separate
decision. Unknown host, origin, workspace, or provider is not Unknown Activity.

This M3 feature track extends P11 in the [completion program](../../archive/2026-09-29-plan-completion-program.md)
and has its own [acceptance rows](../../archive/2026-09-29-plan-completion-acceptance-ledger.md#session-organization-and-activity-extension).
It is not a prerequisite for M1 or blanket M2/#239 completion. Cowork discovery remains
independently deliverable; its disclosed unsupported coverage cannot be disguised by this catalog.

## 1. Research question, method, and limits

How can people re-find sessions by what they did, where they worked, and how they started them,
across current and future hosts, without guessing identity or exposing more content than necessary?
How can Activity rejection fall below 10% while accepted labels remain trustworthy?

Method: inspect repository implementation and governing ADR Status/Date/Updated stamps; read
official host documentation; review primary information-retrieval and classification research;
exercise the existing pure classifier with synthetic inputs; distinguish observations from
recommendations. Sources were accessed 2026-09-30. No private corpus or installed-host session
stores were sampled, no models trained or installed, and no real Activity distribution measured.
External API documentation describes a candidate source; it does not prove installed-version
availability, adapter integration, historical coverage, or permission to invoke the API.

Academic results below come from other datasets and tasks. They motivate experiments here; none
guarantees a particular Unknown rate, accuracy, inference cost, or privacy property for agentic-kit.
Brain retrieval for Activity/calibration returned thin, documentation-only relevance; it establishes
neither an available classifier nor absence of one. Do not invent a RuvNet implementation.
Project memory search returned command records, not an adjudicated classifier decision.

## 2. Repository evidence and governing decisions

| Record | Status and stamps inspected | Governing implication |
| --- | --- | --- |
| [ADR-0009](../../adr/0009-usage-scorecard-local-transcript-analytics.md) | Implemented; Date 2026-07-25; Updated through 2026-09-29 | Offline cached Usage, graded evidence, bounded content, and honest Unclassified outcome; model labelling is not implemented. |
| [ADR-0027](../../adr/0027-shared-project-census.md) | Implemented; Date 2026-08-07; Updated 2026-09-09 | One bounded census; count scope and basis visible; directory sightings are not session counts. |
| [ADR-0029](../../adr/0029-host-adapter-extension-point.md) | Accepted experimental contract; Date 2026-08-15; Updated through 2026-09-27 | Host execution admission does not grant universal session-observation capability. |
| [ADR-0050](../../adr/0050-dashboard-project-identity-and-context-reporting.md) | Implemented; Date 2026-09-09; Updated 2026-09-27 | Git administration proves grouping; the current Projects contract includes non-Git folders. |
| [ADR-0052](../../adr/0052-codex-usage-attribution.md) | Accepted; Date 2026-09-19; Updated through 2026-09-29 | Imported turns, genuine later activity, replay and accounting retain distinct ownership. |
| [ADR-0060](../../adr/0060-session-surface-initiator-and-product-names.md) | Accepted; Date 2026-09-26; Updated 2026-09-29 | Surface, initiator, host, provider and Git scope are separate; dedicated Cowork storage remains uncovered. |

The proposal deliberately refines terminology: Sessions is the universal population; Repositories
is the strict Git view. Application vendors' Projects remain qualified application workspaces.
This changes ADR-0050's current broad Projects wording and must be reconciled explicitly, not
described as a pre-existing repository-only contract. Amend affected ADRs in the implementation
PR with Status as warranted, Updated date, and a change note; do not rewrite history now.

Current title handling is partial prior art, not a new feature to duplicate:

- [Claude/Codex parsing](../../../src/lib/usage-parsers.mjs) uses Claude's native ai-title or the
  first genuine human prompt; Codex uses the first genuine human prompt. Titles are clipped and
  masked in those paths.
- [OpenCode parsing](../../../src/lib/usage-opencode.mjs) consumes its persisted session title.
- [Project discovery](../../../src/lib/footprint/project-sources.mjs) explicitly retains neither
  prompt text nor generated titles in firstSessionMetadata.
- [Workspace evidence](../../../src/lib/usage-project-evidence.mjs) records
  observationBasis: current-filesystem. Today's Git state cannot prove historical launch state.
- [Activity classification](../../../src/lib/usage-classify.mjs) uses skill/plugin prefix mappings,
  title substring scores, and exact tool-name counts. Its score floor is 0.28; it is not a
  demonstrated calibrated probability. Mapped skill/plugin provenance currently returns 1.0.

Read-only synthetic probes against the existing classifier:

| Input | Executed result | Interpretation |
| --- | --- | --- |
| Plan the cancellation contract | Unclassified; 0; no signal | Planning is in the category list but has no title rule. |
| Write a report | Unclassified; 0; no signal | Writing intent is not covered by these words. |
| Build command-line parser | Unclassified; 0.15; weak signal | Substring overlap and margin can reject a clear title; this is not a corpus prevalence measurement. |
| Refactor parser; exec_command count 20 | Refactor; 0.43 | An aggregate shell-tool count does not activate the edit prior. |
| Refactor parser; Edit count 20 | Refactor; 0.50 | Existing priors depend on Claude-style exact names. |
| Write a report; skill autopilot:run-phase | Orchestration; 1.0 | Skill invocation is recorded provenance; its whole-session Activity meaning still needs validation. |

These probes are source-bound behavior observations, not a reviewed gold dataset or accuracy
verdict. The current tests intentionally preserve abstention. Do not relax them merely to meet
the coverage target. Tool prior names alone are not proof that all host tool semantics differ;
verify actual producer fields before defining each normalization.

## 3. Evidence model and organization

| Dimension | Examples and rule |
| --- | --- |
| Execution host | Claude Code, Codex, OpenCode, Hermes Agent, admitted external host, unknown; applications/surfaces are not automatically execution hosts. |
| Launch surface | Terminal, IDE, desktop, web, mobile, messaging platform, API/SDK, unknown; use declared origin, not transcript storage path. |
| Initiator | Person, automation, another agent, unknown; imported-copy ownership is recorded separately. |
| Execution environment | This computer, another computer, managed cloud, unknown; VM/container and tool-resource locations are separate attributes, since execution can span locations. |
| Workspace association | Repository/worktree, ordinary folder, application workspace, explicitly none, unknown; multiple evidenced associations are permitted. |
| Activity | Reviewed labels, multiple supported phases/activities where appropriate, or Unknown; inference is labelled. |
| Relationship | Continuation, fork, subagent, import, compression segment, unknown; meaning comes from the host adapter. |

Record launch-time evidence separately from later working locations and controlling surfaces.
Started in a repository, executed against a repository, and discussed a repository are different
observations. A title or generated summary cannot establish the first two. Preserve per-field
source, timestamp, evidence basis, and absent/conflicting/unsupported reason. A path is
environment-scoped: a remote path is never resolved against the local filesystem.

Stable identities use host/source namespace plus native identity; relationships require verified
links. Never join by title, basename, matching remote URL, or similar prose. Git common-directory
and worktree proofs follow ADR-0050. Independent clones stay distinct unless a separately defined
logical association is explicit. A session can visit several repositories without being duplicated
in total counts. Imported copies, forks, and compression chains follow their own accounting rules.

Default presentation: useful title, host/product surface, date, and concise workspace label.
Raw paths/IDs belong in detail. Combine filters and retain counts with the same time window,
timezone, scope and deduplication basis. Provide views for repository work, folder work,
application workspaces, automation, and workspace unknown; these are views over the same records.
An explicitly absent workspace is different from unavailable evidence. Topic collections are
optional user organization; automatic semantic clustering is outside this approved scope.

## 4. Host-specific evidence matrix

| Host or surface | Available upstream evidence and particulars | Kit boundary / planned validation |
| --- | --- | --- |
| Claude Code | Native titles and declared entrypoints; Remote Control permits web/mobile control with local execution [H1]. | Preserve first declaration, parent/import exclusions and unknowns; separate launch from later access. |
| Codex / ChatGPT desktop app surfaces | App-server documents names, previews, thread/session relationships and cwd; per-turn cwd can change. Local/worktree/cloud modes are distinct [H2/H3]. | Test exact supported versions and historical sources; do not start a server just to fill a missing field. Native name origin may be unknown. |
| OpenCode | Session API exposes title, parent relationships and session details [H4]; current kit consumes persisted directory/title. | Verify storage/version scope and native project semantics; store location cannot prove terminal versus browser client. |
| Hermes Agent | Native metadata includes source platform/title; CLI and messaging sessions exist; parent links may represent compression continuations [H5]. | External adapter execution support is not session analytics. Require an explicit read-only source contract; do not classify every parent link as subagent. |
| Cowork | Local and cloud architectures coexist; local agent loop and VM tool execution differ. Pro/Max cloud transition is announced for 2026-10-06; existing local sessions remain local [H6/H7]. | Dedicated discovery is still unverified. Version/date/plan-aware metadata is necessary; local connected folders do not establish local execution. |
| Future admitted hosts | Fields are capability-dependent; upstream titles may already be generated. | Declare supported observations, source/format versions, bounds, permission and fixtures. Missing fields stay unknown; source support never silently expands execution or filesystem authority. |

Cloud-only history absent from local sources is a coverage gap, not evidence of zero sessions.
Use a sanctioned read-only source or disclosed import only after its access/privacy contract is
approved; do not scrape private account APIs or claim local discovery covers all web sessions.
Ruflo, AQE, and companions are orchestration/tool integrations unless a recorded invocation
establishes their relationship to a host; registration is not session execution evidence.

## 5. Meaningful title policy and options

| Organization option | Scope | Decision |
| --- | --- | --- |
| A | Metadata categories and native titles only | Considered; does not address generic titles adequately. |
| B | Unified Sessions, independent filters, native/user titles, opt-in bounded context for better titles | Approved by maintainer 2026-09-30. |
| C | Full transcript semantic indexing, automatic topic clustering and generated summaries | Not approved; larger privacy, storage and maintenance scope. |

Title precedence: user override; useful host-supplied title; bounded extractive description of
genuine user intent; optional generated title under a separate processing policy. Preserve the
original title and title source; host-supplied does not mean human-authored. Random slugs,
instruction headers and empty/boilerplate prompts do not become meaningful titles automatically.
User overrides are never overwritten; title changes cannot change native identity or counts.

Context input excludes system/developer instructions, imported/replayed content, tool bodies,
credentials, and assistant self-reported outcomes. Use bounded initial intent plus a bounded
clarification sample if necessary. Initial benchmark limit approved 2026-09-30: first substantive
user request plus up to two clarifications, at most 8,000 Unicode code points total across the
user excerpts; metadata/native titles retain their separate bounds. Document selection,
clipping and absent context. No automatic expansion to 16,000 is approved. The collection cap
is not a model token window; evaluate explicit truncation/chunking without hiding lost evidence.
For changing tasks,
retain phase metadata or an explicit rename; do not silently rename on every dashboard poll.
Example: Investigate Windows CI timing describes intent; Windows CI fixed asserts an outcome.

Derived titles can contain sensitive information even after secret masking. Keep them private,
bounded, escaped in rendering, and excluded from public/export receipts by default. Do not
persist extra raw excerpts or embeddings by default. No model/network call on ordinary viewing.
Cache by source revision, taxonomy and title-policy versions; invalidation, manual correction,
retention, deletion and disabled-processing behavior must be tested. Approved optional generation
has a named backend, processing location, budget and explicit scope; native generation is reused
before another provider is called. Do not modify original host records to implement kit labels.

## 6. Academic basis for better Activity classification

| Primary research | Relevant result | Proposed application and limitation |
| --- | --- | --- |
| Dumais et al., SIGIR 2003 [R1] | Unified retrieval with contextual cues supports re-finding. | Retain title/time/surface/workspace filters; no claimed measured improvement for agent sessions. |
| Yee et al., CHI 2003 [R2] | Faceted collection browsing was evaluated against a baseline. | Independent filters rather than one overloaded session category. Different population/task. |
| Jones et al., CIKM 2001 [R3] | Relevance context and reminding functions matter in keeping information reusable. | Human-readable intent and optional user labels, beyond opaque paths/IDs. |
| Maynez et al., ACL 2020 [R4] | Fluent summaries can be unfaithful; overlap scores do not prove faithfulness. | Generated titles/labels require source-grounded checks. Historical summarizers do not predict today's model failure rate. |
| Geifman and El-Yaniv, NeurIPS 2017 [R5] | Selective classification trades coverage against prediction risk. | Evaluate Unknown rate and accepted-label error jointly; do not lower a threshold blindly. Their image-task guarantees do not transfer here. |
| Guo et al., ICML 2017 [R6] | Predicted confidence can be poorly calibrated; post-processing can improve it. | Separate heuristic score from empirical correctness; fit calibration on held-out data. Temperature scaling requires suitable logits; it is not directly applicable to today's keyword formula. |
| Ratner et al., PVLDB 2017 [R7] | Weak labels have differing accuracies, conflicts and correlations. | Treat title/tool/skill signals as separate weak sources; avoid counting generated title and its source prompt as independent corroboration. No Snorkel dependency is selected. |
| Tunstall et al., 2022 [R8] | SetFit studies a small supervised text classifier in label-scarce settings. | Benchmark a local semantic candidate if simpler features miss the bar; no promised agent-session accuracy or selected runtime dependency. |
| Settles, 2009 [R9] | Active learning selects informative examples; uncertainty alone can overselect outliers. | Combine representative random samples, host/category strata and disagreement cases for human annotation. Audit holdout remains independently sampled. |

## 7. Recommended algorithm investigation and alternatives

| Approach | Benefits | Limitations / disposition |
| --- | --- | --- |
| A: improve deterministic rules only | Small, explainable, offline; preserves zero-runtime-dependency default. | Baseline candidate, not assumed sufficient for paraphrases or non-coding hosts. |
| B: small supervised local classifier | Learns paraphrases with auditable training/calibration; no per-session cloud call. | Requires labels, reviewed optional runtime/model assets and performance/license/privacy checks. Benchmark only after authorization. |
| C: LLM classifies every session | Flexible taxonomy/context interpretation; local and remote models are separate variants. | Reopened for source-grounded review 2026-09-30; an early comparator, not automatically less accurate or cloud-only. No runtime/model is selected. |
| D: staged selective cascade | Correct obvious mappings, normalize host evidence, evaluate A/B, reserve approved model assistance for residual cases. | Approved then reopened 2026-09-30; the revised shortlist below is now approved for evaluation planning. No production winner is selected. |

Investigate in this order:

1. Freeze label definitions and the evaluation population; measure the existing algorithm.
   Review whether coding-centric categories cover document, data and messaging work.
2. Fix evidence acquisition and host normalization: bounded genuine task intent, native titles,
   useful clarification, task/phase metadata, and typed tool actions. A shell wrapper is not
   an edit/read action without an observed semantic result. Missing counters remain missing.
3. Replace naive substring evidence with reviewed token/phrase/negation-sensitive features;
   add missing planning/writing signals and examine collision/ambiguity cases.
4. Treat invoked skills/plugins as task evidence, not automatically whole-session truth.
   Separate orchestration method from activity; one session can contain several activities.
5. Compare current rules, improved rules, simple supervised text features, and an authorized
   semantic candidate using the same train/development/calibration/frozen-test partition.
6. Select thresholds from risk/coverage evidence; an optional residual model produces
   structured labels and bounded evidence, may abstain, and cannot authorize actions.
7. Offer user correction and a separate opt-in annotation loop; review uncertain, conflicting
   and representative cases without silently modifying the benchmark or promoting a model.

Use genuine user/task evidence directly for classification where consent permits; a generated
title is a display aid, not a required lossy bottleneck or an independent gold label. Transcript
content is untrusted data, never an instruction to the classifier. Any embedding/vector, memory,
routing or QE service uses a real disclosed implementation and version-bound contract, not a
kit-owned imitation. Keep default browsing deterministic/offline and avoid a mandatory model
download or Python runtime. Backend selection and optional dependencies need explicit approval.

Mixed activity requires evidence for at least two defined activities; it cannot absorb weak or
missing evidence to improve the metric. Report phase/label coverage; merely adding a Mixed or
Other label cannot satisfy the bar. Multilingual, terse, resumed, imported, automated and
multi-repository sessions are explicit evaluation strata.
Taxonomy option B confirmed 2026-09-30: one primary Activity plus evidence-supported secondary
Activities from a fixed reviewed vocabulary. The approved 95% correctness gate applies to the
primary Activity; secondary labels have separate precision/recall reporting. Structure approval
does not approve the category rubric or infer actual execution from a user request.
The software-heavy rubric was rejected. Broader B direction is approved: the [conversation/topic
refinement](2026-09-30-conversation-activity-and-topic-taxonomy-design.md) defines broad Activity
families, useful detail and independent Topics; provisional annotation rubric approved, to be
refined on development examples and frozen before final evaluation.

### RuvNet candidate review and Option C reconsideration (2026-09-30)

The maintainer explicitly paused the benchmark-method decision to revisit classification C
after approving D. This section preserves that order; it does not authorize a model call,
download/installation, training, data ingestion, or a replacement execution backend.

Grounding: Brain source search located router, RuvLLM, Tiny Dancer and inference paths; live
review bound implementation to RuVector commit 4697707221c391bf2d089bc95abb9ae4fffd8d8f,
committed 2026-09-29. The Brain's 1.4-day-old package snapshot was behind live npm metadata.
Registry reads found router 0.1.31 (published September 21), RuvLLM 2.7.0 (September 28),
Tiny Dancer 0.1.22 (June 15) and ruvector 0.3.3 (September 23).
Router/RuvLLM/Tiny Dancer tarballs were read in memory and their SHA-512 integrity matched
registry metadata. No package scripts or native binaries were executed; platform availability,
runtime health, model quality and performance remain unverified.

| Candidate | Verified source/package boundary | Relevance to Activity |
| --- | --- | --- |
| @ruvector/router 0.1.31 | Published index.js and declarations export SemanticRouter; examples/centroids, external setEmbedder, top-k similarity and rejection threshold exist [E1]. | A real semantic-intent candidate. Needs a genuine semantic embedder and representative Activity examples; similarity is not calibrated correctness. |
| @ruvector/ruvllm 2.7.0 Node library | Published dist/cjs/engine.js warns that generate/query text is not model output; modelPath/backend options are unsupported. Source and tests say the same [E2]. | Do not use its placeholder text or hash fallback as the Option C classifier. Installing native bindings alone does not prove model-backed classification. |
| Rust ruvllm-cli | Separate serve.rs loads an LlmBackend, exposes model-backed completion paths and a strict load-failure gate; non-strict mode can serve mocks [E3]. | Possible local model-serving candidate, not a proved installable package seam. Runtime/output conformance must refuse mock/error responses and verify exact loaded weights. |
| RuvLTRA training sources | Agent routing examples focus on coder/researcher/security/architecture/reviewer and model selection [E4]. | Adjacent task; not a ready-made full Activity taxonomy spanning coding, writing, data and messaging. No advertised routing accuracy transfers automatically. |
| @ruvector/tiny-dancer 0.1.22 | Published declarations expose trainRouter/score; that score targets whether a cheap model is good enough, rather than a multiclass Activity label [E5]. | Could later choose classification backend effort from qualified labels; not the direct Activity classifier. |

The Node library and Rust CLI share a name but are different interfaces. The published npm
2.7.0 bin/cli.js command switch does not expose serve, although its README directs readers to
ruvllm serve. Therefore no installation recommendation may assume npm installation supplies
the Rust serving executable. Native/runtime/package conformance is a prerequisite to selection.
In inspected Rust serve.rs, strict controls initial model-load refusal; a streaming-error path
still emits mock_stream_response. Strict alone is not proof that every output is model-backed.
Use a verified response contract; do not silently substitute another serving runtime.

The relevant RuVector ADR-002 is Proposed, dated 2026-01-18; its RuvLLM integration narrative
does not prove runtime behavior. ADR-210 is accepted, dated 2026-06-12, and describes semantic
embedding provenance and loud hash fallback. Its design is not package-specific runtime proof;
the actual selected embedder must prove model identity, normalization, dimensions and readiness.

Reassessment of C: an LLM reading bounded genuine intent/context can plausibly improve paraphrase,
multi-step and non-coding classification versus today's narrow keyword rules. This is an
inference to test, not a 95% accuracy claim. A uniform model can also simplify label semantics
across hosts. Content acquisition, taxonomy, missing evidence and calibrated rejection remain
necessary regardless of backend; an LLM cannot reconstruct absent historical origin evidence.

Additional primary research reviewed:

- Edwards and Camacho-Collados (2024), [Is In-Context Learning Enough?](https://aclanthology.org/2024.lrec-main.879/):
  compares 16 text-classification datasets; smaller fine-tuned models can outperform larger
  few-shot models. Prompting is a candidate, not a demonstrated accuracy optimum.
- Pecher et al. (2025), [Small versus general large models](https://aclanthology.org/2025.emnlp-main.9/):
  label requirements and variance depend on task; larger models do not consistently improve
  classification. Their average break-even sample count is not this benchmark's required size.
- Ma et al. (2025), [LLMs do multi-label classification differently](https://aclanthology.org/2025.emnlp-main.126/):
  generated-label distributions can suppress alternatives. Evaluate multi-activity sessions
  explicitly; a fluent primary label is not complete activity coverage.
- dela Cruz et al. (2025), [Extractive rationales and confidence](https://aclanthology.org/2025.gem-1.49/):
  source-supported snippets improved confidence estimates in the studied task. Require bounded
  evidence references, but do not treat an explanation or self-rating as calibrated correctness.

Revised C candidate: apply a pinned genuine model to every permitted session at ingestion or an
explicit bounded backfill; cache structured primary/secondary labels and source evidence;
allow Unknown; preserve user overrides. Ordinary browsing never invokes the model.
Local serving and remote-provider processing require different approvals and measured costs.
RuVector retrieval can supply reviewed examples; it is optional augmentation, not an accuracy
guarantee. Examples must come from training/reference data, never the frozen evaluation labels.
Do not send full histories, assume a larger context window is better, or accept model-generated
confidence as the approved statistical gate.

Intermediate recommendation, refined by the approved embedded-model shortlist below: evaluate model-first C
candidate early beside RuVector semantic classification and the existing baseline. Do not
require a rules rewrite to fail first. Then select one default or a measured cascade against
the same <10% Unknown and >=95% accuracy gates, including cross-host, privacy and operating costs.
If C wins, the production path can be model-first; if a lighter candidate wins, use it.
The revised shortlist below settles candidate-selection scope while retaining the earlier D
history. Benchmark option A is now confirmed; no private-content inspection, inference or implementation is authorized.

Ecosystem source receipts:

- E1: [router index.js](https://github.com/ruvnet/ruvector/blob/4697707221c391bf2d089bc95abb9ae4fffd8d8f/npm/packages/router/index.js);
  [published router metadata](https://registry.npmjs.org/@ruvector%2frouter/0.1.31).
- E2: [RuvLLM engine](https://github.com/ruvnet/ruvector/blob/4697707221c391bf2d089bc95abb9ae4fffd8d8f/npm/packages/ruvllm/src/engine.ts),
  [no-language-model tests](https://github.com/ruvnet/ruvector/blob/4697707221c391bf2d089bc95abb9ae4fffd8d8f/npm/packages/ruvllm/test/no-language-model.test.js);
  [published RuvLLM metadata](https://registry.npmjs.org/@ruvector%2fruvllm/2.7.0).
- E3: [Rust serving implementation](https://github.com/ruvnet/ruvector/blob/4697707221c391bf2d089bc95abb9ae4fffd8d8f/crates/ruvllm-cli/src/commands/serve.rs).
- E4: [training source](https://github.com/ruvnet/ruvector/blob/4697707221c391bf2d089bc95abb9ae4fffd8d8f/crates/ruvllm/src/training/claude_dataset.rs)
  and adjacent training README; documented agent-routing goals are distinct from session Activity.
- E5: [Tiny Dancer API](https://github.com/ruvnet/ruvector/blob/4697707221c391bf2d089bc95abb9ae4fffd8d8f/npm/packages/tiny-dancer/index.d.ts);
  [published metadata](https://registry.npmjs.org/@ruvector%2ftiny-dancer/0.1.22).

### Embedded ONNX, specialized heads, and Laya review (2026-09-30)

The maintainer requested more web research on an embedded specialized classifier and Laya.
This refines the candidate shortlist; it does not select a runtime or authorize private-data
reads, model downloads, training or inference. Direct discriminative classification is distinct
from generative Option C: it scores labels without generating an answer token by token.

An embedded Node.js path is documented: ONNX Runtime supplies prebuilt CPU bindings for
Windows/macOS/Linux on x64 and arm64 [O1]. Transformers.js exposes text-classification and
embedding pipelines backed by ONNX [O2]. SetFit documents exporting a sentence-transformer
and classifier through Optimum/ONNX [O3]. Python may be used offline for authorized training/
export; a validated Node deployment need not require Python or an always-running server.
ONNX is a deployment format/runtime boundary, not a source of classification accuracy.

| Candidate | Evidence inspected | Expected role / unresolved limitation |
| --- | --- | --- |
| Domain-trained MiniLM/SetFit-style classifier | MiniLM-L6 model card names a 22.7M-parameter encoder; published ARM64/x86 INT8 ONNX artifacts are about 23 MB [O4]. | Leading compact candidate: train a primary/multilabel head on the approved Activity rubric. The base encoder is not itself an Activity classifier; final fine-tuned/quantized accuracy and runtime footprint remain unmeasured. |
| Model2Vec/Potion plus supervised head | Author project describes static embeddings; Potion-base-8M lists roughly 30 MB weights and an ONNX artifact [O5]. | Low-footprint comparator. Non-contextual averaging may lose negation/order; do not assume the smallest model meets the quality bar. |
| Laya typed decision model | Origin model card, core source and Node ONNX wrapper exist [O6/O7/O8]. Labels/descriptions can be supplied at inference; no free-text generation is needed. | Serious challenger, especially flexible category schemas. Domain specialization/calibration still needed; larger footprint than MiniLM. |
| GLiClass | 2025 research describes joint text/label sequence classification and multilabel adaptation [O9]. | Relevant discriminative zero-shot comparator if resources permit; exact Node export/platform/weights are not verified or selected. |
| General instruction LLM | Classification literature above supports testing prompted models against specialized small models. | Accuracy/reference or optional annotation assistance; not assumed best or required for every production session. |

Live model-repository metadata (weights were not downloaded) binds these artifact observations:

- MiniLM repository revision 1110a243fdf4706b3f48f1d95db1a4f5529b4d41:
  ARM64 INT8 ONNX 23,026,053 bytes; AVX2 variant 23,046,789 bytes.
- Potion-base-8M revision bf8b056651a2c21b8d2565580b8569da283cab23:
  model.safetensors 30,236,760 bytes; ONNX 30,240,854 bytes.
- Original English Laya revision 55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851:
  842,609,210-byte checkpoint. Core README identifies ModernBERT-large, 421M parameters;
  multilingual uses mmBERT-base, 322M parameters.
- Community receptron ONNX bundle revision 68f27dfe5a27a54fb2b1fefc432f43f972e90868:
  laya.onnx is 3,807,291 bytes but external laya.onnx.data is 1,685,258,240 bytes.
  A tiny graph file does not mean tiny model weights.
- Another community export, leli14/laya_cpu_onnx revision
  c56f3aa683ffa2873e1548f79ae058c5e7f79824, has a 1,290,602,374-byte quantized graph
  and an application-specific dialogue-state card; it is not a recommended Activity checkpoint.

Sizes are artifact bytes, not peak RSS, startup time or latency. Quantization must be validated
on the final taxonomy and rejection threshold after export; sample scores can change enough to
alter the accuracy/coverage tradeoff. Pin model, tokenizer, pooling, graph opset, classifier
head, label order and calibration together. Reuse real RuVector intent matching/exemplar
retrieval where appropriate; a trained discriminative head need not introduce a vector store.

Laya source review used core commit 6d942c92081fbc139e736bbd9ac0023223c29b7f
(2026-09-29) and receptron wrapper 6478649e723122ca24bbf5fb69ed1010023c9750
(2026-09-21). The wrapper's src/laya.ts calls ONNX Runtime InferenceSession.create/run,
builds decision-marker tensors and applies saved temperature values. This is implementation
evidence for a Node path, not an executed cross-platform conformance result.

The core maintainers report base English/multilingual typed-decision accuracy 0.362/0.352
and 0.766 for a checkpoint specialized on that benchmark. These are their workflow results,
not agentic-kit measurements. They disclose failures on narrow negated requests, option-label
sensitivity, shared option-token budgets and domain-fitted calibration. The advertised
calibrated probabilities cannot be treated as universal >=95% correctness.
In current core docs, choice confidence is normalized-entropy concentration; answer_confidence
is the reported answer's probability. Their cutoffs are not interchangeable. Neither replaces
the approved independently audited accuracy gate.

English options share a 192-token head budget and state has a bounded context window.
Our approximately fifteen substantive Activity categories fit the advertised cardinality
range but descriptive labels can still collide or consume state context. Validate phrasing,
label-order changes, negation, multilingual requests and primary/secondary activities; test
truncation explicitly. No hidden category reduction or discarded evidence may improve the bar.
Use exact graph/tokenizer/logit parity tests against the original framework and evaluate
confidence calibration after fine-tuning and quantization, on data separate from training.

Strongest updated research recommendation: lead with a compact domain-trained ONNX classifier;
compare it early with Laya (base and, if authorized, specialized) and one genuine generative
LLM reference. Select the simplest candidate that meets both quality gates on all required
host strata. The maintainer approved this revised shortlist on 2026-09-30; it refines the
historical D approval without selecting a production winner. Benchmark option A is confirmed;
private sampling and processing remain gated. Superiority is plausible from specialization, not proven here.
Classify in a bounded local worker at ingestion/explicit backfill, cache labels, and keep model
loading/inference off dashboard polling. Optional runtime/assets need explicit installation,
integrity, license and lifecycle decisions; preserve the zero-dependency core CLI.

Embedded-model primary sources:

- O1: [ONNX Runtime Node CPU support](https://onnxruntime.ai/docs/get-started/with-javascript/node.html).
- O2: [Transformers.js](https://huggingface.co/docs/transformers.js/en/index).
- O3: [SetFit ONNX export tutorial](https://huggingface.co/docs/setfit/en/tutorials/onnx).
- O4: [MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).
- O5: [Model2Vec author project](https://github.com/minishlab/model2vec) and [Potion model](https://huggingface.co/minishlab/potion-base-8M).
- O6: [Laya origin model](https://huggingface.co/convaiinnovations/laya).
- O7: [Laya core README](https://github.com/NandhaKishorM/laya/blob/6d942c92081fbc139e736bbd9ac0023223c29b7f/README.md), including benchmark and honest-limit disclosures.
- O8: [Node wrapper](https://github.com/receptron/laya/blob/6478649e723122ca24bbf5fb69ed1010023c9750/src/laya.ts) and [ONNX bundle](https://huggingface.co/receptron/laya-onnx).
- O9: Stepanov et al. (2025), [GLiClass](https://arxiv.org/abs/2508.07662), research preprint.

## 8. Acceptance measurement and accuracy safeguard

The approved target is strict: Unknown Activity fraction < 0.10. Exactly 10% fails.
Current Unclassified and any equivalent rejection buckets contribute to the numerator.
Freeze denominator rules before evaluation: unique genuine logical sessions within the stated
source scope and time window, with imported-only copies/replays excluded under existing rules.
Actual sessions with unreadable, clipped, missing or insufficient activity evidence remain in
the denominator and Unknown numerator; do not select only classifiable sessions.
Report unavailable sources and unsampled cloud populations separately; a bounded observed
population is not a complete machine/account corpus.

Report the overall fraction, numerator/denominator, automatic versus user-supplied labels,
and breakdowns by host/surface, time period, taxonomy version and missing-evidence reason.
Use an independent consented population census when available plus a representative frozen
gold holdout. Synthetic fixtures test invariants but cannot establish the production <10% bar.
For sampled estimates, show confidence intervals and sampling weights; no pooled percentage
may conceal a failing high-volume host. Small strata remain unproven, never assumed passing.

Accuracy option A confirmed by the maintainer 2026-09-30: at least 95% correctness
among automatically accepted primary Activity labels on the independently adjudicated holdout,
with a one-sided 95% lower confidence bound at least 95%. Publish per-class precision/recall,
macro-F1, confusion matrix and risk/coverage curves so a dominant class cannot hide poor results.
Choose sample size from the precision requirement, cluster dependence and class support before
tuning; do not announce success from a handful of examples or a self-reported LLM confidence.
For multi-label outputs additionally report label-set precision/recall and supported-phase coverage.

Ground truth: written category rubric; two independent annotations on the gold set where
feasible; adjudicate disagreements; permit genuine ambiguity/insufficient evidence.
Freeze test labels before candidate selection. Keep parent/child/import/compression families,
near-duplicate prompts and source sessions in the same split; hold out recent sessions for drift.
Human corrections used in training are not subsequently counted as untouched test performance.
If evidence scarcity makes <10% impossible, the gate fails with exact causes and next action;
the requirement is neither waived nor met with invented categories.

Also measure re-finding success/time, title faithfulness/correction, cold/warm classification
latency, resource footprint, optional processing cost, redaction, and counter invariance.
Taxonomy/model upgrades require versioned caches, scoped rebuilding and rollback to the previous
classifier while preserving user labels and original source data. No automatic source edits.

## 9. Planning sequence, ownership, and open decisions

Design/ADR and data/quality contracts precede implementation. Then metadata/native-title vertical
slice, host normalization, consented benchmark, feature/candidate comparison, calibrated acceptance,
rendered retrieval evaluation and separately approved release. Existing #257 can ship its proven
source independently; future adapters are admitted one at a time with honest capability gaps.

Before dispatch, allocate exact paths for session vocabulary/observation, title policy, classifier
and tests; controller owns shared API/cache schemas, registry and dashboard integration. One writer
per worktree; two writing lanes plus controller and reviewer. Retained benchmark/source identity
must survive integration. Failed prerequisite stops dependent work.

| Decision | State / strongest recommendation |
| --- | --- |
| Organization B / meaningful titles | Approved; private sampling and generation still gated. |
| Unknown Activity <10% | Approved target; denominator/measurement protocol above proposed for review. |
| Accuracy safeguard A | Approved 2026-09-30: at least 95% automatic accepted-label correctness, supported by the independent holdout and stated statistical lower bound. |
| Algorithm approach | Revised shortlist approved 2026-09-30: compact specialized ONNX lead, Laya challenger, genuine LLM reference and RuVector semantic candidate; production selection awaits comparative evidence. |
| Benchmark method A | Approved 2026-09-30: representative real sessions plus separate difficult-case tests; same permitted evidence, family-disjoint splits and frozen evaluation for every candidate. Exact private access/processing and final dataset sizes remain gated. |
| Sizing A — 250-session pilot | Approved 2026-09-30: development pilot up to 250 unique genuine sessions in the most recent 120 days (window A with maintainer expansion); freeze exact cutoff/end timestamps and time basis at authorized collection. Exclude pilot families from final evaluation; propose final sizes afterward. Pilot is not release proof; shortfalls require a proposed extension, never automatic widening. |
| Allocation A | Approved 2026-09-30: stratify by available host, repository/non-repository context and current classification state; ensure host representation, then allocate remaining slots by observed volume. Exact quotas follow source inventory. Retain selection probabilities/weights; separate challenge oversampling from prevalence estimates and disclose absent hosts. |
| Pilot annotation A | Approved 2026-09-30: human-first labels without candidate predictions, blind independent second review of a random subset and ambiguous cases, then adjudication; preserve Unknown/disagreements and correction reasons. Reviewer assignment and subset size remain concrete preflight items; no private reads or model calls authorized. |
| Reviewer assignment A | Approved 2026-09-30: maintainer supplies primary human labels; a nominated second human performs blind subset review. Second reviewer and subset size are unassigned. This work is deferred to M3, not an M1/M2 blocker. |
| Taxonomy B / provisional rubric | Approved 2026-09-30: primary/secondary Activity, broad families/detail, independent Topics and provisional definitions. Refine on development examples, then freeze before final evaluation; no weakened metrics or implicit consumer-chat coverage. |
| Private-content policy A | Approved 2026-09-30: metadata/native titles plus initial substantive user request and up to two clarifications; 8,000-character total excerpt ceiling, local processing, no automatic expansion. No assistant/tool bodies, injected/imported/replayed context or external transmission. Exact roots and inspection execution remain gated. |
| Retention A | Approved 2026-09-30: private versioned benchmark containing only permitted bounded excerpts, reviewed labels and source references, outside tracked repository content; restrict local access and exclude excerpts from public outputs. Retain until separately approved cleanup. Exact storage location and dataset creation remain gated. |
| Source scope A | Approved 2026-09-30: current Claude Code, Codex and OpenCode readers across repository and non-repository work; Cowork/Hermes/cloud-only/future sources remain explicit gaps until their observation contracts are verified. Resolve overrides and approve an exact source allowlist before excerpt reads; no broad home search or guessed database selection. |
| Title/model processing | Approve exact backend, fields, bounds, retention and budget separately; benchmark content-policy approval does not authorize generation, training or provider calls. |
| Backend/model/dependencies | No choice made; verify real capability, licenses and measured benefit before selecting. |
| User corrections | Local override recommended; training/feedback opt-in is a separate decision. |

No compatibility command aliases or redirects to retired commands are proposed. Current
instructions use supported commands; historical receipts keep their original wording. These
documentation changes do not adopt the two original primary-checkout drafts or change their bytes.

## 10. Primary sources

- R1: Dumais et al. (2003), [Stuff I've Seen](https://www.microsoft.com/en-us/research/wp-content/uploads/2003/01/siscore-sigir2003-final.pdf), SIGIR, contextual personal retrieval.
- R2: Yee et al. (2003), [Faceted Metadata for Image Search and Browsing](https://people.ischool.berkeley.edu/~hearst/papers/flamenco-chi03.pdf), CHI, faceted navigation.
- R3: Jones, Bruce and Dumais (2001), [Keeping Found Things Found on the Web](https://www.microsoft.com/en-us/research/publication/keeping-found-things-found-web/), CIKM, relevance context.
- R4: Maynez et al. (2020), [On Faithfulness and Factuality in Abstractive Summarization](https://aclanthology.org/2020.acl-main.173/), ACL.
- R5: Geifman and El-Yaniv (2017), [Selective Classification for Deep Neural Networks](https://papers.nips.cc/paper_files/paper/2017/hash/4a8423d5e91fda00bb7e46540e2b0cf1-Abstract.html), NeurIPS.
- R6: Guo et al. (2017), [On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html), ICML/PMLR.
- R7: Ratner et al. (2017), [Snorkel: Rapid Training Data Creation with Weak Supervision](https://www.vldb.org/pvldb/vol11/p269-ratner.pdf), PVLDB 11(3).
- R8: Tunstall et al. (2022), [Efficient Few-Shot Learning Without Prompts](https://arxiv.org/abs/2209.11055), research preprint, not a selected implementation.
- R9: Settles (2009), [Active Learning Literature Survey](https://burrsettles.com/pub/settles.activelearning.pdf), University of Wisconsin technical report; survey, not an agent-session experiment.
- H1: [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control), native title precedence and local execution.
- H2: [Codex app-server](https://learn.chatgpt.com/docs/app-server), names, previews, relationships and cwd.
- H3: [Codex environments](https://learn.chatgpt.com/docs/environments/modes), local/worktree/cloud modes.
- H4: [OpenCode server](https://opencode.ai/docs/server/), session metadata API.
- H5: [Hermes Agent sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions/), source platforms, native titles and compression lineage.
- H6: [Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview), execution and connected-resource distinctions.
- H7: [Cowork on web, desktop and mobile](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile), dated rollout and local/cloud continuity.
