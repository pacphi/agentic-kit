# Model providers & hosts — the simple path, and how to go deeper

`ak`'s job is to make **the best default the simplest thing** — and then get out of your
way when you want to customize, exactly as you would if you drove `ruflo` and `agentic-qe`
by hand. Everything `ak` writes is *their* standard config; `ak` just converges to it,
proves it, and can undo it.

There are two independent things you can point at a model:

- **Hosts** — which agent CLI runs the *ruflo* loop: `claude` (Claude Code), `codex` (OpenAI
  Codex), or **both** at once.
- **Providers** — which LLM the *routers* use: ruflo's provider router and agentic-qe's
  `HybridRouter`. Independent of the host; API keys always live in your environment.

The full model has four separate axes:

| Axis | Meaning | Examples |
|---|---|---|
| **Host** | Agent CLI/environment executing work | Claude Code, Codex CLI, OpenCode |
| **Provider** | Inference service, gateway, or local runtime | Anthropic, OpenAI, OpenRouter, Ollama |
| **Projection** | Native configuration surface receiving intent | Claude settings, Codex TOML, OpenCode JSON, ruflo/AQE routers |
| **Observability** | Evidence source establishing facts | host JSONL, OpenRouter metadata, quota channels, Ollama catalogue |

A **binding** connects a host to a provider through a projection and transport. One Ollama
provider can therefore have independent `ollama-via-claude` and `ollama-via-codex` bindings.
OpenRouter is a provider behind a host, never automatically a third host. OpenCode is an opt-in
activity-routing host through `ak run`, while remaining ineligible as a primary host or AQE
provider. Its configured selector does not establish provider, billing, or vendor-diversity facts.

**Account analytics is separate from routing evidence.** `ak usage refresh openrouter` explicitly
fetches OpenRouter's supported 30-completed-UTC-day activity view with
`OPENROUTER_MANAGEMENT_KEY` and writes a private local cache. `ak usage status` and the dashboard
read only that cache. Because the management response has no local host/session/project/task
correlation key, its rows appear only as provider account analytics and never alter transcript
totals or prove which host executed a request.

This capability model is
[ADR-0016](adr/0016-capability-driven-integration-adapters.md) (Accepted); the controls below
implement it. `ak host` owns execution-host lifecycle and selection (`status`, `pick`, `refresh`,
and `off`), with `ak x host` as its plumbing spelling. Inference providers and bindings remain
separate axes even though some provider controls share that workflow.

---

## Level 0 — do nothing (the point)

Install `ak`, run `ak setup`. Claude Code is the host, agentic-qe uses its own default, and
nothing about providers is written anywhere. This is the whole feature for most people:
**it already works, and `kit.json` stays at its defaults.**

```bash
ak setup      # claude just works; codex/other providers are opt-in
ak status     # shows a "hosts" + "providers" row so you can see what's true
```

If you happen to have `codex` installed, `ak` notices and *offers* — it never flips it on
for you:

```text
ℹ codex CLI detected — run `ak host pick` to let ruflo use both claude and codex
```

## Two configs, one front door

A question that trips people up: **do ruflo and agentic-qe read the same config?** No.
They are two independent routing subsystems, each with its **own config store and its own
escalation machinery**. There is no shared file they both read. What unifies them is `ak`:
it takes your intent once (in `kit.json`) and writes **each tool's own native config** —
converging, proving, and able to undo. `ak` is a facilitator, not a config layer the tools
depend on.

| | **agentic-qe** (`HybridRouter`) | **ruflo** (provider router) |
|---|---|---|
| **Config store** | `.agentic-qe/llm-config.json` (per project) + env | `~/.agentic-flow/router.config.json` (or `--router-config`) + env |
| **Precedence** (highest wins) | explicit override → env (`AQE_LLM_*`, API keys) → disk file → built-in defaults | file (`defaultProvider`, `fallbackChain`) + CLI overrides |
| **Change the provider** | `AQE_LLM_PROVIDER=<type>` (env) — a provider whose API key is in the env is auto-enabled | `ruflo providers configure -p <id> -m <model>` |
| **Change the model** | per-provider `models` in the chain; per-activity `agentOverrides` (aqe ≥ 3.13.1) | `models.{default,fast,advanced}` per provider in the file |
| **Escalation / fallback** | ordered `fallbackChain` + circuit breaker + retry/backoff | `fallbackChain` + `routing.mode` (cost/quality/perf/rule-based) + circuit breaker |
| **The `ak` way** | `--aqe-provider` / `--aqe-fallback` / `--route` | `--provider <id>:<model>` |

