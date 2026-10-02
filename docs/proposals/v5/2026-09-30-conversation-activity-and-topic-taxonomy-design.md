# Conversation Activity and Topic taxonomy

## Status

**Blocked** and deferred to M3: maintainer returned focus to remediation on 2026-09-30.
Execution authorization, exact sampling boundaries and consumer-chat observation contracts remain pending.
Research/documentation only, 2026-09-30; no private inspection, model execution, source ingestion,
implementation, commit or publication is authorized. The maintainer approved primary plus
secondary Activity structure, rejected the software/productivity-heavy vocabulary as incomplete,
then approved broader direction B on 2026-09-30: broad Activity families with meaningful detail
and a separate extensible Topic hierarchy. The annotation rubric below was approved as provisional
on 2026-09-30: refine boundaries with development examples and freeze before final evaluation.

This refines the [Sessions research/design](2026-09-30-session-organization-and-activity-design.md).
All prior privacy, source, retention, 8,000-character and accuracy/coverage decisions remain.
The initial benchmark source scope remains Claude Code/Codex/OpenCode artifacts; support for
ordinary Claude/ChatGPT conversations is a separate observation-source contract, not assumed
from a desktop application name. This M3 extension is not a new M1/M2 blocker.

## 1. Problem and evidence

Coding is one use of conversational systems. A classifier whose vocabulary centers on builds,
tests, releases and configuration can mislabel or reject ordinary advice, emotional reflection,
creative play, learning, household planning and open-ended discussion. Expanding only the number
of technical labels does not solve this ontology problem.

There are two different questions:

- Activity: what kind of interaction/work is the person engaging in?
- Topic: what is the conversation about?

Planning can concern a migration, a holiday, retirement or a wedding. Writing can concern code
documentation, fiction, a condolence letter or a job application. A repository association or
host does not determine either. Both axes permit more than one supported label.

Research read on 2026-09-30:

| Primary source | Relevant finding | Scope/limitation |
| --- | --- | --- |
| Chatterji et al., How People Use ChatGPT (2025) [R1] | Separates conversation topics from Asking/Doing/Expressing interaction purposes. | Consumer ChatGPT, not a universal coding-host taxonomy; working paper. |
| OpenAI Signals (updated 2026-08-06) [R2] | Tracks topic and interaction purpose separately; its individual data explicitly excludes Codex and enterprise usage. | Useful reminder that consumer and coding populations differ, not evidence of our corpus distribution. |
| Zhang et al., WildChat-AQA (EMNLP 2025) [R3] | Uses hierarchical topics/subtopics across real conversations; includes social/emotional and creative conversation. | Topics were model-derived and human agreement is imperfect; do not copy its labels as unquestioned gold or transfer aggregation accuracy. |
| Wan et al., TnT-LLM (KDD 2024) [R4] | Separates taxonomy development/refinement from scalable classifier assignment. | Supports reviewed hierarchy and compact downstream models; this project has not run its method. |

The NBER page/PDF returned HTTP 403 in this pass; the corresponding authors' OpenAI-hosted
working-paper PDF was successfully read. These are primary studies/design evidence, not
measurements of agentic-kit or proof that a particular model meets its gates.

## 2. Revised proposal: broad Activity families with meaningful detail

The following implement the approved broader direction; exact definitions remain a draft rubric:

| Activity family | Examples and possible detailed Activities |
| --- | --- |
| Learning & explanation | Tutoring, concept explanation, language practice, understanding a document |
| Research & discovery | Fact finding, literature review, investigating history/science/products |
| Advice & decision support | Compare personal options, career advice, choose a purchase or approach |
| Planning & preparation | Travel itinerary, household schedule, interview preparation, architecture/design |
| Creation & writing | Fiction, poetry, letters, documents, music/art ideas, drafting or revising prose |
| Building & practical execution | Software implementation, producing an artifact, performing a bounded practical task |
| Analysis & evaluation | Data analysis, interpreting evidence, critique, code/security review, test evaluation |
| Organization & transformation | File organization, summarizing, translating, extracting or reformatting information |
| Troubleshooting & improvement | Debugging, repair advice, refactoring, improving an existing process |
| Reflection & emotional support | Discuss feelings, journal, process an experience, seek encouragement |
| Conversation & social connection | Casual conversation, sharing experiences, open-ended social exchange |
| Entertainment & roleplay | Games, quizzes, fictional roleplay, interactive storytelling, playful exploration |
| Coordination & delegation | Assign tasks, manage dependencies, supervise a workflow |

