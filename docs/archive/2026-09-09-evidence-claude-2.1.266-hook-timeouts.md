# Claude 2.1.266 hook timeout conformance

Verified September 9, 2026 against the installed macOS native executable.
`claude --version` reported `2.1.266 (Claude Code)`; the resolved executable
was the `2.1.266` file in the local Claude versions directory.

SHA-256:
`553d1b9e9e7068b275c0a783c7e139ff6503096f286e674c8c919379fb0eca62`

The native artifact's command-hook launcher converts configured timeout seconds
to milliseconds. Its generic command default is 600,000 milliseconds. Its
SessionEnd budget function reads settings-level hooks, converts their seconds
to milliseconds, applies a 1,500-millisecond minimum and a 60,000-millisecond
cap, and honors the explicit environment override in milliseconds.

The [official reference](https://code.claude.com/docs/en/hooks#common-fields)
corroborates the timeout units and defaults. Its
[SessionEnd section](https://code.claude.com/docs/en/hooks#sessionend) confirms
that plugin timeout declarations cannot raise the settings-level budget.

The opt-in test `tests/live/claude-hook-timeout-contract.test.mjs` checks the
entire executable digest before evaluating only its bounded extracted budget
function with mocked settings. Observed outputs: no configured timeout gives
1,500ms; 5 seconds gives 5,000ms; 5,000 seconds caps at 60,000ms; an explicit
7,000ms environment override gives 7,000ms. The test also verifies the native
command conversion and default. It passed on the executable above.

This is source-artifact conformance evidence, not a paid model session or
end-to-end hook-execution claim. Regression tests separately prove that AQE
migration receipts retain the actual `2.1.266` observed version and exact
`claude-hooks-2.1.266` profile. Other unverified versions remain syntax-only.
