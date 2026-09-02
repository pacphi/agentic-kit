<!-- BEGIN ruflo-aqe-reference -->
<!-- Included when agentic-kit manages AQE; PATH detection is a legacy fallback. -->
<!-- Managed by agentic-kit. Refresh with: ak x reference sync -->

## Agentic-QE (AQE)

Use AQE for test generation/execution, coverage, security scans, and quality gates.
Project `.agentic-qe/` instructions remain authoritative for enabled domains and local
commands. Discover the live MCP surface when needed and call `fleet_init` before other
AQE fleet tools.

Non-negotiable policies:

- Never fabricate tests, data, coverage, or a passing result. Execute the applicable
  checks and disclose unavailable evidence.
- Do not delete `.agentic-qe/`, databases, or generated evidence without confirmation
  and a recoverable backup.
- Never commit or push unless explicitly requested.
- Avoid watch-mode test commands in automation; use the repository's bounded run mode.
- API keys stay in the environment. Respect configured provider, fallback, and spend
  limits; host count alone does not prove vendor diversity.

Common capabilities are fleet status, enhanced test generation, parallel execution,
coverage analysis, quality assessment, security scanning, and memory query/store. Use
tool discovery or `aqe --help` for exact current names and schemas instead of relying on
an eagerly loaded catalogue.

`aqe init` owns project-specific projection. Agentic-kit manages machine provider intent
through `ak host`; run `ak sync` after upgrades and `aqe health` for runtime/billing
evidence. Do not overwrite foreign hooks, status lines, or user environment settings.
<!-- END ruflo-aqe-reference -->
