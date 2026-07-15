# 🧰 @pacphi/agentic-kit

[![CI](https://github.com/pacphi/agentic-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/pacphi/agentic-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@pacphi/agentic-kit/next?label=npm%40next)](https://www.npmjs.com/package/@pacphi/agentic-kit)
[![node](https://img.shields.io/node/v/@pacphi/agentic-kit)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/@pacphi/agentic-kit)](LICENSE)

**One npm package that makes [ruflo](https://github.com/ruvnet/ruflo) (claude-flow) and [agentic-qe](https://github.com/proffesor-for-testing/agentic-qe) actually work — installed, healed, and *proven* — on macOS, Linux, and Windows.**

```bash
npm install -g @pacphi/agentic-kit@next   # alpha channel until 4.0.0 GA
ak setup        # once per machine; run it inside a git repo to set that project up too
```

That's the only package you install by hand — **you do not need to install ruflo or
agentic-qe yourself.** `ak setup` installs them globally for you (building natives past
npm ≥11.17's `allow-scripts` gate), then heals and proves them.

## Why this exists

ruflo promises persistent memory, self-learning, security scanning, and background
workers for Claude Code. In practice, a stock install drifts into quietly broken
states: native SQLite bindings get dropped by npm upgrades (memory writes vanish
while printing "OK"), packages the CLI still imports stop shipping
([#2670](https://github.com/ruvnet/ruflo/issues/2670) left prompt-injection defense
silently dead), pattern stores corrupt on interrupted writes, statuslines regenerate
without telling you what's actually on, and background daemons used to burn tokens
unsupervised. Upstream fixes land steadily — this kit's job is the *gap*: detect
drift, converge to a healthy state, and **prove it** rather than assume it.

The full investigative history behind each guard (with filed upstream issues) lives
in [docs/archive/](docs/archive/).

## Four commands

```text
ak              status + one suggested next action
ak setup        first-time setup — machine and/or the project you're standing in
                                                    [--project] [--minimal] [--yes] [--no-aqe] [--no-security] [--reconfigure]
ak status       read-only dashboard: what's true, what's drifted   [--json] [--deep]
ak sync         converge to good: upgrade + heal + verify          [--dry-run] [--no-upgrade]
ak uninstall    leave cleanly                                      [--dry-run] [--purge]
```

(`ak` is the daily-driver alias; the full `agentic-kit` command is identical.
Heads-up if you also use AutoKitteh: its CLI is also named `ak` — the full
command always works.)

**When in doubt: `ak sync`.** Every mutating command takes `--dry-run` and
prints its plan with reasons — you always see the impact before anything changes.

What the verbs cover:

| Verb | What it does |
| ------ | -------------- |
| **setup** | Installs/updates ruflo + agentic-qe globally (handling npm ≥11.17's `allow-scripts` so natives build), deploys the token-audit skill, merges the managed guidance blocks into `~/.claude/CLAUDE.md`, offers one-time MCP registration (user scope, with a tool-family picker), and — inside a repo — initializes the project: sanitized `ruflo init`, absolute memory-path pin, a **verified** store→disk write, statusline footer, and a background daemon with **local-only ($0) workers** (token-spending AI workers stay opt-in behind upstream's machine-wide budget). Project scope triggers on a `.git` directory in the current folder; without one it's skipped with a note. `--project` forces it anyway (e.g. a not-yet-`git init`-ed folder), `--minimal` skips it, `--yes` accepts all prompts (non-interactive), `--no-aqe` / `--no-security` disable those subsystems, and `--reconfigure` re-offers MCP registration. |
| **status** | Per-subsystem ✓/⚠/✗ (versions, the kit's own version, natives, security, learning, aqe/RVF, MCP, **hosts** (claude/codex — version + install method, or "enabled but not installed"), **providers** (host wiring + aqe fallback chain, or "drifted"/claude-only default), daemons, CLAUDE.md blocks, statusline), each drift row naming what `sync` would do about it. |
| **sync** | The one convergence verb: upgrades first when a new release exists, then re-heals everything an upgrade wipes, then re-checks and reports. Included in that heal: it **installs any enabled frontier host** (claude/codex) that's entirely absent — never touching an external (mise/brew/native) install — and **re-applies provider wiring** (the `ENABLE_*` host env, the aqe fallback chain, and ruflo API providers) whenever it has drifted. It also **self-updates the kit**: when a newer `@pacphi/agentic-kit` exists it installs it as the *last* step (the new code applies from the next `ak` run, never mid-sync). Prerelease installs (`4.0.0-alpha.*`) track the `next` npm dist-tag as well as `latest`, so alphas see their successors; stable installs only ever follow `latest`. `--no-upgrade` skips the self-update along with the package upgrades. |
| **uninstall** | Removes the kit's footprint (and any legacy shell-kit install); project data is never touched; `--purge` also offers to remove the global packages. |

Power-user mechanisms live under `ak x …` (`daemon-gc`, `mcp pick|off`,
`provider status|pick|off`, `reference diff|sync`, `verify learning|security|aqe`,
`improvement-eval`) — see `ak --help --all`.

## The status line

Projects set up by the kit get an append-only footer under ruflo's own status line,
each segment shown **only when genuinely active**: 🧠 SONA patterns/trajectories (+
live micro-LoRA Δ‖W‖), 📈 route-RL metrics, 🛡 aidefence, ⚙ machine-wide daemon
count, and 🎓 Agentic-QE stats.

## Requirements

Node ≥ 22, npm, and the `claude` CLI (Claude Code). That's the whole list —
**ruflo and agentic-qe are not prerequisites; `ak setup` installs them for you**
(pre-installing them is fine too — setup just detects and reuses them). Everything
else — including SQLite — is embedded; there are no runtime dependencies. npm stays
required at runtime even though this repo develops with pnpm: the kit heals the
*npm-managed* global ruflo/agentic-qe trees (`npm root -g`, `npm i -g`), which is how
those packages are installed on target machines. (pnpm-managed globals: tracked follow-up.)

### Frontier hosts & LLM providers

`ak` detects the frontier-agent CLIs on your machine and can wire ruflo + agentic-qe to
one or both — **claude-default, codex opt-in**, so existing repos see zero change until
you opt in. Two independent axes:

- **Hosts** — which agent CLI runs the ruflo loop: `claude` (Claude Code) and/or `codex`
  (OpenAI Codex), both at once via dual-mode. A host that is *entirely absent* is installed
  for you (`npm i -g @anthropic-ai/claude-code` / `@openai/codex`); an externally-managed
  install (mise/brew/native) is detected, reused, and never shadowed.
- **Providers** — which LLM the routers use, independent of the host: agentic-qe's
  `AQE_LLM_PROVIDER` (`claude-code`/`claude`/`openai`/`gemini`/`openrouter`/`azure-openai`/
  `bedrock`/`cognitum`/`ollama`/`onnx`) plus an ordered fallback chain, and ruflo's API providers.
  API keys stay in the environment — never written to `kit.json`.

`ak x provider status` shows what's detected and wired; `ak x provider pick` chooses and
applies (reversibly); `ak x provider off` restores the claude-only default. Full guide:
[docs/PROVIDERS.md](docs/PROVIDERS.md).

## Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → `agentic-kit` command.

## Credits

ruflo/claude-flow by ruvnet · agentic-qe by proffesor-for-testing · prior art:
Ciprian Melian's repair gist · upstream issues filed from this kit's verification
work: [#2219](https://github.com/ruvnet/ruflo/issues/2219),
[#2222](https://github.com/ruvnet/ruflo/issues/2222),
[#2239](https://github.com/ruvnet/ruflo/issues/2239),
[#2360](https://github.com/ruvnet/ruflo/issues/2360),
[#2549](https://github.com/ruvnet/ruflo/issues/2549),
[#2670](https://github.com/ruvnet/ruflo/issues/2670).

> v4 (npm, cross-platform). The shell-based v3 kit is archived in
> [docs/archive/](docs/archive/) — `ak setup` migrates an existing shell-kit
> install automatically. A thin, reversible layer — not a fork. PRs welcome.
