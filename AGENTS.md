<!-- Codex-side project instructions (mirror of CLAUDE.md). Full ruflo + agentic-qe
     operating guidance lives machine-wide at ~/.codex/AGENTS.md / ~/.claude/CLAUDE.md. -->

# Ruflo Machine Ref (Codex / AGENTS.md)

This repo (`@pacphi/agentic-kit`) is a plain-ESM Node.js CLI — **zero runtime
dependencies**; only `bin/`, `src/`, and `claude/` ship. Tooling (eslint, tsc
`--checkJs`, markdownlint, lychee) is devDependencies only. Codex reads this file
the way Claude Code reads `CLAUDE.md`; keep the two in sync.

## Swarm Config

- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

```bash
ruflo swarm init --topology hierarchical --max-agents 15 --strategy specialized
```

## Build & Test

```bash
pnpm test          # node --test unit suite + statusline segments
pnpm run check     # typecheck + lint + markdown lint + build + test
pnpm run build     # packaging + CLI-load validation (no transpile — plain ESM)
```

## Operating rules

- Do what's asked; nothing more. Prefer editing existing files over new ones.
- Never commit secrets or `.env` files. Never auto-commit/push without an explicit ask.
- **No `Co-Authored-By` trailer** unless `.claude/settings.json` sets `attribution.commit`.
- Keep files under ~500 lines; validate input at boundaries.

## Agentic QE v3
<!-- managed by ruflo-setup-aqe — aqe init skips regeneration when this sentinel is present -->
<!-- see ~/.claude/CLAUDE.md for full AQE operating guidance -->
