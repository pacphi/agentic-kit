<!-- BEGIN ruflo-aqe-reference -->
<!-- ruflo-aqe-reference: merged into ~/.claude/CLAUDE.md ONLY when agentic-qe is installed.
     Managed by install.sh / ruflo-kit x reference sync — stripped automatically when `aqe` is
     absent. Source of truth: claude/aqe-reference.md in the ruflo-machine-ref kit. -->

## Agentic-QE — operating guidance

> Applies when the standalone **agentic-qe** fleet is installed (`aqe` on PATH). This is the
> reusable subset of what `aqe init` would otherwise append to each project's `CLAUDE.md`;
> per-project specifics (enabled domains, worker config, the generation timestamp, local
> `.agentic-qe/` paths) are intentionally **not** here — `aqe init` writes those into the repo.

### Critical policies (apply whenever agentic-qe is in use)
- **Integrity (absolute):** no shortcuts, fake data, or false success claims; verify before
  claiming done; use real DB queries in integration tests; run actual tests, don't assume.
- **Test execution:** never run `npm test` without `--run` (watch-mode hang risk) — use
  `npm test -- --run`, or `npm run test:unit` / `test:integration` when available.
- **Data protection:** never `rm -f` `.agentic-qe/` or `*.db` without confirmation; back up
  before destructive database operations.
- **Git:** never auto-commit/push without an explicit user request.

### Driving the AQE MCP
Tools are prefixed `mcp__agentic-qe__` (discover via `ToolSearch`). **`fleet_init` MUST be
called first**, e.g. `fleet_init({ topology:"hierarchical", maxAgents:15, memoryBackend:"hybrid" })`.

| Tool | Purpose |
|------|---------|
| `fleet_init` | Initialize the QE fleet (call first) · `fleet_status` for health |
| `test_generate_enhanced` | AI-powered test generation (`framework`, `strategy`) |
| `test_execute_parallel` | Parallel execution with retry |
| `coverage_analyze_sublinear` | O(log n) coverage analysis (`paths`, `threshold`) |
| `quality_assess` | Quality-gate evaluation |
| `task_orchestrate` | Multi-agent QE tasks across domains (`parallel:true`) |
| `memory_store` / `memory_query` | Patterns with `namespace` + `persist:true` (learning) |
| `security_scan_comprehensive` | SAST/DAST scanning |
| `qe/quality/gate` | Two-gate quality verdict (mechanical + LLM judge): pass / fail / inconclusive (aqe ≥3.12.0; CLI: `aqe quality-gate`) |

### Billing & init behavior (aqe ≥3.12)
- **`aqe init` merges, never clobbers** (≥3.12.1): existing hooks (incl. ruflo's), a custom
  `statusLine`, and user `AQE_*` env overrides survive re-init; a one-time
  `.claude/settings.json.backup` is written first. Keep aqe ≥3.12.1 — 3.11.x init
  stripped foreign hooks.
- **Run QE on a Claude subscription instead of an API key** (≥3.12.2, runtime env — init
  never writes these): `AQE_LLM_PROVIDER=claude-code` routes analysis through `claude -p`;
  `AQE_MAX_BUDGET_USD` (or `--max-budget-usd`) enforces a fleet-wide spend cap that aborts
  over-budget requests before spending. `aqe health` shows an "LLM Billing" section saying
  who pays for each call.

### QE agents via the native Task tool
QE agents live under `.claude/agents/v3/` once `aqe init` has run in the repo:
```javascript
Task({ prompt: "Generate tests",     subagent_type: "qe-test-architect",      run_in_background: true })
Task({ prompt: "Find coverage gaps", subagent_type: "qe-coverage-specialist", run_in_background: true })
Task({ prompt: "Security audit",     subagent_type: "qe-security-scanner",    run_in_background: true })
```

<!-- END ruflo-aqe-reference -->
