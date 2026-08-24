# Use Hermes through the external host adapter

This guide explains how to run [Hermes Agent](https://github.com/NousResearch/hermes-agent)
as a supervised worker through `agentic-kit`'s external host-adapter contract. It covers the
prerequisites, setup, supported capabilities, limitations, and the security decisions to review
before enabling it.

Hermes support is delivered by the community adapter
[`adrianco/ak-adapter-hermes`](https://github.com/adrianco/ak-adapter-hermes). It is not a
Hermes implementation inside `ak`, and it is not a built-in host integration. The adapter is a
manifest plus subprocess hooks that `ak` validates, hash-pins, and supervises.

> [!WARNING]
> The current Hermes headless path enables Hermes' YOLO behavior so a non-interactive worker does
> not hang. Tool and shell approvals are therefore automatic for the worker. `AK_WORKER_CWD` tells
> the hook which repository to work on, but it is advisory and is not a sandbox boundary. Read the
> [upstream adapter's security disclosure](https://github.com/adrianco/ak-adapter-hermes#read-this-before-you-consent)
> before trusting it.

## What this integration is for

The adapter lets `ak run` route selected activities to a local Hermes process while preserving
`ak`'s worker supervision, timeout, result, escalation, and usage-reporting boundaries.

The current adapter provides:

| Capability | What it means in practice |
| --- | --- |
| Activity routing | Run a selected `ak run` activity through Hermes as a supervised subprocess. |
| Usage reporting | Return Hermes' model, token, and API-call accounting in the worker result. |
| Conformance testing | Exercise the real adapter hooks against the real Hermes executable. |
| Explicit routing | Choose Hermes for a run-local activity route; Hermes is not seeded into defaults. |

The adapter's current upstream conformance report shows admission and activity routing passing,
with primary-eligibility also passing against the tested setup. Session-driving is skipped because
the adapter does not provide a native Ruflo backend, and statusline support remains gated by `ak`.
See the [adapter README](https://github.com/adrianco/ak-adapter-hermes#status) for the current
upstream report and verified Hermes versions.

## Prerequisites

Before registering the adapter, have all of the following ready:

1. A release of `agentic-kit` that includes the experimental external host-adapter contract.
2. Hermes installed and configured independently, including its provider, model, and
   authentication settings.
3. The Hermes executable available as the bare command `hermes` on `PATH`.
4. A local checkout or reviewed copy of Adrian's adapter repository, including:
   `ak-adapter.json`, `detect-hook.mjs`, and `run-hook.mjs`.
5. A working `kit.json` that you can update at user or project scope.

Verify the CLI before configuring `ak`:

```bash
hermes --version
command -v hermes
```

Hermes installed through a virtual environment or `uv` may not create a user-level `PATH` entry.
The adapter's detection contract currently requires the bare `hermes` name, so expose it through a
user-owned bin directory when necessary:

```bash
ln -s /path/to/.venv/bin/hermes ~/.local/bin/hermes
```

Do not assume that installing or upgrading `agentic-kit` installs or upgrades Hermes. Hermes and
the adapter remain separately managed tools.

## Install and register the adapter

Obtain the adapter from its [source repository](https://github.com/adrianco/ak-adapter-hermes)
and review the manifest and both hooks before trusting them. A local checkout keeps the manifest
and its file-backed hooks together:

```bash
git clone https://github.com/adrianco/ak-adapter-hermes.git /path/to/ak-adapter-hermes
```

If the checkout is used operationally, record the reviewed Git commit and avoid silently moving
the directory to an unreviewed revision. The adapter's content hash will also become stale when a
declared manifest or hook file changes.

Add the adapter declaration to the `kit.json` that `ak` uses. The `hostAdapters` entry is
top-level:

```json
{
  "hostAdapters": [
    {
      "name": "hermes",
      "source": "/path/to/ak-adapter-hermes/ak-adapter.json",
      "contract": 1
    }
  ]
}
```

Then explicitly enable the external host under the existing `integrations.hosts` map. Preserve
your other host entries when merging this setting:

```json
{
  "integrations": {
    "hosts": {
      "hermes": true
    }
  }
}
```

`contract: 1` is experimental. The adapter entry is inert until the feature flag is present and
the user has explicitly consented to the resolved content.

## Trust and self-test

Enable the adapter surface in the shell where `ak` will run:

```bash
export AK_EXPERIMENTAL_HOST_ADAPTERS=1
```

Inspect the configured entry, then trust it interactively:

```bash
ak host adapters list
ak host adapters trust hermes
```

The trust disclosure includes the validated manifest, every hook command, and the SHA-256 digest
of each declared hook file. Consent is attached to that exact content. Editing, replacing, or
removing a declared file invalidates consent and requires another trust decision.

For an unattended remote adapter source, `--yes` is accepted only with an independently supplied
expected hash:

```bash
ak host adapters trust hermes --yes --expect-hash <sha256>
```

Use the local interactive flow for the current Git-checkout setup unless you have a separate
process for publishing and verifying the expected hash.

Run the conformance check before routing project work:

```bash
ak host adapters conformance hermes --dev
```

`--dev` runs the real hooks and real Hermes subprocess but persists no conformance evidence or
grants. It uses a throwaway working directory for the self-test. This is safer than testing in a
real project directory, but it is still an execution of the trusted local adapter and Hermes
binary. For the normal recorded check, omit `--dev`:

```bash
ak host adapters conformance hermes
ak host adapters status hermes
```

Expected results for the current adapter are a passing admission tier and activity-routing tier;
session-driving is skipped or gated, and statusline is gated. A passing conformance result does
not turn Hermes into a built-in host or grant it capabilities the adapter does not declare.

## Route work to Hermes

External hosts are explicit. Preview the materialized plan first, then run the activity or
activities you want Hermes to handle:

```bash
ak run packaging "prepare this repository for release" \
  --route 'packager:hermes' \
  --dry-run
```

If the plan is correct, remove `--dry-run`:

```bash
ak run packaging "prepare this repository for release" \
  --route 'packager:hermes'
```

The route format is `activity:host[:model]`. Use an activity name from the selected `ak run`
template, and add another `--route` flag when more than one activity should use Hermes. Hermes'
provider and model configuration remains Hermes-owned; the adapter reports what Hermes returns in
the worker payload.

The adapter can report an authentication failure distinctly from an ordinary worker failure. If
the run reports `auth_required`, complete Hermes' own login or API configuration and retry.

## What `ak sync` does and does not do

`ak sync` does not install, update, or repin Hermes. It also does not update the adapter checkout.
Those remain the responsibility of the Hermes and adapter maintainers, respectively.

When an external host is explicitly enabled and its adapter declares lifecycle hooks, `ak setup`,
`ak sync`, and uninstall can run those declared hooks. The current Hermes adapter deliberately
ships only detection and execution hooks; it does not declare `apply` or `undo` hooks. Therefore it
does not automatically configure Hermes MCP, install Hermes, or generate Hermes guidance files.

After updating the adapter manifest or a declared hook file:

```bash
export AK_EXPERIMENTAL_HOST_ADAPTERS=1
ak host adapters trust hermes
ak host adapters conformance hermes
```

Re-review the trust disclosure before accepting the new content.

## Limitations and security boundaries

- **Experimental contract.** External adapters require `AK_EXPERIMENTAL_HOST_ADAPTERS=1`, and
  `contract: 1` may change before it is frozen.
- **No default routing.** Hermes is not automatically added to the activity policy. Route it
  explicitly with `--route`.
- **No primary-host selection.** Even a conformance result that makes an adapter primary-eligible
  does not make `ak host pick` select that external host as primary today.
- **No native Ruflo session backend.** This adapter drives Hermes as an `ak run` worker; it does
  not make Hermes a native Ruflo session-driving host.
- **No statusline ownership.** External statusline capability is gated and has no active `ak`
  runtime reader.
- **No AQE provider identity.** The adapter cannot self-declare an AQE provider. Its reported
  provider is treated as inferred evidence by `ak`.
- **Auto-approved tool and shell actions.** Hermes' `-z` headless mode sets
  `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1`; the adapter does not receive a permission event
  it can intercept. Use a disposable worktree, container, or other operating-system boundary when
  the repository or credentials require stronger isolation.
- **Advisory working directory.** `AK_WORKER_CWD` identifies the target repository to the hook;
  it does not prevent an auto-approving Hermes process from accessing elsewhere.
- **Separate provider configuration.** Local models, remote providers, billing, and credentials
  are configured through Hermes. The adapter does not convert Hermes into an `ak` or AQE provider.

If these boundaries are not acceptable for a task, use a host with an interactive permission
boundary or do not route that task to Hermes.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `hermes` is not detected | Confirm `command -v hermes` succeeds in the same environment that runs `ak`; check the user-level symlink if Hermes came from `uv` or a venv. |
| Adapter is present but inactive | Export `AK_EXPERIMENTAL_HOST_ADAPTERS=1` and run `ak host adapters list`. |
| Trust is stale | Re-run `ak host adapters trust hermes`; inspect any changed manifest or hook file before consenting. |
| Conformance cannot authenticate | Configure Hermes' own login, API key, provider, or model, then rerun the conformance command. |
| A run never uses Hermes | Verify the adapter is trusted, `integrations.hosts.hermes` is enabled, the feature flag is set, and the activity has an explicit `activity:hermes` route. |
| `ak sync` did not update Hermes | Expected: `ak sync` does not manage the Hermes installation or adapter checkout. |

## Related documentation

- [Adrian's Hermes adapter repository](https://github.com/adrianco/ak-adapter-hermes)
- [External host adapters](PROVIDERS.md#external-host-adapters-experimental)
- [Host support matrix](HOST-SUPPORT.md)
- [Authoring a host adapter](AUTHORING-HOST-ADAPTERS.md)
- [ADR-0029: host adapter extension point](adr/0029-host-adapter-extension-point.md)
- [ADR-0031: capability graduation and upstream requests](adr/0031-capability-graduation-and-upstream-requests.md)
