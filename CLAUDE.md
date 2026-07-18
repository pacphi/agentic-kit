<!-- Full ruflo CLI reference: see machine-wide ruflo reference at ~/.claude/CLAUDE.md -->

# Ruflo Machine Ref

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
pnpm test          # full unit suite (node --test tests/kit + the cjs suites)
pnpm run check     # typecheck + lint + markdown lint + build + test
```

## Agentic QE v3
<!-- managed by ruflo-setup-aqe — aqe init skips regeneration when this sentinel is present -->
<!-- see ~/.claude/CLAUDE.md for full AQE operating guidance -->
