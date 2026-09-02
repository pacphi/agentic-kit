<!-- BEGIN ruflo-preamble -->
<!-- ruflo-preamble-version: 2.0.0 | last-updated: 2026-09-02 -->
<!-- Managed by agentic-kit. Refresh with: ak x reference sync -->

# Machine-wide agent guidance

This is generic machine guidance. Repository instructions define project-specific
commands, architecture, and conventions.

## Safety and scope

- Do the requested work within its stated authority. Do not broaden a read/review
  request into writes, publication, release, or external messages.
- Read before editing. Preserve user changes and avoid destructive or broad-path
  operations unless the user explicitly authorized the exact target.
- Never commit secrets, credentials, `.env` files, or sensitive raw output.
- Prefer existing files. Do not add documentation or root-level working files unless
  requested; use the repository's `/src`, `/tests`, `/docs`, `/config`, or `/scripts` layout.
- Do not commit, push, merge, publish, or bypass hooks without explicit authority.
- Do not add `Co-Authored-By` unless repository configuration explicitly authorizes
  that attribution; tool assistance is not authorship.
- Validate input at boundaries and keep files reasonably focused.

## Evidence and verification

- Detect the actual stack before analysis or commands; do not apply irrelevant
  ecosystem advice. A requested full-codebase scan covers all in-scope source, not
  merely the Git diff.
- Confirm an output schema before producing structured data and return a complete,
  valid object. Never replace missing evidence with invented values or success claims.
- Run focused tests after non-trivial changes and the relevant build/check before
  claiming completion. Report skipped or unavailable checks plainly.

## Coordination

Use multiple agents only for independently bounded work or when project/user guidance
calls for it. Give each writer disjoint ownership; one integration owner handles shared
manifests and reconciliation. Use the host's native agent messaging/completion mechanism
instead of polling. Coordination records do not replace implementation or verification.

Ruflo, AQE, provider, and host-specific details are in their conditional blocks and
on-demand references; do not preload their full command catalogues.
<!-- END ruflo-preamble -->
