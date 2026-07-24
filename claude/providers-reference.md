<!-- BEGIN ruflo-providers-reference -->
<!-- ruflo-providers-reference: merged into ~/.claude/CLAUDE.md ONLY when the `codex` CLI
     is on PATH. Managed by agentic-kit / `ak x reference sync` — stripped automatically
     when codex is uninstalled. Do not hand-edit between the sentinels. -->

## Frontier hosts & LLM providers (claude / codex)

This machine has **both** frontier-agent CLIs installed. `ak` detects them and wires ruflo +
agentic-qe to use one or both. Two independent axes:

- **Host axis** — which agent CLI runs the *ruflo* loop: `claude` (Claude Code) and/or `codex`
  (OpenAI Codex). ruflo can run **both at once** (dual-mode).
- **Provider axis** — which LLM the *routers* use, independent of the host:
  - **agentic-qe** — `AQE_LLM_PROVIDER=<type>` selects any of `claude-code` (subscription),
    `claude` / `openai` / `gemini` / `openrouter` / `azure-openai` / `bedrock` / `cognitum`
    (metered API key), or `ollama` / `onnx` (local). codex the CLI isn't a provider type, but its
    OpenAI models are reachable via `openai`; GLM models are reachable via `openrouter`
    (e.g. `z-ai/glm-5.2`).
  - **ruflo** — `anthropic` / `openai` / `google` / `ollama` via `ruflo providers configure`.
  - API keys live in the environment; they are never persisted to `kit.json`.

**One or several — you're never forced to pick just one.** All three surfaces run multiple
providers concurrently:
- **ruflo hosts** — enable `claude` *and* `codex` together (dual-mode); ruflo runs both.
- **ruflo LLM providers** — a list, with load-balancing + automatic failover.
- **agentic-qe** — its `HybridRouter` **auto-enables every provider that has an API key in the
  env** and fails over across an ordered chain. `AQE_LLM_PROVIDER` only pins the *default* (the
  primary) — the others stay enabled. So `ak x provider` sets aqe's primary; adding
  `OPENAI_API_KEY` / `GEMINI_API_KEY` to the env brings those online as fallbacks automatically.

### aqe fallback chain — managed from `kit.json`

For **deterministic** ordering (rather than relying on env auto-enable), `ak` writes aqe's
`.agentic-qe/llm-config.json` from `kit.json`:

```bash
ak x provider pick --aqe-provider claude-code \
  --aqe-fallback 'claude-code:claude-opus-4-8; openai:gpt-5.6; gemini:gemini-3.5-flash'
```

Each `provider:model,model` entry becomes an ordered `fallbackChain` entry (first = highest
priority; model IDs are examples current as of July 2026 — use what your provider offers).
ak writes a **complete** chain (aqe merges it shallowly, so partial chains would drop
defaults), sets each provider `enabled`, and tags the file `_managedBy: agentic-kit`. **API keys
are never written** — they stay in the env (aqe refuses to persist them anyway). `ak sync`
reapplies the chain; `ak status` flags drift; `ak x provider off` restores the pre-ak file from
its one-time `.bak` (or removes an ak-created file). Entries need populated models — aqe's router
skips an entry with none. For lower-level edits, `aqe llm-router config` still works.

### Managing it (prompts-once, reversible)

```bash
ak x provider status   # detected CLIs + versions, what's enabled, what's wired
ak x provider pick     # choose ruflo hosts / aqe provider / ruflo API providers → persist → apply
ak x provider off      # reset to claude-only default; strip managed env keys
```

`pick` persists your choice to `kit.json` and applies it: it writes the ruflo backend flags
(`ENABLE_CLAUDE_CODE` / `ENABLE_CODEX`) and `AQE_LLM_PROVIDER` into
`.claude/settings.local.json` `env` (merge-not-clobber, backup-first), runs
`ruflo init --dual` when codex is enabled, and registers any API-key providers with ruflo.
`ak sync` reapplies the same choice idempotently; `ak status` shows **hosts** and
**providers** rows and flags drift. At the claude-only default nothing is written — behavior
is unchanged until you opt in.

When **both** hosts are enabled, `ak` also seeds a **per-activity routing policy** and wires a
**two-way Claude↔Codex MCP bridge** (Claude reaches Codex via `mcp__codex__codex`; Codex reaches
ruflo via `[mcp_servers.ruflo]`). `--primary-host claude|codex` chooses which host leads. See the
dual-mode reference block and `docs/PROVIDERS.md` §3.5 for the routing table and `ak dual run`.

### Install & update (install-method-aware)

- **First install** — `ak setup` (and `ak x provider pick`) installs any *enabled* host that
  is entirely **absent**: `npm i -g @anthropic-ai/claude-code` / `@openai/codex`.
- **Updates** — `ak sync` keeps **npm-managed** hosts current (drift is detected on the same
  cached TTL as ruflo/aqe, and surfaces in the bin nudge + `ak status`).
- **Externally-installed CLIs are never touched.** If a host was installed by mise, the
  native installer, or Homebrew, ak reports its version and marks it *self-managed* — it will
  not shadow it with an npm copy or try to update it. Update those with your own tool.

### Grounding (rUv source)

- ruflo **ADR-034 Optional MCP Backends** (accepted): Claude Code / Gemini / OpenAI Codex
  backends enabled via `ENABLE_CLAUDE_CODE` / `ENABLE_GEMINI_MCP` / `ENABLE_CODEX`.
- `@claude-flow/codex` adapter + `ruflo init --dual` ("Initialize for both Claude Code and
  OpenAI Codex").
- `ruflo providers list|configure|test` — the API-key provider matrix.

<!-- END ruflo-providers-reference -->
