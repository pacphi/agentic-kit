# agentic-kit

> Setup, repair, evidence reporting, and supervised execution for coding-agent integrations

## Project Overview

A cross-platform, zero-runtime-dependency Node.js CLI (`ak` / `agentic-kit`) integrating
Ruflo, Agentic QE, Claude Code, Codex, and opt-in OpenCode.

**Tech Stack**: JavaScript ES modules (`.mjs`), Node.js 22+, TypeScript checking via `tsc`
**Architecture**: Domain-Driven Design with bounded contexts

## Documentation layout

<!-- Authored by the maintainers, not generated. tests/kit/docs-layout.test.mjs fails if a
     regeneration drops this section. This repository only: it is not shipped. -->

- Plans go to `docs/plans/YYYY-MM-DD-<feature>.md` and specs to
  `docs/plans/YYYY-MM-DD-<topic>-design.md`, including the ones Superpowers writes. Never create
  `docs/superpowers/` or any other folder under `docs/`.
- Finished plans and specs move to `docs/archive/` in the pull request that completes the work,
  using `node scripts/docs-relocate.mjs`, with one index row per file in `docs/archive/README.md`.
- Dated audits and evidence go straight to `docs/archive/`; dormant proposals to `docs/proposals/`.
- Top-level `docs/*.md` files are living guides, each listed in `docs/README.md`.
- Markdown file names are lower case. Only `README.md`, `CLAUDE.md`, `AGENTS.md`, and `SKILL.md`
  keep capitals. Never move an ADR.

## Quick Start

### Installation