Two axes cut across both (see the intro): **hosts** (which agent CLI runs the ruflo loop —
`ENABLE_CLAUDE_CODE` / `ENABLE_CODEX`) are separate from **providers** (which LLM the routers
use). Level 4 below is the full `ak`-way ↔ raw-tool-way map for every knob in this table.

## Level 1 — turn on codex (one command)

> [!NOTE]
> Already have an older `ak` installed and want a capability that shipped later (like
> dual-host)? Updating the binary and enabling the feature are two separate motions —
> see [UPGRADING.md](UPGRADING.md) for the `sync` vs `host pick` distinction.

```bash
ak host pick
```

An interactive picker (or flags for scripts). Enable `codex` and `ak`:

- installs it if it's missing (`npm i -g @openai/codex`) — but leaves an existing
  mise/brew/native install alone,
- maintains the Claude↔Codex bridge and generated host guidance,
- writes `ENABLE_CLAUDE_CODE` / `ENABLE_CODEX` into `.claude/settings.local.json`.

> [!NOTE]
> Project scope is resolved by walking up to the repo root (`.git`), so running
> from a subdirectory writes the same project file at the root — never the
> machine-wide user settings. Outside any repo, user scope is used and said so.

```bash
ak host pick --host claude,codex --yes     # non-interactive
```

Or enable codex during **first-time setup**, in one shot — same gated/prompted/external-safe
install, plus the full dual-mode wiring:

```bash
ak setup --codex --yes                # install everything incl. codex
ak setup --primary-host codex --yes   # …and make codex the leading host
```

## Level 2 — choose which LLM runs QE

agentic-qe can run its analysis on any of: `claude-code` (your Claude subscription),
`claude` / `openai` / `gemini` / `openrouter` / `azure-openai` / `bedrock` / `cognitum`
(metered API key), or `ollama` / `onnx` (local).

**Billing is the axis that isn't obvious from the names** — three categories:
`claude-code` runs on your Claude plan ($0 metered), `ollama` and `onnx` are local ($0),
and **everything else bills a metered API key**. `claude-code` is the *only* subscription
option here: the codex and gemini CLIs also support OAuth/subscription login, but that
lives on the **host axis** (Level 1, which CLI runs the loop) — not as an aqe provider
*type*. So there's no `openai`-subscription or `gemini`-subscription entry; their OAuth
paths are reached by enabling those *hosts*, while the provider list is API-metered.

```bash
ak host pick --aqe-provider claude-code    # run QE on your subscription, no API bill
```

`ak` writes `AQE_LLM_PROVIDER` for you. Add `OPENAI_API_KEY` to your env and agentic-qe's
router will **auto-enable** OpenAI as a fallback on its own — you don't have to list it.

## Level 3 — a deterministic fallback chain

When you want explicit ordering rather than env auto-enable, `ak` manages agentic-qe's
`.agentic-qe/llm-config.json` from `kit.json`:

```bash
ak host pick \
  --aqe-provider claude-code \
  --aqe-fallback 'claude-code:claude-opus-5; openai:gpt-5.6; gemini:gemini-3.5-flash'
```

Each `provider:model,model` becomes an ordered chain entry (first = highest priority). `ak`
writes a complete, schema-correct chain, tags it `_managedBy: agentic-kit`, and **never**
writes your API keys.

> Model IDs above are examples current as of July 2026 (Claude Opus 5, OpenAI GPT-5.6 —
> or `gpt-5.3-codex` for agentic coding — Google Gemini 3.5 Flash). Use whatever IDs your
> provider currently offers; `ak` writes the strings you give it verbatim.

**GLM via OpenRouter.** Zhipu/Z.ai's GLM models are reachable through the `openrouter`
provider — add them to the chain and put `OPENROUTER_API_KEY` in your env:

```bash
ak host pick \
  --aqe-provider claude-code \
  --aqe-fallback 'claude-code:claude-opus-5; openrouter:z-ai/glm-5.2'
```

Curated picks (verified July 2026): `z-ai/glm-5.2` (flagship — 1M context, strong
tool-use, long-horizon agent work) and `z-ai/glm-5` (value — 205K context, cheapest of
the 5.x line). Both are **metered** — GLM is never an auto-seed target (seeding only ever
routes to subscription/local providers).