Definitions need positive/negative examples and boundary rules. For example, expressing grief
is not automatically Advice; learning about grief is not automatically Emotional support.
Drafting a poem is Creation, while discussing why a poem matters can be Analysis or Reflection.
Do not infer the person's mental state, diagnosis, employment, finances or identity from topic.

Coding remains detailed: implementation, debugging, testing, code review, security review,
refactoring, dependency upgrades, release/CI, setup/configuration and orchestration can be
preserved as defined detailed Activities. These are not the universal top-level menu, nor are
they replaced by an uninformative label such as Doing. Choose primary and supported secondary
Activities using explicit intent/context, never claim actual completion from a request.

## 3. Independent Topic hierarchy

Candidate top-level topic coverage:

| Topic group | Example subtopics |
| --- | --- |
| Software & computing | Programming, AI systems, security, developer tools, devices |
| Science & engineering | Mathematics, biology, physics, engineering, scientific methods |
| Education & learning | Studying, teaching, language learning, examination preparation |
| Business & organizations | Strategy, operations, entrepreneurship, management |
| Work & careers | Job applications, interviews, professional development, workplace situations |
| Money & economics | Budgeting, consumer purchases, economic questions, investing discussions |
| Health & wellbeing | Health information, exercise, nutrition, wellbeing practices |
| Relationships & family | Parenting, friendship, relationships, family matters |
| Everyday life & home | Cooking, household maintenance, chores, daily routines |
| Travel & places | Itineraries, destinations, local information, geography |
| Arts & culture | Literature, music, film, visual arts, creative practice |
| Games, hobbies & sports | Gaming, crafts, recreation, sport, collections |
| History, society & politics | Historical events, institutions, current affairs, civic questions |
| Philosophy, religion & meaning | Ethics, philosophical questions, beliefs, purpose |
| Law & public services | Legal information, administrative processes, public services |
| Communication & language | Translation, communication practices, linguistic questions |
| Personal experiences | Explicitly shared experiences, autobiographical reflection |
| Other evidenced topic | A descriptive new-topic candidate requiring taxonomy review; not an Unknown escape hatch |

This is an illustrative extensible hierarchy, not an assertion of exhaustive coverage.
Topic candidates can be proposed from permitted sample evidence and reviewed before admission.
An optional bounded entity/topic phrase can preserve specific retrieval cues such as cancellation,
photosynthesis or birthday party. User labels remain distinguishable from inferred labels.
No automatic topic invention, clustering engine or unbounded knowledge graph is approved.

Example records:

| Session intent | Activity | Topic |
| --- | --- | --- |
| Help me understand photosynthesis | Learning → explanation | Science → biology |
| I need to talk through a difficult breakup | Reflection/support | Relationships |
| Plan a holiday within my budget | Planning; secondary decision support | Travel; secondary money |
| Let's play a detective story | Entertainment → roleplay | Fiction |
| Draft a condolence letter | Creation → writing | Relationships; communication |
| Explain the arguments about free will | Learning; possibly discussion | Philosophy |
| Diagnose why Windows tests fail, without changing code | Troubleshooting → diagnosis | Software → CI/testing |

Topic and Activity labels are private derived data. Expose only permitted fields on local views;
keep sensitive topic labels and phrases out of default public/export receipts. No user profiling,
demographic inference or clinical interpretation is part of this feature.

## 4. Coverage, model and measurement consequences

Current Usage source code consumes Claude project transcripts, Codex session artifacts and a
selected OpenCode store ([usage-index](../../../src/lib/usage-index.mjs)). Ordinary Claude chat
and ordinary ChatGPT conversations are not proved covered by those readers. A declared Desktop
surface in a coding artifact does not establish ingestion of all conversations in that app.
Design consumer-chat adapters or sanctioned imports separately, prove ownership/identity and
completeness, and obtain exact-source permission; no account scraping or guessed private APIs.

