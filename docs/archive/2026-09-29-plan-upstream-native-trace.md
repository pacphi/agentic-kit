# Upstream native trace plan

## Status

**Implemented; final integration pending** — Captured 2026-09-29. The hook and nightly workflow passed independent review and all eight local gates. Hosted macOS run 36567908852 captured package resolutions and the learning failure. The Windows preload fixture was corrected to use a file URL and independently reviewed. Final documentation/PR CI and the exact upstream comment approval remain separate gates.

## Scope

Add a passive Node resolution hook for the nightly macOS learning probe. The hook records each resolved `@huggingface/transformers`, `@xenova/transformers`, and `onnxruntime-node` package root once per process, including its on-disk version when readable. It records no command arguments, environment values, or prompt content. The nightly workflow edit and native CI run belong to the integration owner.

## Steps

1. Add focused child-process tests with synthetic packages for ESM and CommonJS resolution, nested copies, missing/malformed versions, and an unusable log path.
2. Implement `scripts/trace-ort.mjs` from vidaunited's hook in [ruflo issue 2885](https://github.com/ruvnet/ruflo/issues/2885#issuecomment-5867331087). Require `TRACE_ORT_LOG` to be an absolute, explicit target. Emit a hook-start receipt and one JSONL record per package root per process. Observation failures must not change the observed command's exit result.
3. Run the focused guarded test and static checks, then provide exact nightly workflow hunks to the integration owner. Retain the trace, source/version, and exit receipt on failure.

## Acceptance and limits

The synthetic tests must prove observed resolution behavior without downloads or native ORT. The hosted macOS learning trace is captured in the accompanying dated evidence record. An empty trace is not proof that no relevant package loaded; a start receipt proves that preload reached the registration attempt, not that registration succeeded. Resolution hooks do not prove native addon teardown or capture packages loaded before registration. The receipt records the outer kit command exit, not necessarily Ruflo's raw exit.
