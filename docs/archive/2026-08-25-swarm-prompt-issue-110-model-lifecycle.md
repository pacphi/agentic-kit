# Issue #110 Model Lifecycle Swarm Execution Prompt

Paste the following prompt into a new session:

```text
Continue the full implementation of GitHub issue #110 in:

/Users/cphillipson/Development/active/ai/agentic-kit

Take ownership of the work and execute it end-to-end with a dependency-aware Ruflo swarm or coordinated team of specialized subagents. Do not stop after analysis, brainstorming, or planning.

CURRENT STATE

- Continue on the branch that is checked out when the session begins.
- Expected branch: feat/110-model-lifecycle-intelligence
- Existing PR: #179
- Do not create another branch or duplicate PR.
- Do not rebase, reset, force-push, or rewrite existing history.
- Preserve all user and unrelated changes.
- Inspect the branch, worktree, issue, PR discussion, commits, CI, and existing implementation before making changes.
- Treat any previously reported HEAD as informational; determine the exact current HEAD yourself.
- Commit logical units of work continuously to the current branch.
- Push the completed branch and update PR #179.
- Do not merge the PR unless explicitly instructed.

MANDATORY PROJECT PROCESS

Read the repository AGENTS.md and all applicable nested instructions first.

Use the real installed RuvNet tools for capabilities they own:

- Ruflo for swarm orchestration.
- AgentDB/Ruflo memory for decisions and continuation state.
- SPARC for specification, pseudocode, architecture, refinement, and completion.
- Agentic-QE for test generation, coverage, quality scoring, and validation.
- MetaHarness/red-blue tooling for adversarial or security validation when available.
- frontend-design and accessibility disciplines for the Models UI.

Do not silently substitute generic agents or hand-written imitations for installed RuvNet capabilities. Call search_ruvnet before asserting what a RuvNet tool supports. If a required real tool is unavailable, state that explicitly and use the safest fallback without stalling the project.

Use a hierarchical-mesh, anti-drift topology. Parallelize independent work aggressively, but respect the dependency graph and exclusive file ownership.

Before coding:

1. Inspect GitHub issue #110 in full, including comments and acceptance criteria.
2. Inspect PR #179, its discussion, review findings, commits, and checks.
3. Inspect the current Models page and reproduce the reported usability problems.
4. Read the relevant code, tests, fixtures, documentation, DDD model, and ADRs.
5. Read at minimum:
   - docs/adr/0032-model-lifecycle-intelligence.md
   - ADRs covering the dashboard, usage evidence, host adapters, OpenCode, and provider provenance
   - relevant DDD, API, user-facing, operational, and supporting documentation
6. Search project memory for earlier decisions and persist new decisions throughout the work.
7. Establish a clean baseline with the relevant test and quality commands.

LIVING ADR RULE

ADRs are living implementation plans, not immutable historical artifacts.

For every relevant ADR:

- Record its current Status and Updated date before implementation.
- Compare its concrete claims with the current code.
- Report any precise claim/code mismatch.
- Reconcile the ADR and implementation.
- Update Status, Updated date, and implementation notes when this work changes the ADR’s implementation state.
- Add a new ADR only when the decision is genuinely new and architectural.
- Keep DDD, API, developer, operational, and user-facing documentation synchronized with delivered behavior.

PRODUCT OUTCOME

The existing Models page exposes storage and evidence vocabulary instead of answering operator questions. Redesign it around these questions:

1. Which models am I actually using?
2. Which activities and routes use each model?
3. What can each model do?
4. What are its limits and costs?
5. Which models or routes require action?
6. How fresh and trustworthy is the evidence?

The page must no longer make internal identifiers, hashes, binding IDs, evidence IDs, or scope fingerprints the primary user experience.

REQUIRED INFORMATION ARCHITECTURE

Design and implement a useful operator-focused page containing:

1. Summary/KPI area
   - Routes needing attention
   - Models in use
   - Source health and freshness
   - Refresh status, partial failures, and stale sources

2. Needs attention
   - Human-readable model and route names
   - Affected activities
   - Current and recommended replacement
   - Reason the action is required
   - Appropriate user action or documentation link

3. Your routes
   - This is the primary operational table.
   - Recommended default columns:
     Model | Access path | Used for | Last used | Capabilities | Cost | Lifecycle
   - Show primary/fallback position in human terms.
   - Show lifecycle and migration impact clearly.
   - Do not show internal IDs in ordinary rows.

4. Catalog explorer
   - Separate from operational models.
   - Collapsed or lazy-loaded by default.
   - Clearly distinguish catalog availability from configuration, entitlement, routability, and observed use.
   - Do not mix hundreds of catalog-only entries into the primary operational table.

5. Source coverage
   - Explain which facts each source exposes.
   - Distinguish unknown, not exposed, not checked, stale, failed, and unavailable.
   - Explain partial refresh failures in plain language.

6. Model detail drawer or equivalent progressive disclosure
   - Human name, selector, family, maker, and access path
   - Primary and fallback activities
   - Configured versus observed use
   - First/last use, session count, responses, tokens, cache tokens, and spend where evidenced
   - Context and output limits
   - Input/output modalities
   - Tool calling and structured-output support
   - Reasoning support, choices, default, and selected level
   - Temperature, variants, service tier, and relevant capabilities
   - Lifecycle, replacement, and migration impact
   - Evidence source, freshness, provenance, and limitations
   - The detailed evidence-state matrix may live here, not in the primary table

IDENTITY AND PRIVACY POLICY

Remove internal hashes and opaque references from normal user-facing presentation.

Use these patterns:

- Public model: human name, copyable selector, verified source links.
- Private or unverified identity: “Private Codex model,” “Custom OpenCode deployment,” or another honest semantic label.
- Consumer: “Implementation · primary” or “Testing · fallback 1.”
- Evidence: “Codex catalogue · refreshed 12 minutes ago.”

Internal hashes may remain as hidden API keys or DOM identifiers but must not leak through visible labels, links, accessible names, tooltips, copy actions, logs, exports, or errors.

Do not infer a public model identity from an opaque ID.

Investigate whether an exact, authoritative host catalogue match is enough to retain a human name even when a model is hidden. Handle injected/custom catalogue entries defensively. Document the resulting proof rule.

Consider an optional session-only “Reveal private names” control:

- Off by default
- Never persisted
- Never logged
- Clear privacy warning
- Implement only if architecture, security, and UX review determine it is safe and valuable

FILTERING, SORTING, LAZY LOADING, AND SCROLLING

The host inventory/catalog must:

- Lazy-load data that is not needed for the initial operational view.
- Have a restricted height with an internal vertical scroll region.
- Preserve usable sticky headers where appropriate.
- Avoid forcing the entire page to grow with the inventory.
- Support ascending and descending sorting by every meaningful column.
- Be fully keyboard operable.
- Preserve focus and announce sort/filter changes accessibly.

Use meaningful, facet-counted filters:

- View: In use, Configured, Recently observed, Needs attention, Available, Local
- Activity
- Access path
- Model family
- Primary/fallback role
- Capability
- Context-window band
- Price band
- Lifecycle
- Last-used range
- Source freshness

Search should match human name, selector, family, and activity. Private matching may happen internally, but the response must remain privacy-preserving.

Rename misleading concepts:

- “Serving provider” should normally become “Access path.”
- “Publisher” should become “Model maker” only when independently proven.

Hide or disable facets with fewer than two meaningful values. Do not render empty or misleading filter controls.

SOURCE DISCOVERY AND ENRICHMENT

Preserve independent evidence facts. Do not collapse configuration, discovery, entitlement, policy, routability, and observed use into a single inferred truth.

Codex:

- Prefer the stable app-server model/list source, with an appropriate cache fallback.
- Surface supported fields such as human description, visibility/default state, reasoning choices and descriptions, input modalities, personality support, multi-agent version, service tiers/default tier, upgrade guidance, context limits, and supported capabilities when actually present.
- Do not equate a Codex subscription catalogue with OpenAI API availability, entitlement, pricing, or routability.

Primary references:
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/model.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/models.json

Claude:

- Use status-line JSON where appropriate for actual model ID/name, context usage, effort, thinking, cost, and rate limits.
- Use settings/configuration for alias resolution, defaults, custom names/descriptions/capabilities, managed allowlists, and gateway discovery.
- Use transcripts for observed use.
- Treat Anthropic /v1/models as API visibility, not Claude Code subscription entitlement.

Primary references:
- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/model-config
- https://platform.claude.com/docs/en/api/models/list

OpenCode:

- Preserve available human name, family, description, capabilities, limits, costs, status, variants, knowledge cutoff, update date, open-weights status, reasoning options, structured output, cache pricing, provider display name, and documentation link.
- Credential presence may be shown safely but does not prove model entitlement.
- A configured model list does not prove a successful inference request.

Primary references:
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/providers

Models.dev:

Support and preserve the current schema where relevant, including provider identity/documentation/environment hints and model attachment, cost, description, family, knowledge, update date, limits, modalities, open-weights, reasoning, reasoning options, release date, lifecycle status, structured output, temperature, and tool-calling fields.

Treat this as public metadata, not entitlement or routability evidence.

Primary reference:
- https://github.com/anomalyco/models.dev/blob/dev/README.md

Ollama:

- Prefer /api/tags for installed model name, size, modified date, digest, format, family, parameter size, and quantization.
- Use /api/show for bounded/safe model metadata such as license summary, capabilities, model information, context, and parameters.
- Use /api/ps for loaded state, memory/VRAM, active context, and expiry.
- Do not retain raw templates, unbounded model cards, or full license bodies when a safe summary/link is sufficient.
- Installed or loaded does not prove successful inference.

Primary references:
- https://docs.ollama.com/api/tags
- https://docs.ollama.com/api-reference/show-model-details
- https://docs.ollama.com/api/ps

Hugging Face:

- Enrich only when there is exact repository proof.
- Online lookup must be explicit.
- Useful fields include license, base model, task, library, languages, model card, and newer version.
- Never manufacture a Hugging Face link from a similar-looking model name.

Primary reference:
- https://huggingface.co/docs/hub/main/en/model-cards

Direct provider/gateway APIs:

- Optional and explicit online /v1/models lookups may prove credential-visible API models.
- They do not prove host subscription entitlement or a successful request.

ORDINARY READ AND REFRESH SEMANTICS

- Normal dashboard reads must remain cache-only and offline.
- Normal page rendering must not create network egress or consume inference tokens.
- Refresh must be explicit and say which sources it contacts.
- Refresh failures must retain valid cached facts and report partial coverage honestly.
- Never perform inference probes merely to populate the dashboard.
- Never scrape interactive model pickers.
- Public catalogue presence is not entitlement or routability.
- Local installation is not successful inference.
- Unknown must remain unknown when the source does not provide proof.

WEB RESEARCH AND VERSION VALIDATION

Research all provider/model/source contracts against primary official documentation as of August 2026.

For newly introduced dependencies:

- Prefer no new runtime dependencies; this project is intentionally zero-runtime-dependency.
- If a dependency is genuinely necessary, verify the latest compatible release as of August 2026 using official registries, release notes, and primary documentation.
- Record the compatibility reasoning and rejected alternatives.
- Apply the same freshness requirement to model names, aliases, lifecycle information, source schemas, and model-lookup validation.
- Do not rely on remembered model lists or stale secondary articles.
- Cite the exact authoritative sources in ADRs and supporting documentation.

SWARM AND DEPENDENCY PLAN

Have the coordinator create a dependency graph and exclusive ownership matrix before allowing edits.

Suggested execution waves:

Wave 0 — coordinator baseline

- Inspect branch, issue, PR, code, tests, ADRs, DDD, documentation, and project memory.
- Reproduce the problems.
- Define acceptance criteria, domain language, privacy rules, source-proof rules, and API contracts.
- Identify changed files and assign exclusive ownership.
- Persist the plan and decisions.

Wave 1 — parallel read-only architecture and design

- Domain/architecture agent:
  DDD, source boundaries, evidence semantics, projections, refresh behavior, ADR drift.

- Product/UX/frontend/a11y agent:
  Information architecture, filters, table/drawer interaction, responsive behavior, keyboard model, scroll behavior, and accessible states.

- Source/provenance/privacy agent:
  Provider contracts, proof strength, identity protection, online/offline boundaries, source freshness, and August 2026 research.

- Test/QE agent:
  Risk model, strict-TDD sequence, fixtures, contract tests, privacy tests, browser flows, accessibility, compatibility, and quality gates.

Gate 1:

- Coordinator synthesizes findings.
- Resolve architectural conflicts.
- Freeze domain and API contracts.
- Update the ownership matrix before implementation.

Wave 2 — parallel implementation

Use exclusive, non-overlapping file sets:

- Codex and Claude collectors/normalizers
- OpenCode, Models.dev, Ollama, Hugging Face, and generic provider collectors/normalizers
- Domain model, evidence projection, query/filter/facet logic, and API
- UI components, page behavior, styling, lazy loading, scrolling, sorting, filters, and accessibility
- Tests may run concurrently only in separately assigned test files
- Documentation may begin with non-conflicting drafts, but final behavior documentation waits for stable contracts

Dependency rules:

- Domain and API contracts precede collector and projection integration.
- Projection/API behavior precedes final UI integration.
- UI scaffolding may proceed against agreed fixtures.
- Documentation finalization follows verified behavior.
- Integrators must not overwrite another agent’s work in the shared filesystem.
- Agents must communicate findings when blocked instead of editing outside their assigned scope.

COLLISION PREVENTION

The coordinator must maintain a live table containing:

Agent | Responsibility | Allowed file globs | Dependencies | Status | Commit

Rules:

- No two agents edit the same file concurrently.
- Every agent checks git status before editing and committing.
- Agents stage only their explicitly owned paths.
- Agents never commit another agent’s files.
- Avoid repository-wide formatting or mechanical rewrites during parallel work.
- Shared files are changed only by the coordinator/integrator after contributing agents finish.
- Keep existing files under approximately 500 lines by extracting cohesive modules where appropriate.
- Validate input at boundaries.
- Never commit secrets or .env files.
- Do not add Co-Authored-By trailers unless repository settings explicitly require them.

STRICT TDD AND QUALITY

For each behavioral unit:

1. Write or identify a failing test.
2. Implement the minimum behavior.
3. Refactor while green.
4. Commit the test and implementation together where practical.

Required coverage includes:

- Parser and normalization unit tests for every source
- Production-shaped contract fixtures
- Boundary and malformed-input tests
- Adversarial privacy and opaque-identity tests
- Evidence-strength and non-inference tests
- Snapshot coherency across inventory, filters, facets, and detail views
- Sorting in both directions for every meaningful column
- Facet counts, empty facets, reset behavior, and combinations
- Lazy-loading and partial-failure behavior
- Cache-only/no-egress/no-token ordinary reads
- Refresh source selection, timeout, stale-cache, and partial success
- Keyboard navigation, focus management, announcements, labels, contrast, reduced motion, and screen-reader behavior
- Restricted-height inventory and internal scrolling
- Responsive layouts and browser compatibility
- macOS, Linux, and Windows path/source variations where applicable
- Realistic large catalog fixtures and performance behavior

Wave 3 — integration and documentation

- Integrate shared files sequentially.
- Reconcile all ADR/DDD/API/user/supporting documentation with actual behavior.
- Add migration or operational guidance where appropriate.
- Document evidence meanings and source limitations in plain language.
- Remove stale claims and internal vocabulary from user-facing material.
- Commit cohesive logical units.

Wave 4 — independent review swarm

At the same exact HEAD, run independent reviews for:

- Architecture and DDD consistency
- Source/provenance correctness and August 2026 freshness
- Privacy/security and data leakage
- API and snapshot correctness
- UI/UX/accessibility
- Test adequacy
- ADR and documentation truthfulness

Fix all blocker and major findings. Repeat review against the new exact HEAD after fixes.

FINAL VALIDATION

Run all applicable gates, including at minimum:

- pnpm test
- pnpm run check
- pnpm run build
- pnpm run test:ui, if present
- pnpm audit --prod
- Agentic-QE coverage and quality analysis
- Accessibility validation
- Security/privacy checks
- Documentation lint and link validation
- Packaging dry run
- Targeted browser verification of the Models workflow

Use Agentic-QE to score the verified repository result. Iterate toward at least 98/100 unless a concrete environmental limitation prevents it. Never fabricate the score or claim a test passed without evidence.

COMMIT AND PR DISCIPLINE

Commit logical units continuously, for example:

1. Domain/evidence contracts and ADR alignment
2. Source collectors and normalization
3. Projection/API/filter/facet behavior
4. Operator-focused Models UI
5. Privacy and accessibility hardening
6. Documentation and final regression coverage

Use the repository’s commit convention. Each commit must be independently understandable and green for its owned scope.

After final validation:

- Confirm the worktree contains no accidental files.
- Push the current branch normally.
- Update PR #179 rather than opening a duplicate.
- Update its description with architecture, UX, source/proof semantics, privacy, tests, ADRs, screenshots, and validation evidence.
- Monitor every required CI check to completion.
- Fix failures and repeat the exact-head review.
- Report the final commit SHA, PR URL, mergeability, checks, quality score, known limitations, and any intentionally deferred work.
- Do not merge without explicit approval.
- Persist final decisions and outcome to project memory.
- Complete tasks and gracefully terminate the swarm.

DEFINITION OF DONE

The work is complete only when:

- Operators can identify their models and routes without interpreting hashes.
- Operational models and the public catalog are clearly separated.
- Filters contain real, meaningful values and reflect facet counts.
- Sorting, lazy loading, bounded scrolling, and accessibility work.
- Available source metadata is preserved and surfaced appropriately.
- Unknown states are explained rather than repeated as noise.
- Identity, entitlement, availability, policy, routability, and observed use remain independent evidence facts.
- Privacy and no-egress requirements are proven by tests.
- ADRs, DDD, API, user-facing, and supporting documentation match reality.
- All local and CI gates pass on the final exact HEAD.
- Logical commits have been pushed to the existing branch and PR #179 is fully updated.

Begin immediately. Keep me oriented with concise progress updates, but do not pause for routine decisions. Escalate only a genuinely ambiguous product choice, missing authority, or an irreversible action.
```