## Level 3.5 — seeded Claude + Codex defaults, explicit OpenCode routes

When **both** hosts are enabled and `agentic-qe ≥ 3.13.1` is installed, `ak` seeds a
**per-activity routing policy**: each kind of work (architecture, implementation, testing,
review, …) is routed to the host and model that suits it — Claude for reasoning/review,
Codex for execution — and materialized into `.agentic-qe/llm-config.json` (`agentOverrides`).
It's seeded automatically on `ak host pick` / `ak setup`; nothing happens for
claude-only projects.

```bash
ak host pick --host claude,codex        # enables both → seeds routing → prints the table
ak status                                     # a "routing" row; the dashboard shows the matrix
ak host pick --route 'testing:claude:claude-sonnet-5'   # override one activity (persisted)
ak host pick --primary-host codex       # make codex the lead; claude becomes the alternate
```

**Which host leads.** `--primary-host claude|codex` (default `claude`) chooses the primary.
Codex-primary **mirrors** the default table below — codex takes the reasoning/review lead
and claude becomes the alternate/escalation target — so the experience is ambidextrous
regardless of which CLI drives. `ak status` marks the primary and fails (not warns) if the
primary host is missing.

**OpenCode is explicit, not seeded or AQE-projected.** Enable it, then use `ak run` with either
a persisted route or a run-local override:

```bash
ak host pick --host claude,opencode \
  --route 'security-scan:opencode:provider/model'  # persisted intent
ak run security "src/auth/"                         # canonical execution command
ak run security "src/auth/" --route 'security-scan:opencode:provider/model'  # run-local
```

Each OpenCode worker is an isolated, loopback-only supervised server session. A permission request
is aborted and reported as `permission_required`; `ak` never auto-approves it. OpenCode routes are
not written to AQE `agentOverrides`, cannot become `primaryHost`, and do not count as a separate
AQE vendor. `ak run` is the only execution surface for an OpenCode route.

**QE-Court validation stays upstream-owned.** `agentic-qe` 3.13.3 corrected its shipped
QE-Court panel and now enforces the configured anti-collusion policy before convening.
`ak status` and `ak host status` surface that result read-only; `ak sync` never rewrites
`.claude/skills/qe-court/config.json`. If a config created by 3.13.2 or earlier still
seats both `defense` and `jury` on Cognitum tiers, regenerate it with 3.13.3+ or change
`defense` to `claude-code` so the jury and defense use distinct vendors.

Defaults (all overridable; your edits are marked `custom` and never re-seeded):

| Activity | Host | Default model |
|---|---|---|
| specification, review, release | claude | `claude-sonnet-5` |
| architecture, design, debugging, security-analysis | claude | `claude-opus-5` |
| implementation, testing, security-scan | codex | `gpt-5.4` |
| documentation, packaging | codex | `gpt-5.3-codex` |

*(packaging & release are `ak`-added — ruflo ships templates for feature/security/refactor only.)*

**Known-good model choices** (verified 2026-07; any model your host CLI accepts also works):

> **Per-token price ≠ per-task cost.** A model that needs more agentic turns costs more
> per task at the same per-token price. On subscription (`claude-code` oauth) billing the
> marginal dollar cost is $0 either way, and the extra turns are paid in wall-clock and
> quota instead — so read every note below on the turns axis, not only the price axis.

| Host | Model | When to use |
|---|---|---|
| claude | `claude-opus-5` | new top Opus — same per-token price as 4.8, but ~2–3× the agentic turns on routine work; earns it at the hard end |
| claude | `claude-sonnet-5` | near-Opus capability at a lower per-token price — review, spec, release |
| claude | `claude-fable-5` | top capability (Mythos-class, above Opus 5) — hardest problems |
| claude | `claude-haiku-4-5-20251001` | cheap/fast — high-volume mechanical work |
| claude | `claude-opus-4-8` | prior Opus generation — same per-token price, roughly half the turns on routine work |
| codex | `gpt-5.4` | coding + reasoning + agentic — recommended execution default |
| codex | `gpt-5.6-sol` | newest line; first-class max reasoning effort |
| codex | `gpt-5.3-codex` | pure coding-tuned — mechanical implementation & docs |
| codex | `gpt-5-codex-mini` | smallest/cheapest — escalation floor, high volume |

