# Issue 211: core guides, deployment instructions, and field manual

Baseline: `67fb5c0a57400004a7f878780680a6e07834b264`. Audit date: 2026-09-09.
This matrix covers the 12 integration-owned baseline documents. It records source comparison,
not a claim that every deployment, release, or upstream repair was executed.

## Findings

| ID | Priority | Finding and disposition |
| --- | --- | --- |
| CORE-01 | P1 | Generic repository instructions advertised nonexistent scripts, speculative performance guarantees, and conflicting coordination settings. Corrected commands/stack; distinguished workflow preferences and upstream vocabulary from live capabilities. |
| CORE-02 | P1 | Dashboard help/field manual claimed global read-only and no-egress behavior. Corrected documentation and help copy to include caches/version checks and guarded Maintenance actions. Runtime logic unchanged. |
| CORE-03 | P1 | Broad teardown and configuration-preservation claims exceeded surface-specific ownership. Narrowed statements and linked the provider/initialization boundaries. |
| CORE-04 | P1 | Installation/troubleshooting excluded Windows runtime discovery despite implemented survey/cwd probes. Corrected platform coverage and permission-dependent degradation. |
| CORE-05 | P2 | Maintainer command inventory, local gates, branch cleanup, and release-auth instructions were stale. Reconciled with dispatch maps, package scripts, workflows, and current npm token documentation. |
| CORE-06 | P2 | Docker guides promised fresh installs on every restart and absolute isolation. Documented writable-layer reuse, repeated setup, artifact mount/port boundaries, and explicit environment forwarding. |
| CORE-07 | P2 | Dev-container guide differed from actual privileged setup/link commands and claimed Claude was a setup prerequisite. Corrected the commands and separated installation from inference authentication. |
| CORE-08 | P2 | The public field manual presented alpha.41 captures and active-writer/billing claims as current proof. Labelled historical excerpts/screenshots and corrected operative text without altering captured images. |
| CORE-09 | P2 | Date/time audit still listed a resolved Context UTC-slice issue as current. Marked it resolved and identified remaining locale-specific rendering as a separate implementation gap. |
| CORE-10 | P2 | Troubleshooting still referenced cache v18, no Windows support, and filename-based deletion safety. Updated current states/schema and required contents/ownership evidence before deletion. |
| CORE-11 | P2 | Current Markdown/link gates excluded maintainer, Docker, and shipped-reference documentation. Expanded existing gates and fixed newly surfaced formatting errors. |
| CORE-12 | P2 | `engines.node: >=22` was treated as an effective minimum for all SQLite operations. Documented the unflagged SQLite 22.13 boundary and recommended maintained patch releases; manifest/runtime-floor follow-up remains. |
| CORE-15 | P2 | Selected npm-bundled documents linked to omitted local files. Converted 88 repository-only targets to explicit GitHub documentation URLs without changing package contents. |
| CORE-14 | P2 | Generated model-help notes asserted unsupported task ratios/superiority. Replaced editorial note text and the theoretical price-axis explanation; model IDs, tiers and routing decisions are unchanged. |
| CORE-13 | P2 | Standalone diagnostic guidance still invited full output sharing despite printing the scan root. Corrected sharing advice and limited its parity claim to the actual historical comparison. |

## Per-document coverage

