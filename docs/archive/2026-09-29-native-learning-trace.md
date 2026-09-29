# Hosted macOS learning resolution trace

## Status and inputs

Captured 2026-09-29. This is an observation, not a native-readiness or causal verdict.

- [Workflow run](https://github.com/pacphi/agentic-kit/actions/runs/36567908852), [macOS job](https://github.com/pacphi/agentic-kit/actions/runs/36567908852/job/109404326296), [artifact](https://github.com/pacphi/agentic-kit/actions/runs/36567908852/artifacts/11031869828).
- Source `ed8f4cb96836e1911aae9a89bbb3f015f033e115`; hook SHA-256 `98d9cc2c54e570eb18e24af83a7c401779c6eec12d58fe740e8c1a7622276dae`.
- macOS arm64, Node 22.23.2; Ruflo 3.48.0 and Agentic QE 3.14.5 installed in a disposable CI prefix.
- The kit's `sync --no-upgrade` healing step ran before `node bin/agentic-kit.mjs status --refresh=live --only learning`. This is a post-heal observation, not a pristine npm-tree measurement.
- The hook follows [vidaunited's resolution-hook proposal](https://github.com/ruvnet/ruflo/issues/2885#issuecomment-5867331087), with metadata-only JSONL and explicit artifact paths.

## Observations

The artifact contains 22 records: 16 preload starts and six package-resolution records across three processes. The two distinct package roots, with the runner-specific prefix omitted, are:

```text
@huggingface/transformers@3.8.1
  npm-prefix/lib/node_modules/ruflo/node_modules/@claude-flow/cli/node_modules/@huggingface/transformers
onnxruntime-node@1.21.0
  npm-prefix/lib/node_modules/ruflo/node_modules/@claude-flow/cli/node_modules/@huggingface/transformers/node_modules/onnxruntime-node
```

The learning step invokes `ruflo neural train -p coordination -e 50`. Its output contains the default `fp32` dtype warning and `libc++abi` / `mutex lock failed: Invalid argument`. The outer kit command exited 1. The trace and receipt were retained despite that failure; the existing `continue-on-error` boundary explains the green macOS job.

The separate clean-setup job failed at an AQE embedding process probe, and external link checking failed. Those results are not evidence that the trace worked or that setup is healthy. The trace was enabled only in the macOS learning step.

## What this establishes

The old package roots were resolved during the failing traced step. It remains unproved which installation/healing/dependency action introduced them and whether they caused the mutex failure. Resolution observations are not an exhaustive native-module census. A start-only artifact would establish only that preload reached a registration attempt. `learningExitCode` records the outer kit command, not a separately captured native Ruflo exit.

Synthetic ESM/CommonJS, nested-copy, child-inheritance, unknown-version and failed-log-target tests passed. A later fixture-only correction uses file URLs for Windows preload paths and adds a real space-path test; it does not change the hook bytes captured here. The exact sanitized upstream comment was awaiting maintainer approval at this capture. No upstream message or user-global installation is implied by this record.