> **Where Opus 5 sits** ([announcement](https://www.anthropic.com/news/claude-opus-5), July 2026):
> same $5/$25 per-Mtok pricing as Opus 4.8 with roughly double the Frontier-Bench
> performance, which is why it is the reasoning-tier default. That parity is **per token**:
> measured end-to-end it takes 2–3.4× the agentic turns on routine work, so per task it is
> the more expensive arm there and 4.8 remains a defensible pin. It is **not** Mythos-class: `claude-fable-5`
> remains the flagship tier. Opus 5 lands within ~0.5% of Fable on coding/agentic
> benchmarks at about half the cost per task, but stays behind the Mythos-class models on
> frontier domains. Rule of thumb: `claude-opus-5` is the premium default;
> `claude-fable-5` is the escalation ceiling.

`ak host pick --help` prints this list too. Tuning is per-route and reversible: hand-edit
`kit.json` `routing.routes`, pass `--route`, or use `ak host off` to clear it entirely.

**Disabling is complete, not just a flag change.** `ak host pick --host <set>` treats the
set as authoritative. Excluding a routing host removes it from persisted routes and escalation
ladders before AQE is reprojected; seeded entries are removed silently, while a user-pinned route
prints a warning naming the disabled host. It also removes stale agentic-kit-curated AQE overrides
while preserving foreign override keys. Excluding Codex additionally retires only the two
marker-owned Codex MCP bridges; user-registered MCP servers are left alone. Re-enabling Codex
converges those bridges again.

`routing.routes` intentionally names a host and model, not an inference provider. Provider resolution
is a separate binding lookup; absent grounded evidence remains unknown or explicitly inferred.
`ak run` is the canonical host-neutral executor for Claude, Codex, and explicit OpenCode routes.

## Level 4 — drop down to raw ruflo / agentic-qe

This is the part that matters: **`ak` is a facilitator, not a wall.** Every value it manages
is the tool's own native config, and you can set it by hand — or let `ak` and hand-edits
coexist. `ak` merges-not-clobbers and backs up first, mirroring how rUv itself layers config
(`mergeWithDefaults(config, defaults)` — sensible defaults, override with your partial).

The two config stores each knob below lives in — and their precedence — are summarized in
[Two configs, one front door](#two-configs-one-front-door) above.

| You want to…                         | `ak` way                          | The raw ruflo/aqe way it maps to                    |
| ------------------------------------ | --------------------------------- | --------------------------------------------------- |
| Enable claude/codex hosts            | `ak host pick`              | `ENABLE_CLAUDE_CODE` / `ENABLE_CODEX` env + managed bridge/guidance |
| Register a ruflo LLM provider        | `--provider openai:gpt-5.6`       | `ruflo providers configure -p openai -m gpt-5.6`    |
| Set which LLM runs QE                | `--aqe-provider gemini`           | `AQE_LLM_PROVIDER=gemini` (env)                     |
| Order QE's fallback chain            | `--aqe-fallback '…'`              | edit `.agentic-qe/llm-config.json` / `aqe llm-router config` |
| Cap QE spend                         | (kit.json `maxBudgetUsd`)         | `AQE_MAX_BUDGET_USD` / `--max-budget-usd`           |

If you hand-edit `.agentic-qe/llm-config.json` yourself and *don't* use `ak`'s
`--aqe-fallback`, `ak` leaves your file alone — it only manages a chain it owns (the
`_managedBy` tag). Keys always stay in the environment; neither `ak` nor aqe persists them.

## Undo, always

```bash
ak host off     # reset to the claude-only default, reversibly
```

Strips the managed env keys (leaving your other settings), and restores your pre-`ak`
`llm-config.json` from its one-time backup — or removes the file if `ak` created it. `ak
status` and `ak sync` keep everything converged and flag drift in between.

---

**The shape of the whole thing:** Level 0 is the 90% case and costs nothing. Each level up is
one flag, and the bottom is always the tools' own knobs — `ak` never traps your config, it
just makes the good default automatic and the customization reversible.

## Appendix — design references

- Per-activity routing and dual-host seeding: [docs/adr/](adr/) ADR-0001..0005;
  grounded in ruflo's own dual-mode templates.
- Primary-host selection and ambidextrous mirroring:
  [ADR-0006](adr/0006-primary-host-and-ambidextrous-mirroring.md).
- Capability-driven integration axes, bindings, and provenance:
  [ADR-0016](adr/0016-capability-driven-integration-adapters.md).
- Host env flags (`ENABLE_CLAUDE_CODE` / `ENABLE_CODEX`): upstream ruflo
  ADR-034, "Optional MCP Backends".
