# Upstream native trace plan

## Scope

Add a passive Node resolution hook for the nightly macOS learning probe. The hook records each resolved `@huggingface/transformers`, `@xenova/transformers`, and `onnxruntime-node` package root once per process, including its on-disk version when readable. It records no command arguments, environment values, or prompt content. The nightly workflow edit and native CI run belong to the integration owner.

## Steps

1. Add focused child-process tests with synthetic packages for ESM and CommonJS resolution, nested copies, missing/malformed versions, and an unusable log path.
2. Implement `scripts/trace-ort.mjs` from vidaunited's hook in [ruflo issue 2885](https://github.com/ruvnet/ruflo/issues/2885#issuecomment-5867331087). Require `TRACE_ORT_LOG` to be an absolute, explicit target. Emit a hook-start receipt and one JSONL record per package root per process. Observation failures must not change the observed command's exit result.
3. Run the focused guarded test and static checks, then provide exact nightly workflow hunks to the integration owner. Retain the trace, source/version, and exit receipt on failure.

## Acceptance and limits

The synthetic tests must prove observed resolution behavior without downloads or native ORT. A trace from the hosted macOS learning step remains pending. An empty trace is not proof that no relevant package loaded; a start receipt distinguishes an active hook from a missing artifact, but resolution hooks do not prove native addon teardown or capture packages loaded before registration.