| File | Evidence inspected | Disposition | Validation / limits |
| --- | --- | --- | --- |
| `AGENTS.md` | `package.json`; `bin/agentic-kit.mjs`; `src/commands/setup.mjs`; collaboration/authority rules | CORE-01: corrected ESM stack and actual scripts; preserved authority/data rules; upstream examples are not an enabled-tool inventory | Markdown and command-surface checks; no upstream swarm/runtime guarantee |
| `CLAUDE.md` | `AGENTS.md`; `src/lib/blocks.mjs` | CORE-01: one repository workflow reference replaces conflicting swarm constants; AQE sentinel preserved | Markdown; no machine guidance synchronization |
| `MAINTAINER.md` | `package.json`; dispatch maps; `.github/workflows/{ci,release,nightly,devcontainers,pages}.yml`; native SQLite import | CORE-02,03,05,11,12: current commands, gates, release credential/branch guidance, narrowed verification claims | Source comparison, help tests, Markdown; no publish/token mutation |
| `README.md` | setup/sync/usage command modules; model owner-visible read model; Dashboard/Maintenance routes | CORE-02,03,05,12: scoped checks and routing, correct usage verbs, current model privacy, runner prerequisites | Help/guidance checks; no universal health, billing or preservation claim |
| `docker/USER-GUIDE.md` | `docker/{Dockerfile,compose.yaml,entrypoint.sh}`; installed `codex login --help` | CORE-06: creation versus restart, setup failure/credential handling, explicit mount boundary, valid relative artifacts path | Static manifest/entrypoint comparison; no container/image install run |
| `docker/MAINTAINER-GUIDE.md` | same Docker definitions; Bash `set -e` with `&&` behavior | CORE-06,11: explicit `run -e` overrides, attempted artifacts rather than success receipts, lint coverage | Safe shell-semantics reproduction; no container or upgrade run |
| `docs/DATE-TIME-PRESENTATION.md` | `src/lib/dashboard/client/{datetime,usage-context-hooks,intelligence}.mjs`; `dashboard/context-card.mjs` | CORE-09: original contract remains normative; current resolved and unresolved surfaces distinguished | Source/tests; no formatting implementation changed |
| `docs/DEVCONTAINERS.md` | both `devcontainer.json` files; `consumer/postCreate.sh`; workflow paths | CORE-07: actual sudo/link command, source versus published install, pinned sync example | Shell syntax and manifest inspection; no Codespaces deployment |
| `docs/INSTALLATION.md` | package whitelist; SQLite; native process survey; MCP scope migration; model read model | CORE-03,04,07,12: actual platform/ownership/package-manager boundaries | Current npm/Node docs plus source; installation examples not executed against user state |
| `docs/OBSERVABILITY.md` | `live/{process-sessions,replay-stream,transcript-streams,workspace-store}.mjs`; ADR-0012 | CORE-04: Windows presence and bounded replay versus deferred archive | Existing fixture tests; no claim of durable content history |
| `docs/TROUBLESHOOTING.md` | source health, context renderers, cache schema20, runtime survey, memory-routing audit | CORE-04,10: actionable current symptoms and conservative deletion guidance | Source/contract tests; no mutating repair or live memory canary run |
| `explainer.html` | current dispatch, Dashboard routes, setup/teardown, statusline source; embedded alpha.41 excerpt | CORE-02,03,05,08,12: public claims aligned; historical captures labelled | Chromium desktop/mobile rendering, no script errors or horizontal overflow; old screenshots intentionally retained |

## Embedded documentation and check configuration

The same corrections update only comments or user-facing text in `bin/agentic-kit.mjs`,
`src/commands/x/dashboard.mjs`, model-help note strings/comments in `src/lib/routing.mjs`,
`.github/workflows/release.yml`,
`.github/workflows/nightly.yml`, `docker/compose.yaml`, and the printed example in
`.devcontainer/consumer/postCreate.sh`. Command behavior, authorization checks, schemas, and
release steps are unchanged. `package.json`, `.markdownlint-cli2.jsonc`, and the CI/nightly link-job arguments widen
the existing documentation validation scope; the offline check also validates fragments. This is not an implementation patch for the product follow-ups.

## External references

- [npm CI authentication](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/)
  and [access tokens](https://docs.npmjs.com/about-access-tokens/): current token capability,
  expiry and trusted-publishing distinction, inspected 2026-09-09.
- [npm exec](https://docs.npmjs.com/cli/npm-exec/): explicit package/binary selection and aliases.
- [Node SQLite](https://nodejs.org/api/sqlite.html): introduced 22.5, unflagged from 22.13;
  this does not establish every application's minimum patch version.

The full baseline file/hash inventory is [211-inventory.csv](211-inventory.csv). Cross-layer
corrections and source defects are consolidated in [the audit report](211-documentation-audit.md).