```bash
pnpm install
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Development

Source runs directly; there is no `dev` script or compilation step.

```bash
node bin/agentic-kit.mjs --help --all
pnpm run typecheck
```

## Agent Coordination

### Swarm Configuration

For complex work, the preferred coordination shape is hierarchical. These are
workflow preferences, not evidence that a swarm is running; obey the current
host/session capability and concurrency limits:

| Setting | Value | Purpose |
|---------|-------|---------|
| Topology | `hierarchical` | Queen-led coordination (anti-drift) |
| Max Agents | 8 | Optimal team size |
| Strategy | `specialized` | Clear role boundaries |
| Consensus | `raft` | Leader-based consistency |

### When to Use Swarms

**Invoke swarm for:**

- Multi-file changes (3+ files)
- New feature implementation
- Cross-module refactoring
- API changes with tests
- Security-related changes
- Performance optimization

**Skip swarm for:**

- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes

### Available Skills

Use `$skill-name` syntax to invoke:

| Skill | Use Case |
|-------|----------|
| `$swarm-orchestration` | Multi-agent task coordination |
| `$memory-management` | Pattern storage and retrieval |
| `$sparc-methodology` | Structured development workflow |
| `$security-audit` | Security scanning and CVE detection |
| `$performance-analysis` | Profiling and optimization |
| `$github-automation` | CI/CD and PR management |

Maintainer-only skills for this repository are the `ak-*` skills; see `docs/maintainer.md`, section "Maintainer skills".

### Agent Types

| Type | Role | Use Case |
|------|------|----------|
| `researcher` | Requirements analysis | Understanding scope |
| `architect` | System design | Planning structure |
| `coder` | Implementation | Writing code |
| `tester` | Test creation | Quality assurance |
| `reviewer` | Code review | Security and quality |

## Execution Model

- **claude-flow** = LEDGER (coordinates: memory, routing, swarm state)
- **Codex** = EXECUTOR (writes code, runs tests, creates files)

**Critical rule:** DON'T STOP after calling claude-flow commands. Coordination commands return instantly — continue immediately with the next implementation step.

## Ruflo + Codex Automated Workflow

Ruflo is the coordination ledger and policy decision point; Codex workers execute code, tests, and commands. A Ruflo coordination call records work but never replaces implementation.

Use `guidance_brain({ mode: "recommend", task: "..." })` when the task can
benefit from Ruflo-specific capabilities. Its live registry is authoritative
for tool presence; registration alone does not prove configuration,
reachability, health, or authorization. If it is not registered, use compatible
`guidance_recommend`, CLI discovery, and repository instructions.

1. **Recall** — search AgentDB memory and relevant ADRs for patterns and constraints.
2. **Inspect** — read source, runtime, dependency, policy, and health state.
3. **Route** — choose the smallest capable topology, agents, skills, and tools.
4. **Plan** — define acceptance criteria, safety envelope, ownership, and validation.
5. **Execute** — Codex workers implement in isolated scopes; Ruflo records coordination.
6. **Test** — run focused tests, regression tests, and failure-path checks.
7. **Validate** — check types, security, policy, compatibility, and artifact integrity.
8. **Benchmark** — compare a source-bound candidate with a source-bound baseline.
9. **Optimize** — improve measured bottlenecks without weakening the safety envelope.
10. **Receipt** — bind claims, evidence, and decisions to exact source/build inputs.
11. **Handoff** — reconcile concurrent work and disclose unresolved limitations.
12. **Publish** — only an independently authorized release gate may publish immutable artifacts.

### Concurrency and authority invariants

- Never allow two writers in one worktree.
- Read-only research agents may share a checkout; writing agents may not.
- A child may drop capabilities but can never add tools, servers, namespaces, network access, spend, concurrency, or delegation depth.
- Cancel dependent and not-yet-started sibling work when policy denies an action or a required dependency fails.
- MetaHarness may benchmark candidates concurrently, but it cannot promote, serve, or expand its own SafetyEnvelope.
- Only the integration agent changes shared manifests or lockfiles.
- Do not auto-commit, push, merge, release, or delete worktrees unless the user authorized that operation.
- Every consequential action must produce a policy decision receipt; production, destructive, spend, and promotion actions may require human approval.

### Repository harness adapter

When tracked repository instructions define a local collaboration harness:

1. Assign the isolated worktree before starting a writing session.
2. Start or register the session, inspect current claims, and acquire only the
   exact paths, resources, and development ports needed for the task.
3. Renew leases during long work, check acknowledged inbox messages at integration
   boundaries, and release claims when handing off or ending.
4. Record focused and integration evidence against the exact source state,
   then let the designated integration owner decide release.

A repository lease coordinates ownership; it does not grant authorization.
In-memory reference adapters demonstrate semantics but are not distributed,
restart-durable release authorities.
The worker still needs the current ADR-324/325 action capability and fencing
epoch for every protected side effect. Heartbeat and lease expiry establish
liveness; a PID is diagnostic only. HEAD alone is not an exact source-state
identity when tracked or untracked changes exist, so a release receipt must
bind a clean commit or an immutable snapshot including those changes.

## MCP Runtime Integration

The following upstream tool/command examples describe integration vocabulary,
not a live inventory or implementation inside agentic-kit. Confirm installed
upstream help and the configured MCP schemas before use. Prefer the installed
`ruflo` binary rather than an implicit package download.

Use MCP tools for coordination, then keep coding:

| Tool | Purpose | Example |
|------|---------|---------|
| `swarm_init` | Start coordination | `swarm_init({topology: "hierarchical"})` |
| `memory_store` | Save patterns | `memory_store({key: "auth", value: "JWT"})` |
| `memory_search` | Find patterns | `memory_search({query: "auth patterns"})` |
| `task_orchestrate` | Assign work | `task_orchestrate({task: "implement"})` |

## Code Standards

### File Organization

- **NEVER** save to root folder
- `/src` - Source code files
- `/tests` - Test files
- `/docs` - Documentation
- `/config` - Configuration files

### Quality Rules

- Files under 500 lines
- No hardcoded secrets
- Input validation at boundaries
- Typed interfaces for public APIs
- TDD London School (mock-first) preferred

### Commit Messages

```text
<type>(<scope>): <description>

[optional body]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

Do not add a `Co-Authored-By` trailer unless the repository explicitly
configures and authorizes that attribution.

### Issue Titles

GitHub issue titles use the same Conventional Commits types as commit
messages, lowercase, followed by a colon and a lowercase description
(proper nouns excepted):

```text
<type>: <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`,
plus two repo-specific extensions used only for issues:

- `tracking` — an issue that exists to track status on something outside
  this repo's control (an upstream fix, a multi-part readiness checklist),
  not to request local work directly.
- `research` — an open investigation or design question without a known
  fix yet.

When an internal reference collides with the type's own colon (e.g. a
quoted status or a sub-item id), use an em dash instead of a second colon:
`fix: dashboard session stream stuck on "CONNECTING" — capture a browser
network trace`.

## Security

### Critical Rules

- NEVER commit secrets, credentials, or .env files
- NEVER hardcode API keys
- Always validate user input
- Use parameterized queries for SQL
- Sanitize output to prevent XSS

### Path Security

- Validate all file paths
- Prevent directory traversal (../)
- Use absolute paths internally

## Memory System

### Storing Patterns

```bash
ruflo memory store \
  --key "pattern-name" \
  --value "pattern description" \
  --namespace patterns
```