Model input and sample strata must include conversational and personal work, not just coding.
The initial measured population remains its approved source scope. Synthetic consumer-chat
examples test rubric behavior but do not prove real consumer-session coverage/accuracy.
An expanding label hierarchy remains versioned, with reviewed changes and a frozen benchmark.

The below-10% Unknown Activity and >=95% accuracy requirements remain. Freeze useful evaluation
granularity before tuning. Report broad family and detailed Activity correctness/coverage
separately; do not claim success by collapsing everything into Asking/Doing/Expressing.
Unknown Topic is a separate diagnostic and cannot be counted as known Activity or hidden.
Discuss exact Topic accuracy/coverage targets separately rather than silently inventing them.

A hierarchy permits small bounded classification heads, but wrong parent selection can exclude
the right child. Evaluate end-to-end leaf performance and supported secondary labels; local
node accuracy is insufficient. Do not pass all topic/subtopic names into one oversized Laya
choice question or multiply self-reported probabilities and call the result calibrated.
Compare compact supervised heads, permitted typed-decision models and LLM references on the
same evidence; taxonomy breadth cannot be an excuse to waive the accepted accuracy gate.

## 5. Options and next decision

| Option | Scope | Assessment |
| --- | --- | --- |
| A | Keep the fifteen software/productivity labels and add a generic Conversation bucket | Too coarse; hides the variety the maintainer wants to re-find. |
| B — recommended | Broad Activity families with meaningful detailed Activities, plus an independent extensible Topic hierarchy | Covers conversational and technical use without mixing purpose with subject. Requires rubric and source-contract review. |
| C | One large flat label list mixing work type and subject | Produces overlapping labels and increasing model/token/maintenance burden. |

B direction approved 2026-09-30: broad Activity families, useful detail and independent Topics.
Exact definitions, label migration and consumer-source implementation remain proposed. Preserve current
labels/evidence during a versioned transition, with explicit mappings where justified; no new
aliases to retired commands. Update affected ADR/DDD/API contracts in the eventual implementation.

## 6. Approved provisional annotation rubric

Classify the interaction's evidenced purpose within the permitted sampled user-request context,
not presumed completed work across unread history. Native titles and structured observations
are supporting evidence; host, folder, skill invocation and tool count cannot set purpose alone.
Every label carries its evidence basis and observation window. A session's requested Activity
and its verified execution state remain separate facts.

| Family | Include when the user seeks | Exclude / distinguish |
| --- | --- | --- |
| Learning & explanation | Understanding, guided practice, conceptual clarification or tutoring | Finding new sources/evidence is Research; entertaining quiz play without a learning goal is Entertainment. |
| Research & discovery | Source gathering, factual investigation, literature/product discovery or an evidence survey | Explaining a known concept is Learning; diagnosing a specific malfunction is Troubleshooting. |
| Advice & decision support | A recommendation, weighing choices or help deciding what to do | A factual comparison without requested judgment is Research; a concrete schedule/sequence is Planning. |
| Planning & preparation | A plan, design, itinerary, strategy or preparation for an anticipated activity | Carrying out that plan is Building/execution; merely choosing among alternatives is Advice. |
| Creation & writing | Composing/revising prose or producing a creative concept, story, letter, script or artistic specification | Faithful translation/extraction/reformatting is Transformation; interactive play is Entertainment. |
| Building & practical execution | Constructing/extending working software, a functional artifact, or carrying out a bounded practical task | Producing prose is Writing; changing an existing faulty system is Troubleshooting; scope-only design is Planning. |
| Analysis & evaluation | Interpreting data, assessing quality, testing behavior or critically reviewing an artifact/argument | Diagnosis of a malfunction is Troubleshooting; collecting sources is Research. |
| Organization & transformation | Sorting, classifying, extracting, summarizing, translating or faithfully restructuring provided information/files | New substantive composition is Writing; interpreting patterns/results is Analysis. |
| Troubleshooting & improvement | Diagnosing/repairing a fault, refactoring, maintenance or improving an existing process | Diagnosis qualifies without edits; creating a new capability is Building; proposing future strategy is Planning. |
| Reflection & emotional support | Processing explicitly shared feelings/experiences, journaling, encouragement or supportive discussion | Health facts are Learning/Research; explicit action recommendations are Advice; do not infer a diagnosis. |
| Conversation & social connection | Reciprocal social exchange, casual chat or sharing without a clearer task/support/play objective | A question is not automatically social chat; use the more specific evidenced purpose when present. |
| Entertainment & roleplay | Play, humor, fictional enactment, interactive storytelling or recreation | A standalone commissioned story is Writing; a quiz expressly used to teach is Learning. |
| Coordination & delegation | Assigning work, managing dependencies, arranging handoffs or supervising a workflow as the objective | Using workers to build a feature does not make Coordination primary; method and goal remain separate. |

