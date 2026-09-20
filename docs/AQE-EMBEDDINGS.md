# AQE semantic embeddings

Agentic-kit manages the selected backend and its supported host projections.
Agentic QE computes vectors and owns embedding-space identity and recovery.
LLM subscriptions and provider routing do not supply an embedding backend.

## First installation

`ak setup` preserves an explicitly configured endpoint. Otherwise it recommends
local Ollama and MiniLM, with no API key and no Docker requirement. Before setup
applies changes, its manifest explains the approximately 45 MB model download,
the AQE request alias and the host environment changes.

Install the native [Ollama application](https://ollama.com/download), start its
service (`ollama serve` when using the CLI), then run:

```sh
ak setup --aqe-embedding-mode local
```

Setup downloads `all-minilm:22m` only if needed and creates the
`Xenova/all-MiniLM-L6-v2` request alias only if absent. An existing alias is
preserved and tested. Repeated setup does not redownload an existing model.
The endpoint must produce valid 384-dimensional vectors with meaningful semantic
ordering. A missing service, missing runtime or failed proof leaves setup
incomplete with actionable guidance; it never substitutes hash vectors or prints
a green completion message. Keep Ollama's model store on durable local storage.

`--yes` accepts the disclosed setup plan. `--dry-run` makes no changes and does
not contact or start a model service. The kit does not silently install a daemon.

## Existing installation and alternatives

Existing installations remain unmanaged until explicit configuration or setup.
This prevents an upgrade selecting a different embedding space without intent.
Inspect and choose without reinitializing your project:

```sh
ak x aqe-embedding status
ak x aqe-embedding configure --aqe-embedding-mode local --dry-run
ak x aqe-embedding configure --aqe-embedding-mode local --yes
ak x aqe-embedding prepare --yes
ak x aqe-embedding verify
```

| Choice | Appropriate use | What Kit does |
| --- | --- | --- |
| Local Ollama | Recommended local, no-key setup | Downloads missing MiniLM and alias after consent; tests the selected service |
| Existing endpoint | Shared or separately operated service | Preserves selection, projects configuration and tests synthetic text; never manages remote models |
| In-process | Explicit upstream transformer-package opt-in | Tests the installed backend and existing cache; does not install the security-sensitive optional package |
| Unmanaged | Operator owns configuration, or semantic learning is deferred | Restores only unchanged owned projection values; makes no semantic readiness claim |

```sh
ak x aqe-embedding configure --aqe-embedding-endpoint https://embed.example --yes
ak x aqe-embedding configure --aqe-embedding-endpoint unix:/absolute/embedder.sock --yes
ak x aqe-embedding configure --aqe-embedding-mode in-process --yes
ak x aqe-embedding configure --aqe-embedding-mode unmanaged --yes
```

In-process transformers are an explicit security opt-in in AQE's published
runtime. Consult the installed AQE guidance and dependency advisories before
installing its optional package. Read-only verification never downloads weights;
prepare the local cache through the upstream tool before verifying it.

Remote endpoints require HTTPS; normal AQE use can send project text there.
Tokens belong in `AQE_EMBEDDER_TOKEN` in the consuming environment, never kit.json,
endpoint URLs, receipts or committed project configuration.

## Environment and ownership

Kit-launched diagnostics use the saved selection. A direct `aqe` command uses
the current shell environment instead. For the local default, new shells can set:

```sh
export AQE_EMBEDDER_ENDPOINT=http://127.0.0.1:11434
```

Persist this in your shell configuration if you use direct AQE commands. Restart
agent sessions after changing MCP environments; existing processes retain their
old environment and may retain an earlier failed initialization.

Claude project MCP and hook settings and existing canonical Codex MCP tables
have field-level receipts. OpenCode updates immediately through a narrow operation inside its existing
full-entry owner, preserving permissions, plugins and unrelated MCP entries.
Its receipt remains compatible with normal `ak sync`. Conflicting user values and unsupported TOML forms
are reported, never overwritten. Codex shell-environment policies are not edited.
Higher-precedence Claude local/user registrations are checked for conflict.
Setup relinquishes unchanged owned values before AQE regenerates its tables,
then reapplies the selected environment afterward.

## Reading verification results

`ak x aqe-embedding verify` proves the backend with synthetic text.
`ak x verify aqe` also checks the current project's stored SQLite embedding
provenance and reports storage observations. These are separate claims:

- A configured URL is not a running service or an installed model.
- A backend pass does not certify old vectors or a complete QE fleet.
- Missing active identity means compatibility cannot be compared, not mismatch.
- Unknown legacy provenance remains unverified.
- Different stored and active space IDs require an explicit migration decision.
- Busy RVF storage does not establish corruption or the owning process's health.
- SQLite provenance evidence does not certify every RVF or ANN index.

Changing server, model, quantization or endpoint location can change AQE's space
identity even when the model name and dimensions match. Preserve the old corpus;
use upstream migration/re-embedding procedures only after a separate recovery
plan. Setup, sync and these diagnostics never relabel or backfill old vectors.