### Searching Memory

```bash
ruflo memory search \
  --query "search terms" \
  --namespace patterns
```

## Quick Commands

```bash
ruflo memory search --query "relevant patterns"
ruflo hooks route --task "current task description"
ruflo swarm init --topology hierarchical
ruflo hooks pre-task --description "task summary"
```

## Links

- Documentation: <https://github.com/ruvnet/ruflo>
- Issues: <https://github.com/ruvnet/ruflo/issues>

## Performance evidence

Use `pnpm run benchmark:footprint` for the repository's measurement benchmark.
Bind results to the source revision, workload, and environment. Upstream HNSW,
compression, or neural-routing targets are not measured agentic-kit guarantees.

## Testing

### Running Tests

```bash
# Coverage-enforced unit and legacy renderer/server suites
pnpm test

# One focused suite
node scripts/run-tests.mjs focus tests/kit/dispatch-surface.test.mjs

# Browser verification
pnpm run test:ui

# Static checks
pnpm run typecheck
pnpm run lint
pnpm run lint:cc
pnpm run lint:md
pnpm run build
```

A plain `node --test` run lacks the wrapper's real-state tripwire and temp-root checks.

`pnpm test` and `pnpm run test:ui` run through `scripts/run-tests.mjs`, which fingerprints
`~/.config/agentic-kit`, `~/.local/state/agentic-kit` (or `%APPDATA%`/`%LOCALAPPDATA%` on
Windows), `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.claude.json`,
`~/.codex/AGENTS.md`, `~/.codex/config.toml`, the OpenCode `AGENTS.md`, this repository's root
`CLAUDE.md`, `AGENTS.md` and `.mcp.json`, and its `.claude`, `.swarm`, `.agentic-qe`,
`.claude-flow` and `.harness` before and after the run. Any change fails the run and is listed
by path. Other tool paths (skills, agents and plugin folders, `opencode.json`, the Hermes home,
`~/.claude-flow/memory`) are not fingerprinted; `spawnEnv()` keeps spawned children away from
them, and `sandboxHome()` and `redirectToolState()` do the same for in-process code. Files a live Claude Code, Ruflo or AQE session writes during the run (including Claude
Code's own `~/.claude.json`) are listed as "concurrent writers" and do not fail a local run; CI
(or `AK_TRIPWIRE_STRICT=1`) fails on them too. Every command also runs with
`TMPDIR`/`TEMP`/`TMP` pointed at a fresh `ak-suite-*` folder: anything left in it afterwards fails the run and is
listed (excluding its private atomic `.ak-suite-owner.json`, child-hold directory and Node compile cache). The runner
refuses home/filesystem-root temp bases before allocation and refuses roots inside a git
repository (point `TMPDIR` elsewhere). A completed run removes only its own validated direct,
canonical, nonsymlink, current-owner root. Tests with known child lifetime uncertainty acquire
`acquireRunRootHold()` before launching those children and release only after proving their exits.
An unresolved or unreadable hold retains the own root; it is not a general descendant-exit proof.
The runner then lists sibling suite roots: missing, invalid,
foreign or uncertain owner metadata means keep. Sibling handling is list-only on macOS, Linux
and Windows because no installed probe proves all descendants have exited; even a dead owner
is insufficient. Interrupted runs remove and collect nothing. Sibling listing/collection errors
do not change the suite's exit code. Own-root inspection failure retains the root; inspection,
removal or safety-refusal failure returns hygiene exit 4 unless a command or tripwire failure
already takes precedence. Removal errors may leave a partially removed own root. The runner also
drops `FORCE_COLOR` (Claude Code shells set it), because
tests read plain text from pipes. Tests make temporary folders with `tempDir()` from
`tests/kit/helpers/temp-dir.mjs`, and spawned children get their environment from `spawnEnv()` in
`tests/kit/helpers/home-sandbox.mjs`. UI tests launch Chrome with `launchChrome()` from
`tests/ui/helpers/launch-chrome.mjs`, which gives the browser its own temp folder and removes it on
close. `node scripts/run-tests.mjs exec -- <node args>` guards any single command the same way.

### Test Philosophy

- TDD London School (mock-first)
- Unit tests for business logic
- Integration tests for boundaries
- E2E tests for critical paths
- Security tests for sensitive operations

### Coverage Requirements

- Repository target: at least 80% line coverage; `pnpm test` currently enforces
  70% line, branch, and function floors. Report the measured result and any gap.
- 100% coverage for security-critical code
- All public APIs must have tests

## MCP Integration

Claude Flow exposes tools via Model Context Protocol:

```bash
# Start MCP server
ruflo mcp start

# List available tools
ruflo mcp tools
```

### Available Tools

| Tool | Purpose | Example |
|------|---------|---------|
| `swarm_init` | Initialize swarm coordination | `swarm_init({topology: "hierarchical"})` |
| `agent_spawn` | Spawn new agents | `agent_spawn({type: "coder", name: "dev-1"})` |
| `memory_store` | Store in AgentDB | `memory_store({key: "pattern", value: "..."})` |
| `memory_search` | Semantic search | `memory_search({query: "auth patterns"})` |
| `task_orchestrate` | Task coordination | `task_orchestrate({task: "implement feature"})` |
| `neural_train` | Train neural patterns | `neural_train({iterations: 10})` |
| `benchmark_run` | Performance benchmarks | `benchmark_run({type: "all"})` |

## Hooks System

Claude Flow uses hooks for lifecycle automation:

### Core Hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| `pre-task` | Before task starts | Get context, load patterns |
| `post-task` | After task completes | Record completion, train |
| `pre-edit` | Before file changes | Validate, backup |
| `post-edit` | After file changes | Train patterns, verify |
| `pre-command` | Before shell commands | Security check |
| `post-command` | After shell commands | Log results |

### Session Hooks

| Hook | Purpose |
|------|---------|
| `session-start` | Initialize context, load memory |
| `session-end` | Export metrics, consolidate memory |
| `session-restore` | Resume from checkpoint |
| `notify` | Send notifications |

### Intelligence Hooks

| Hook | Purpose |
|------|---------|
| `route` | Route task to appropriate agents |
| `explain` | Generate explanations |
| `pretrain` | Pre-train neural patterns |
| `build-agents` | Build specialized agents |
| `transfer` | Transfer learning between domains |

### Example Usage

```bash
# Before starting a task
ruflo hooks pre-task \
  --description "implementing authentication"

# After completing a task
ruflo hooks post-task \
  --task-id "task-123" \
  --success true

# Route a task to agents
ruflo hooks route \
  --task "implement OAuth2 login flow"
```

## Background Workers

Examples of upstream worker names and intended roles follow. Their installation,
enablement, execution, and resource use require separate evidence:

| Worker | Priority | Purpose |
|--------|----------|---------|
| `ultralearn` | normal | Deep knowledge acquisition |
| `optimize` | high | Performance optimization |
| `consolidate` | low | Memory consolidation |
| `predict` | normal | Predictive preloading |
| `audit` | critical | Security analysis |
| `map` | normal | Codebase mapping |
| `preload` | low | Resource preloading |
| `deepdive` | normal | Deep code analysis |
| `document` | normal | Auto-documentation |
| `refactor` | normal | Refactoring suggestions |
| `benchmark` | normal | Performance benchmarking |
| `testgaps` | normal | Test coverage analysis |

### Managing Workers

```bash
# List workers
ruflo hooks worker list

# Trigger specific worker
ruflo hooks worker dispatch --trigger audit

# Check worker status
ruflo hooks worker status
```

## Intelligence System

Upstream intelligence concepts referenced by integrations include the following.
They are not guarantees that a given installation has trained or is using them:

### Components

- **SONA**: Self-Optimizing Neural Architecture
- **MoE**: Mixture of Experts for specialized routing
- **HNSW**: Hierarchical Navigable Small World for fast search
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: Optimized attention mechanism

### 4-Step Pipeline

1. **RETRIEVE** - Fetch relevant patterns via HNSW
2. **JUDGE** - Evaluate with verdicts (success/failure)
3. **DISTILL** - Extract key learnings via LoRA
4. **CONSOLIDATE** - Prevent catastrophic forgetting via EWC++

## Debugging

### Log Levels

```bash
# Set log level
export CLAUDE_FLOW_LOG_LEVEL=debug

# Enable verbose mode
ruflo --verbose <command>
```

### Health Checks

```bash
# Run diagnostics
ruflo doctor --fix

# Check system status
ruflo status
```

---

<!-- AQE owns this block and emits its own top-level heading. -->
<!-- markdownlint-disable MD025 -->
<!-- BEGIN AGENTIC-QE CODEX -->
# Agentic QE

Preserve project data, especially .agentic-qe/memory.db. Read affected code and tests before editing, validate inputs at system boundaries, and run focused checks before broader gates. Discover AQE tools and skills from their live schemas.
<!-- END AGENTIC-QE CODEX -->
<!-- markdownlint-enable MD025 -->