Purpose precedes subject. For example, relationships may appear in Research, Advice, Reflection
or Writing. An engineering topic can appear in Learning, Planning or Entertainment. Topic
mentions must not change the Activity. Topic labels describe discussed subject matter, never
personal status, beliefs, diagnosis or demographics. Explicit user topic labels can override
inferred ones, with their source retained.

Primary-selection rules:

1. Identify the substantive user objective; exclude context boilerplate, quoted instructions,
   imported/replayed requests, and merely hypothetical examples.
2. Apply explicit scope corrections in the sampled clarification messages. A correction such
   as research only replaces an earlier implementation request for this observation window.
3. Prefer the specific detailed Activity supported by the objective. If one task is explicitly
   instrumental to another, the requested end goal is primary and the supported subtask secondary.
4. For coequal objectives, use a user-stated priority. Without one, request annotation adjudication
   and retain unresolved primary ambiguity rather than choosing by keyword count, first mention
   or assumed time spent. Supported secondary labels do not erase Unknown primary status.
5. Do not add secondary Activities from domain vocabulary, boilerplate, conditional future work
   or assistant claims. Use only substantive activities actually expressed in the permitted evidence.
6. A family-level label with unsupported detail is explicitly partial. Freeze the useful scored
   granularity before evaluating the <10% / >=95% gates; broad labels cannot silently replace it.

Detailed coding labels remain available under the general families:

| Detailed Activity | Family | Distinction |
| --- | --- | --- |
| Architecture/design | Planning | Requested specification/approach, not code delivery |
| Implementation | Building | New working capability |
| Debugging/repair | Troubleshooting | Diagnose/correct malfunction; edits are not required |
| Refactoring | Troubleshooting/improvement | Improve structure while preserving behavior |
| Dependency maintenance | Troubleshooting/improvement | Upgrade/reconcile existing components |
| Setup/configuration | Building/practical execution | Establish or wire an environment; repair of broken setup instead uses Troubleshooting |
| Release/CI operations | Building/practical execution | Package/publish/deploy or run delivery workflow; designing a pipeline is Planning |
| Testing/QE | Analysis/evaluation | Explicit verification/test objectives, including test-artifact creation in service of evaluation |
| Code review | Analysis/evaluation | Critique code/change quality |
| Security review | Analysis/evaluation | Assess security/control risks, not infer security intent from a product name |
| Technical documentation | Creation/writing | Produce/revise reader-facing technical prose |
| Workflow orchestration | Coordination | Coordination itself is the requested deliverable |

Borderline examples for annotation and model tests:

