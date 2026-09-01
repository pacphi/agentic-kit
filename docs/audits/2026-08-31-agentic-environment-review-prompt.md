# Agentic Environment Review — Original Request

Audit date: 2026-08-31
Status: verbatim initiating request plus owner-supplied scope clarifications
Published outputs: [review](./2026-08-31-agentic-environment-review.md) and
[method](./AGENTIC-ENVIRONMENT-REVIEW-METHOD.md). The record-level inventory remained a
local audit work product because it contains machine and project topology metadata.

## Initiating request

The following is the original user prompt, preserved verbatim.

~~~text
ROLE: You are Boris Cherny, creator and Head of Claude Code at Anthropic, chairing a cross-ecosystem technical design review of my agentic development environment.

Use current public engineering practices from Anthropic/Claude Code, OpenAI/Codex, Google/Gemini, Microsoft/GitHub Copilot, and respected agent/evaluation practitioners. Do not assume one vendor's conventions apply to another.

CONTEXT: I use Claude, Codex, OpenCode, Hermes, and Gemini across multiple software projects. I have accumulated user/home-level and project-level skills, commands, agents, instruction files, plugins, MCP/tool configuration, and related agent scaffolding.

Some assets are mine. Some came from third-party marketplaces/plugins. Some may be locally modified. I also maintain https://github.com/pacphi/agentic-kit, which audits prompts from host sessions and produces advice. Treat that as behavioral evidence when available, but focus this review on the artifacts/configuration that may be causing those patterns.

This is a recurring health check, so detect changes since the previous run whenever a prior snapshot exists.

REQUEST: Perform a read-only Agentic Environment Review.

1. DISCOVER
- Detect installed client versions, configured/default models, relevant capabilities, config locations, plugin/marketplace systems, and project roots.
- Discover locations from the installed clients themselves where possible; do not blindly assume paths.
- When internet access exists, check current official documentation/release notes against the versions actually installed. Record evidence and dates rather than relying on memory.

2. INVENTORY
Create a canonical inventory of every relevant skill, command, agent, instruction/rule file, plugin, MCP/tool configuration, and reusable prompt asset.

For each record capture:
host/client | version | project/home scope | artifact type | path | provenance | upstream source/version | local modifications | applicable model(s) | overlapping/overriding artifacts

3. REVIEW
Inspect for:
- stale or model-sensitive instructions
- duplicated or contradictory guidance
- excessive permanent context
- global rules that belong at project scope
- project rules that should become shared capabilities
- instructions newer models no longer need
- workarounds replaced by native client capabilities
- ambiguous tool/agent boundaries
- unnecessary agent proliferation
- missing validation or feedback loops
- security/permission problems
- poor portability between hosts
- marketplace assets diverging from upstream
- patterns in agentic-kit history that correlate with specific configuration

Do not reward complexity. Prefer deleting, consolidating, narrowing, or making behavior mechanically enforceable when that is stronger than adding instructions.

4. COACH
For every material finding give me:

EVIDENCE — exact artifact/path and observed behavior
WHY IT MATTERS — expected effect on agent behavior
DIAGNOSIS — root cause, not symptom
ACTION — KEEP / TUNE / MOVE / CONSOLIDATE / REPLACE / DELETE / UPSTREAM
SCOPE — global, host-specific, or project-specific
CONFIDENCE — high / medium / experimental
VALIDATION — smallest test that proves the change helped

Separate recommendations into:
A. Cross-project improvements
B. Host-specific improvements
C. Project-specific improvements
D. Version/model drift
E. Third-party/upstream opportunities

5. PATCH STRATEGY
For changes I control, provide minimal unified diffs but do not modify files without approval.

For third-party assets, distinguish:
- safe local override
- maintain a local patch
- fork warranted
- upstream bug/feature request
- upstream PR warranted

When recommending upstream work, draft the technical rationale and minimal change the maintainer could accept.

6. REGRESSION SYSTEM
Propose a small reusable eval suite based on representative work from my real projects and, where useful, patterns from agentic-kit history.

Use it to detect whether a client/model/plugin upgrade changes:
- instruction adherence
- task completion quality
- unnecessary tool calls
- context/token waste
- autonomy/recovery behavior
- correctness
- review burden

Avoid expensive benchmarking unless the evidence justifies it.

7. PERIODIC REPORT
Finish with:

EXECUTIVE COACHING BRIEF — the 5 things I should care about most
WHAT CHANGED — differences from the previous audit
ENVIRONMENT MAP — concise inventory summary
TOP CORRECTIONS — highest-leverage changes
MODEL/CLIENT DRIFT — newly obsolete or newly useful practices
CONSOLIDATION OPPORTUNITIES — what can disappear or become canonical
UPSTREAM OPPORTUNITIES — marketplace/plugin fixes worth contributing
PROJECT COACHING — recommendations by repository
PATCH QUEUE — ordered, reversible changes
EVAL PLAN — how to verify improvements
WATCHLIST — things to reassess after the next client/model release

Every recommendation must be tied to evidence. Clearly distinguish measured behavior, documentation-backed guidance, and your hypothesis.

Optimize for a system that becomes simpler and more reliable after every audit—not one that accumulates more instructions.

QUESTION: Please ask any clarifying questions
~~~

## Scope clarifications

The following owner response is preserved verbatim because it materially defined the
audit population, host interpretations, output format, credential-inspection authority,
and baseline status.

~~~text
1 - Any and all projects that are reported as having been worked with by sessions history and where they are presently located on filesystem - may take some discovery. 2 - yes to both distros. 3 - a report with citations is exactly what we're after. In fact I think we're looking to document an approach for how we do this consistently, repeatably, with high confidency and accuracy, and grounded each time in spite of or maybe because or a tool or model upgrade. 4 - yes. 5 - no previous audit. Looking for you to do some web research, perhaps others in opensource and r&fd community are doing somethign like this. We want to be systematic and methodical.
~~~

The numbered answers were applied as follows:

1. Include every surviving filesystem project evidenced by available session history.
2. Interpret Hermes as NousResearch Hermes Agent and Gemini as the official Google
   Gemini CLI.
3. Produce a cited report and a reusable, upgrade-resilient audit method.
4. Permit credential-bearing configuration inspection with strict value redaction.
5. Treat this run as the first completed audit and research comparable public practice.
