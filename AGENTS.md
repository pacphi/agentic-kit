# agentic-kit

> Multi-agent orchestration framework for agentic coding

## Project Overview

A Claude Flow powered project

**Tech Stack**: TypeScript, Node.js
**Architecture**: Domain-Driven Design with bounded contexts

## Quick Start

### Installation

```bash
npm install
```text

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Development

```bash
npm run dev
```

## Agent Coordination

### Swarm Configuration

This project uses hierarchical swarm coordination for complex tasks:

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
npx @claude-flow/cli memory store \
  --key "pattern-name" \
  --value "pattern description" \
  --namespace patterns
```

### Searching Memory

```bash
npx @claude-flow/cli memory search \
  --query "search terms" \
  --namespace patterns
```

## Quick Commands

```bash
npx @claude-flow/cli memory search --query "relevant patterns"
npx @claude-flow/cli hooks route --task "current task description"
npx @claude-flow/cli swarm init --topology hierarchical
npx @claude-flow/cli hooks pre-task --description "task summary"
```

## Links

- Documentation: <https://github.com/ruvnet/ruflo>
- Issues: <https://github.com/ruvnet/ruflo/issues>

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| HNSW Search | 150x-12,500x faster | Vector operations |
| Memory Reduction | 50-75% | Int8 quantization |
| MCP Response | <100ms | API latency |
| CLI Startup | <500ms | Cold start |
| SONA Adaptation | <0.05ms | Neural learning |

## Testing

### Running Tests

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Coverage
npm run test:coverage

# Security tests
npm run test:security
```

### Test Philosophy

- TDD London School (mock-first)
- Unit tests for business logic
- Integration tests for boundaries
- E2E tests for critical paths
- Security tests for sensitive operations

### Coverage Requirements

- Minimum 80% line coverage
- 100% coverage for security-critical code
- All public APIs must have tests

## MCP Integration

Claude Flow exposes tools via Model Context Protocol:

```bash
# Start MCP server
npx ruflo mcp start

# List available tools
npx ruflo mcp tools
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
npx @claude-flow/cli hooks pre-task \
  --description "implementing authentication"

# After completing a task
npx @claude-flow/cli hooks post-task \
  --task-id "task-123" \
  --success true

# Route a task to agents
npx @claude-flow/cli hooks route \
  --task "implement OAuth2 login flow"
```

## Background Workers

12 background workers provide continuous optimization:

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
npx @claude-flow/cli hooks worker list

# Trigger specific worker
npx @claude-flow/cli hooks worker dispatch --trigger audit

# Check worker status
npx @claude-flow/cli hooks worker status
```

## Intelligence System

The RuVector Intelligence System provides neural learning:

### Components

- **SONA**: Self-Optimizing Neural Architecture (<0.05ms adaptation)
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
npx @claude-flow/cli --verbose <command>
```

### Health Checks

```bash
# Run diagnostics
npx @claude-flow/cli doctor --fix

# Check system status
npx @claude-flow/cli status
```

---

<!-- BEGIN AGENTIC-QE CODEX -->
## Quality Engineering Standards (Agentic QE)

## AQE MCP Server

This project uses Agentic QE for AI-powered quality engineering. The AQE MCP server provides tools for test generation, coverage analysis, quality assessment, and learning.

## Setup

Always call `fleet_init` before using other AQE tools to initialize the QE fleet.

## Available Tools

### Test Generation

- `test_generate_enhanced` — AI-powered test generation with pattern recognition and anti-pattern detection
- Supports unit, integration, and e2e test types

### Coverage Analysis

- `coverage_analyze_sublinear` — O(log n) coverage gap detection with ML-powered analysis
- Target: 80% statement coverage minimum, focus on risk-weighted coverage

### Quality Assessment

- `quality_assess` — Quality gate evaluation with configurable thresholds
- Run before marking tasks complete

### Security Scanning

- `security_scan_comprehensive` — SAST/DAST vulnerability scanning
- Run after changes to auth, security, or middleware code

### Defect Prediction

- `defect_predict` — AI analysis of code complexity and change history

### Learning & Memory

- `memory_store` — Store patterns and learnings for future reference
- `memory_query` — Query past patterns before starting work
- Always store successful patterns after task completion

## Best Practices

1. **Test Pyramid**: 70% unit, 20% integration, 10% e2e
2. **AAA Pattern**: Arrange-Act-Assert for clear test structure
3. **One assertion per test**: Test one behavior at a time
4. **Descriptive names**: `should_returnValue_when_condition`
5. **Mock at boundaries**: Only mock external dependencies
6. **Edge cases first**: Test boundary conditions, not just happy paths
<!-- END AGENTIC-QE CODEX -->
