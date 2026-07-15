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

---

## Level 0 — do nothing (the point)

Install `ak`, run `ak setup`. Claude Code is the host, agentic-qe uses its own default, and
nothing about providers is written anywhere. This is the whole feature for most people:
**it already works, and `kit.json` stays at its defaults.**

```
ak setup      # claude just works; codex/other providers are opt-in
ak status     # shows a "hosts" + "providers" row so you can see what's true
```

If you happen to have `codex` installed, `ak` notices and *offers* — it never flips it on
for you:

```
ℹ codex CLI detected — run `ak x provider pick` to let ruflo use both claude and codex
```

## Level 1 — turn on codex (one command)

```
ak x provider pick
```

An interactive picker (or flags for scripts). Enable `codex` and `ak`:
- installs it if it's missing (`npm i -g @openai/codex`) — but leaves an existing
  mise/brew/native install alone,
- runs `ruflo init --dual` (ruflo's "Claude Code + Codex hybrid" mode),
- writes `ENABLE_CLAUDE_CODE` / `ENABLE_CODEX` into `.claude/settings.local.json`.

```
ak x provider pick --host claude,codex --yes     # non-interactive
```

## Level 2 — choose which LLM runs QE

agentic-qe can run its analysis on any of: `claude-code` (your Claude subscription),
`claude` / `openai` / `gemini` / `openrouter` / `azure-openai` / `bedrock` / `cognitum`
(metered API key), or `ollama` (local).

```
ak x provider pick --aqe-provider claude-code    # run QE on your subscription, no API bill
```

`ak` writes `AQE_LLM_PROVIDER` for you. Add `OPENAI_API_KEY` to your env and agentic-qe's
router will **auto-enable** OpenAI as a fallback on its own — you don't have to list it.

## Level 3 — a deterministic fallback chain

When you want explicit ordering rather than env auto-enable, `ak` manages agentic-qe's
`.agentic-qe/llm-config.json` from `kit.json`:

```
ak x provider pick \
  --aqe-provider claude-code \
  --aqe-fallback 'claude-code:claude-opus-4-8; openai:gpt-5.6; gemini:gemini-3.5-flash'
```

Each `provider:model,model` becomes an ordered chain entry (first = highest priority). `ak`
writes a complete, schema-correct chain, tags it `_managedBy: agentic-kit`, and **never**
writes your API keys.

> Model IDs above are examples current as of July 2026 (Claude Opus 4.8, OpenAI GPT-5.6 —
> or `gpt-5.3-codex` for agentic coding — Google Gemini 3.5 Flash). Use whatever IDs your
> provider currently offers; `ak` writes the strings you give it verbatim.

## Level 4 — drop down to raw ruflo / agentic-qe

This is the part that matters: **`ak` is a facilitator, not a wall.** Every value it manages
is the tool's own native config, and you can set it by hand — or let `ak` and hand-edits
coexist. `ak` merges-not-clobbers and backs up first, mirroring how rUv itself layers config
(`mergeWithDefaults(config, defaults)` — sensible defaults, override with your partial).

| You want to…                         | `ak` way                          | The raw ruflo/aqe way it maps to                    |
| ------------------------------------ | --------------------------------- | --------------------------------------------------- |
| Enable claude/codex hosts            | `ak x provider pick`              | `ENABLE_CLAUDE_CODE` / `ENABLE_CODEX` env (ADR-034) + `ruflo init --dual` |
| Register a ruflo LLM provider        | `--provider openai:gpt-5.6`       | `ruflo providers configure -p openai -m gpt-5.6`    |
| Set which LLM runs QE                | `--aqe-provider gemini`           | `AQE_LLM_PROVIDER=gemini` (env)                     |
| Order QE's fallback chain            | `--aqe-fallback '…'`              | edit `.agentic-qe/llm-config.json` / `aqe llm-router config` |
| Cap QE spend                         | (kit.json `maxBudgetUsd`)         | `AQE_MAX_BUDGET_USD` / `--max-budget-usd`           |

If you hand-edit `.agentic-qe/llm-config.json` yourself and *don't* use `ak`'s
`--aqe-fallback`, `ak` leaves your file alone — it only manages a chain it owns (the
`_managedBy` tag). Keys always stay in the environment; neither `ak` nor aqe persists them.

## Undo, always

```
ak x provider off     # reset to the claude-only default, reversibly
```

Strips the managed env keys (leaving your other settings), and restores your pre-`ak`
`llm-config.json` from its one-time backup — or removes the file if `ak` created it. `ak
status` and `ak sync` keep everything converged and flag drift in between.

---

**The shape of the whole thing:** Level 0 is the 90% case and costs nothing. Each level up is
one flag, and the bottom is always the tools' own knobs — `ak` never traps your config, it
just makes the good default automatic and the customization reversible.
