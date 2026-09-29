# Codex 0.153.4 context allocation conformance

Observed September 9, 2026, using the installed `codex-cli 0.153.4` and its
refreshed native catalog. No model cache or provider catalog was modified.

| Model | Requested tokens | Native maximum | Recorded effective window |
|---|---:|---:|---:|
| GPT-6 Astra | 1,050,000 | 872,000 | 828,400 |
| GPT-5.6 Sol | 872,000 | 872,000 | 828,400 |
| GPT-5.5 | 872,000 | 272,000 | 258,400 |

Each bounded `codex exec` session ran in an empty temporary directory with
read-only sandboxing, low reasoning effort, and a synthetic request to reply
`AK_CAPACITY_OK` without tools. All three returned that marker successfully.
Native `task_started` records retained the effective window; Astra's subsequent
`token_count` observation independently reported the same window.

The allocation matches `min(request, native maximum) × 95%`. This establishes
the installed client's model-specific allocation behavior, including a smaller
model control. It does not establish actual processing of an 828K-token input,
provider entitlement for every catalog model, or equivalence with the API
capacity. User-configured compaction thresholds remain separate.

The [Astra API model](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [Sol API model](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
pages advertise 1,050,000 tokens. That capacity does not override this Codex
client's smaller native maximum. The native setting is documented in the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Re-run `AK_CODEX_CONTEXT_CONFORMANCE=1 node --test tests/live/codex-context-contract.test.mjs`
to validate this exact client profile. The test intentionally rejects other
versions; new versions need their own evidence before expanding the profile.

## Managed configuration verification

`ak x codex-context max` applied an 872,000-token request with a native-config
backup and a persisted kit ownership receipt. A second application was a no-op.
The opt-in contract suite then ran with `AK_CODEX_CONTEXT_USE_CONFIG=1`, omitting
the command-line window override. All three fresh sessions passed with the
effective windows above. Model inventory also reported Astra/Sol at 828,400
and GPT-5.5 at 258,400 from the saved user configuration and native catalog.

The 36 focused tests passed. The full test command passed 3,753 Node tests with
six skipped, followed by all CJS suites; coverage was 91.83% lines, 80.48%
branches, and 91.28% functions. Typecheck, ESLint, complexity lint, Markdown
lint, build, and whitespace checks passed. Existing ESLint warnings remain.
An initial coverage-reporting attempt encountered truncated coverage JSON;
the complete rerun used an isolated `NODE_V8_COVERAGE` directory and passed.

Application policy receipt:
`sha256:241a9eb98fe118b99565972d0dd8a8b19dfd647bf3a7da1e306206cd33956484`.
This authorizes the requested local configuration, not a package release.
