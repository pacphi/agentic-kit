# Archive Documentation

This directory contains research, architectural audits, and historical design documents.

## Project Configuration & Inventory Audit

### Host Agent Configuration Scope (Claude, Codex, OpenCode)

- **Claude**: Supports workspace/project rules, MCP servers (`.mcp.json` / `.claude/mcp.json`), and local workspace plugins.
- **Codex**: Manages AGENT.md rules, project configuration overrides, and local extensions.
- **OpenCode**: Supports repo-level rules, custom agent configurations, and plugin bindings.

### Project-Without-ProjectId Edge Case

When project-scoped assets (rules, plugins, MCP configurations) are detected without an explicit `projectId` association:
1. Inventory scanning must flag them as unlinked project assets rather than defaulting to global scope.
2. Projection logic must apply opt-in filters so unlinked project assets are not inadvertently published or synchronized globally.

### Inventory Visibility & Write Rules Roadmap

1. **Explicit Scoping**: Distinguish global vs project-scoped assets clearly across all host adapters.
2. **Opt-in Filtering**: Require explicit opt-in for project-scoped asset exposure.
3. **Write Isolation**: Enforce project boundaries during asset write and sync operations to prevent host cross-contamination.
