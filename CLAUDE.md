<!-- Full ruflo reference: machine-wide ~/.claude/CLAUDE.md (managed by agentic-kit) -->

# agentic-kit

<!-- BEGIN agentic-kit-project-guidance -->
@AGENTS.md
<!-- END agentic-kit-project-guidance -->

## Documentation layout

Rules for this repository only. They are not shipped and are not written into user projects.

- Superpowers writes plans to `docs/plans/YYYY-MM-DD-<feature>.md` and specs to
  `docs/plans/YYYY-MM-DD-<topic>-design.md`. Never create `docs/superpowers/`.
- Finished plans and specs move to `docs/archive/` in the pull request that completes the work,
  using `node scripts/docs-relocate.mjs`, with one index row per file in `docs/archive/README.md`.
- Dated audits and evidence go straight to `docs/archive/`; dormant proposals to `docs/proposals/`.
  Don't add another folder under `docs/`.
- Markdown file names are lower case. The only exceptions are `README.md`, `CLAUDE.md`, `AGENTS.md`,
  and `SKILL.md`.
- [docs/README.md](docs/README.md) describes folder purposes. `tests/kit/docs-layout.test.mjs`
  enforces these rules.

<!-- BEGIN agentic-kit-aqe-init-guard -->
## Agentic QE v3
<!-- Compatibility guard only; Agentic-QE owns its generated host guidance. -->
<!-- END agentic-kit-aqe-init-guard -->