| Request | Proposed primary | Secondary / limit |
| --- | --- | --- |
| Explain grief and its common stages | Learning → explanation | Topic wellbeing; no claim that the person is grieving |
| I am grieving and want someone to talk to | Reflection/support | Topic personal experience; not a clinical classification |
| Write a poem about grief | Creation → poetry | Not emotional support solely because of topic |
| Help me choose between two jobs | Advice → decision support | Topic careers; explicit criteria can support Analysis secondary |
| Gather salary data for these jobs, no recommendation | Research → evidence gathering | No Advice label |
| Teach me fractions using a quiz | Learning → tutoring | Play is the method, not primary Entertainment |
| Let's play a trivia quiz for fun | Entertainment → game | No assumed educational objective |
| Implement a parser and add regression tests | Building → implementation | Testing secondary, because it supports the explicit deliverable |
| Diagnose the parser failure; do not change files | Troubleshooting → diagnosis | No Implementation label |
| Design a parser; before any coding, get my approval | Planning → design | Future coding is not current secondary Implementation |
| Summarize this article without adding interpretation | Transformation → summary | No Analysis label |
| Assess whether this article's argument is convincing | Analysis → critique | Not Summary merely because reading is involved |
| Earlier I asked for a fix; now research only | Research → investigation | Preserve original scope historically; classify the corrected sampled objective |

The maintainer approved these judgments as a provisional rubric on 2026-09-30, not as model
outputs or gold labels for unseen sessions. Refine difficult boundaries on development examples,
retain genuine disagreement and freeze the rubric before final evaluation. Any later change
invalidates affected evaluation claims; benchmark exposure cannot guide tuning. No private
corpus was read to produce this rubric, and approval does not authorize private-data reads.

Sizing option A approved 2026-09-30 with a pilot expanded to up to 250 unique genuine sessions.
Use pilot evidence for development/rubric refinement and annotation-effort estimation only.
Exclude pilot sessions and their related families from untouched final evaluation. Propose
training, calibration and final-test sizes afterward using precision and host/class support.
Disclose unavailable strata or a shortfall below the pilot cap; do not silently substitute
duplicates, fabricated records or other populations. Window option A approved 2026-09-30 with
maintainer expansion to the most recent 120 days. Freeze the exact cutoff/end timestamps,
timezone and timestamp eligibility rule at authorized collection; disclose missing timestamps.
If fewer than 250 eligible sessions exist, report the shortfall and seek an explicit extension;
never automatically widen the window or source scope. Older-format cases remain a separate
regression set and do not become population-prevalence evidence.

Allocation A approved 2026-09-30: ensure each available approved host is represented, then
allocate remaining pilot slots according to observed source volume. Stratify additionally by
repository/non-repository context and current classification state. Freeze quotas and random
selection rules/seed after inventory, before inspecting excerpts; retain inclusion probabilities
and related-session grouping. Separate or weight deliberate Unknown/difficult-case oversampling
when estimating population rates. Publish per-host results and source gaps; do not substitute
an absent host or imply consumer-chat coverage from a coding-artifact source.

Pilot annotation A approved 2026-09-30: a human uses the provisional rubric and permitted
excerpts without seeing candidate predictions. A second human independently labels a random
subset and ambiguous cases without seeing the first person's labels or model predictions;
adjudicate differences and preserve both initial judgments, Unknown and correction reasons.
Reviewer assignment and subset size are preflight items. Model consensus is not human gold,
and approved annotation policy does not authorize private-data reads or model calls.
Reviewer assignment A approved: maintainer is primary human annotator; a nominated second human
performs blind subset review. That second reviewer is not yet assigned. All annotation is deferred
to M3; no further classification policy questions block older remediation or execution readiness.

## 7. Primary references

- R1: Chatterji et al. (2025), [How People Use ChatGPT](https://cdn.openai.com/pdf/a253471f-8260-40c6-a2cc-aa93fe9f142e/economic-research-chatgpt-usage-paper.pdf), authors' working paper.
- R2: [OpenAI Signals individual data](https://openai.com/signals/data/), updated 2026-08-06, consumer sample and separate topic/purpose axes.
- R3: Zhang, Kim and Deng (2025), [From Chat Logs to Collective Insights](https://aclanthology.org/2025.emnlp-main.1667/), EMNLP, WildChat-AQA hierarchy and evaluation.
- R4: Wan et al. (2024), [TnT-LLM](https://www.microsoft.com/en-us/research/publication/tnt-llm-text-mining-at-scale-with-large-language-models/), KDD, taxonomy refinement and label assignment.
