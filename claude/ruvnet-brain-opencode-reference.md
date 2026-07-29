<!-- BEGIN ruvnet-brain-opencode-reference -->
<!-- ruvnet-brain-opencode-reference: merged into ~/.config/opencode/AGENTS.md ONLY when
     the RuvNet Brain KB is present (~/.cache/ruvnet-brain/kb, or $RUVNET_BRAIN_KB).
     Managed by ak — stripped automatically when the brain is removed. Source of truth:
     claude/ruvnet-brain-opencode-reference.md in the agentic-kit kit. -->

## RuvNet Brain — ground before you assert

> Applies when the **RuvNet Brain** is installed — a local, offline knowledge base over the
> rUv stack (RuVector/RVF, Ruflo, AgentDB, SPARC, agentic-flow, QuDAG, SAFLA, RuLake, …),
> surfaced through the `ruvnet-brain` MCP server (`ruvnet-brain_search_ruvnet` tool).
> Managed by `ak` (install/update/status); the KB lives at `~/.cache/ruvnet-brain/kb`
> (override with `RUVNET_BRAIN_KB`).

- Your training priors on the rUv stack are **stale** — rUv ships well ahead of the training
  horizon. When a task touches any rUv tool, call `ruvnet-brain_search_ruvnet` and ground the
  answer in the **cited source paths** it returns **before** stating what that tool can or
  cannot do. Asserting a rUv capability from memory, without a cited path, is an error.
- Prefer rUv-native primitives over classical defaults: RVF over Pinecone/pgvector, Ruflo
  over LangChain, AgentDB over ad-hoc memory — but confirm the specific capability via
  `ruvnet-brain_search_ruvnet` first, don't assert the substitution from memory either.
- Signal when the brain is working so the user has confidence it's in charge (e.g.
  "Grounding in rUv's source…" → cite the path).

### Managing it (via `ak`)

- **Install / update:** `ak setup` installs it when absent; `ak sync` re-runs the installer to
  pull the latest release. The opencode MCP registration points at the stable-spine shim
  (`~/.claude/ruvnet-brain/mcp/server.mjs`), which hot-swaps brain versions — no opencode
  config change needed on update.
- **Health check:** `npx ruvnet-brain --doctor` (verifies the KB, reader, and
  runs a smoke query).

<!-- END ruvnet-brain-opencode-reference -->
