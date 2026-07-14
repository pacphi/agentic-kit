# 🧰 ruflo-machine-kit

**One npm package that makes [ruflo](https://github.com/ruvnet/ruflo) (claude-flow) and [agentic-qe](https://github.com/proffesor-for-testing/agentic-qe) actually work — installed, healed, and *proven* — on macOS, Linux, and Windows.**

```bash
npm install -g github:pacphi/ruflo-machine-ref
ruflo-kit setup        # once per machine; run it inside a repo to set that project up too
```

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
ruflo-kit              status + one suggested next action
ruflo-kit setup        first-time setup — machine and/or the project you're standing in
ruflo-kit status       read-only dashboard: what's true, what's drifted   [--json] [--deep]
ruflo-kit sync         converge to good: upgrade + heal + verify          [--dry-run] [--no-upgrade]
ruflo-kit uninstall    leave cleanly                                      [--dry-run] [--purge]
```

**When in doubt: `ruflo-kit sync`.** Every mutating command takes `--dry-run` and
prints its plan with reasons — you always see the impact before anything changes.

What the verbs cover:

- **setup** — installs/updates ruflo + agentic-qe globally (handling npm ≥11.17's
  `allow-scripts` so natives build), deploys the token-audit skill, merges the
  managed guidance blocks into `~/.claude/CLAUDE.md`, offers one-time MCP
  registration (user scope, with a tool-family picker), and — inside a repo —
  initializes the project: sanitized `ruflo init`, absolute memory-path pin, a
  **verified** store→disk write, statusline footer, and a background daemon with
  **local-only ($0) workers** (token-spending AI workers stay opt-in behind
  upstream's machine-wide budget).
- **status** — per-subsystem ✓/⚠/✗ (versions, natives, security, learning, aqe/RVF,
  MCP, daemons, CLAUDE.md blocks, statusline), each drift row naming what `sync`
  would do about it.
- **sync** — the one convergence verb: upgrades first when a new release exists,
  then re-heals everything an upgrade wipes, then re-checks and reports.
- **uninstall** — removes the kit's footprint (and any legacy shell-kit install);
  project data is never touched; `--purge` also offers to remove the global packages.

Power-user mechanisms live under `ruflo-kit x …` (`daemon-gc`, `mcp pick|off`,
`reference diff|sync`, `verify learning|security|aqe`, `improvement-eval`) — see
`ruflo-kit --help --all`.

## The status line

Projects set up by the kit get an append-only footer under ruflo's own status line,
each segment shown **only when genuinely active**: 🧠 SONA patterns/trajectories (+
live micro-LoRA Δ‖W‖), 📈 route-RL metrics, 🛡 aidefence, ⚙ machine-wide daemon
count, and 🎓 Agentic-QE stats.

## Requirements

Node ≥ 22, npm, and the `claude` CLI (Claude Code). Everything else — including
SQLite — is embedded; there are no runtime dependencies. npm stays required at
runtime even though this repo develops with pnpm: the kit heals the *npm-managed*
global ruflo/agentic-qe trees (`npm root -g`, `npm i -g`), which is how those
packages are installed on target machines. (pnpm-managed globals: tracked follow-up.)

## Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → `ruflo-kit` command.

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
> [docs/archive/](docs/archive/) — `ruflo-kit setup` migrates an existing shell-kit
> install automatically. A thin, reversible layer — not a fork. PRs welcome.
