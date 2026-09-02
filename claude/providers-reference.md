<!-- BEGIN ruflo-providers-reference -->
<!-- Included when Codex is enabled; PATH detection is a legacy fallback. -->
<!-- Machine-scoped and managed by agentic-kit; do not edit within sentinels. -->

## Hosts and inference providers

Execution host and inference provider are independent facts. `claude`, `codex`,
`opencode`, and admitted external adapters run work; configured model providers serve
inference. A host/model route is intent, not proof of the vendor or live capability.

`ak host` persists host, provider, routing, and fallback intent in `kit.json`; `ak sync`
reconciles owned projections and `ak status` reports evidence and drift. API keys remain
in the environment and are never written to `kit.json`.

```bash
ak host status
ak host pick
ak host off
ak run feature "task" --dry-run
```

Agentic-kit may install an enabled host only when absent and may update installations it
owns. Homebrew, mise, native-installer, plugin, and other user-owned installations remain
self-managed. Preserve user-owned MCP entries and optional interactive plugins.

For fallbacks, budgets, provider IDs, and current models, inspect `ak host status` and the
project documentation rather than relying on this compact block. Vendor-diverse review
requires independently evidenced providers; multiple hosts alone are insufficient.
<!-- END ruflo-providers-reference -->
