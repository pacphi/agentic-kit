# Documentation

The Markdown files in this folder are living guides. Each describes current `ak` behavior and
changes with the behavior it describes. Subfolders have one purpose.

| Folder | Purpose |
| --- | --- |
| [adr/](adr/README.md) | Decision records in every status; never moved |
| [ddd/](ddd/README.md) | Domain model, shared language, boundaries and invariants |
| [schemas/](schemas/README.md) | Versioned interchange contracts |
| [assets/](assets/README.md) | Figures the guides use |
| [plans/](plans/README.md) | In-flight plans and specs |
| [proposals/](proposals/README.md) | Dormant proposals awaiting a decision |
| [archive/](archive/README.md) | Frozen history, one index row per file |

## Using ak

| Guide | Covers |
| --- | --- |
| [Installation](installation.md) | Package location and installation effects |
| [Setup](setup.md) | What `ak setup` changes |
| [Upgrading](upgrading.md) | Updating code and enabling capabilities |
| [Troubleshooting](troubleshooting.md) | Symptoms and repair commands |
| [Providers](providers.md) | Inference providers and routing |
| [Host support](host-support.md) | Claude Code, Codex, OpenCode, Ruflo, AQE and Brain |
| [Dashboard](dashboard.md) | Navigation, evidence and guarded actions |
| [Maintenance](maintenance.md) | Inventory-led maintenance workspace |
| [Hooks](hooks.md) | Auditing and healing hooks |
| [Models](models.md) | Model inventory and change planning |
| [Telemetry](telemetry.md) | Fleet evidence export and aggregation |
| [Observability](observability.md) | Observability tab |
| [AQE embeddings](aqe-embeddings.md) | AQE embedding backend selection and recovery |
| [Codex status line](codex-statusline.md) | Managed Codex status line |
| [deja-vu (archived)](archive/2026-10-03-guide-deja-vu.md) | Retired transcript search companion; removal ships in 4.0.0-beta.1 |
| [Dev containers](devcontainers.md) | Development container configurations |
| [Hermes host adapter](hermes-host-adapter.md) | External host-adapter contract |
| [Codex usage diagnostic](codex-usage-diagnostic.md) | Usage-parser verification |

## Extending and maintaining ak

| Guide | Covers |
| --- | --- |
| [Authoring host adapters](authoring-host-adapters.md) | Adding an agent CLI |
| [Maintainer's guide](maintainer.md) | Architecture, testing, branching and releases |
| [Managed tools](managed-tools.md) | Managed-tool install/update/display contract |
| [Transcripts](transcripts.md) | Transcript pipeline and session detail |
| [Usage scorecard metrics](usage-scorecard-metrics.md) | Scorecard formulae and evidence |
| [Upstream watch](upstream-watch.md) | Registry and upstream monitor |
| [Maintenance acceptance](maintenance-acceptance.md) | Requirements and open release gates |
| [Host-adapter freeze checklist](host-adapter-freeze-checklist.md) | Evidence for adapter contract freeze |
| [Local model validation](local-model-validation.md) | Protocol for ADR-0011 |
| [Language coverage](language-coverage.md) | Language-detection baseline |
| [Language logos](language-logos.md) | Bundled language-logo sources and licenses |
| [Date and time presentation](date-time-presentation.md) | Dashboard date and time formatting |

Markdown file names are lower case. `README.md`, `CLAUDE.md`, `AGENTS.md`, and `SKILL.md` are
the only exceptions. [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md) define the repository
rules, which `tests/kit/docs-layout.test.mjs` enforces.
