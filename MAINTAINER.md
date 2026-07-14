# Maintainer's guide — `@pacphi/agentic-kit`

Everything a repository owner or maintainer needs to develop, test, package, and
release this kit. User-facing docs live in [README.md](README.md); this file is the
*inside* view.

> **What this package is:** a zero-runtime-dependency, cross-platform CLI (`ak` /
> `agentic-kit`) that installs, heals, and *proves* a ruflo + agentic-qe stack for
> Claude Code. It develops with **pnpm** but heals **npm-managed** global trees,
> because that's how ruflo/agentic-qe land on target machines.

---

## 1. Architecture at a glance

| Property | Value | Why it matters |
|----------|-------|----------------|
| Module system | **ESM only** (`.mjs`); `.cjs` reserved for the statusline template + its test | `"type": "module"` in `package.json` |
| Runtime deps | **Zero** | Uses `node:` builtins only — `node:sqlite`, `node:test`, `node:util` (`parseArgs`), `node:child_process`, `node:fs`. Keeps installs instant and supply-chain surface tiny |
| Node | **≥ 22** (`engines.node`) | `node:sqlite` + `node --test` need it. CI matrix covers 22 / 24 / 26 |
| Package manager (dev) | **pnpm** pinned via `packageManager: pnpm@11.13.0` | CI uses `pnpm/action-setup` which reads that field — don't drift it casually |
| Package manager (target) | **npm** | The kit heals `npm root -g` trees; `lib/heal.mjs` shells `npm install -g` |
| Version source of truth | `package.json` `version` **only** | `bin/agentic-kit.mjs --version` reads it at runtime; no version string is duplicated anywhere else in source |

### CLI shape (`bin/agentic-kit.mjs`)

- **Porcelain** (daily): `setup`, `status`, `sync`, `uninstall`. Bare `ak` → `status --hint`.
- **Plumbing** (power users): `ak x daemon-gc | mcp | reference | verify | improvement-eval`.
- Each command module exports `options` (a `parseArgs` config) and `run({ flags, positionals, pkgRoot })`.
- A best-effort drift nudge runs after non-`sync`, non-`--json` commands.

---

## 2. Repository layout

```
bin/agentic-kit.mjs      # single entrypoint — arg parse + command dispatch
src/
  commands/              # porcelain verbs
    setup.mjs  status.mjs  sync.mjs  uninstall.mjs
    x/                   # plumbing verbs
      daemon-gc.mjs  mcp.mjs  reference.mjs  verify.mjs
  lib/                   # the engine — each file is one concern
    heal.mjs             # the mutations sync/setup apply (idempotent, {ok,detail})
    natives.mjs          # better-sqlite3 / agentdb native detection
    sqlite.mjs           # node:sqlite helpers (scalar, checkpoint, withDb)
    versions.mjs         # installedVersion, driftReport, KIT_PKG
    blocks.mjs           # CLAUDE.md managed-block registry + syncBlocks
    mcp.mjs  settings.mjs  config.mjs  paths.mjs  statusline.mjs
    rvf.mjs  daemons.mjs  exec.mjs  output.mjs
  templates/statusline-footer.cjs   # injected into projects
  tools/improvement-eval.mjs        # causal self-improvement eval (raw passthrough)
claude/                  # skills + managed CLAUDE.md block templates (shipped)
tests/
  kit/*.test.mjs         # node:test unit suites
  statusline-segments.test.cjs      # statusline renderer suite
docs/
  TROUBLESHOOTING.md     # shipped in the npm tarball
  archive/               # investigative history behind each guard (not shipped)
.github/
  workflows/{ci,release,nightly}.yml
  dependabot.yml
```

**Published tarball** = the `files` whitelist in `package.json`:
`bin/agentic-kit.mjs`, `src/`, `claude/`, `docs/TROUBLESHOOTING.md`. Nothing else
ships — verify with `npm pack --dry-run` before a release if you touch `files`.

### Dogfooding artifacts are NOT source

Running `ruflo init` / `aqe init` against *this* repo writes `.agentic-qe/`,
`.claude/`, `.claude-flow/`, `.swarm/`, `.mcp.json`, `*.db`, `*.rvf`, `ruvector.db`.
All are `.gitignore`d. **Never commit them.** If you see them staged, something
generated them in-tree.

---

## 3. Local development

```bash
pnpm install                      # dev only; repo is zero-dependency so this is tiny
node bin/agentic-kit.mjs --help --all
node bin/agentic-kit.mjs status --json     # exercise a command directly

# Optional: link the CLI globally to dogfood `ak` end-to-end
npm link                          # then `ak status`, `ak setup`, …  (npm, not pnpm, to match target)
```

Because everything is `node:` builtins, there is no build step — source runs as-is.
Edit a file under `src/`, re-run the CLI, done.

**House conventions**
- Output goes through `src/lib/output.mjs` (`ok`/`warn`/`fail`/`info`/`heading`/`bold`/`dim`) — never raw `console.log` for status lines, so formatting stays consistent.
- Heal actions in `lib/heal.mjs` return `{ ok, detail }` and **must be idempotent** (they run on every `sync`).
- Keep files focused and under ~500 lines; one concern per `lib/` file.
- Validate at boundaries; degrade gracefully when ruflo/aqe aren't installed (`status` must still emit valid JSON — CI asserts this).

---

## 4. Testing

```bash
pnpm test        # the full gate — exactly what CI runs
```

That expands to:

```bash
node --test "tests/kit/*.test.mjs" && node tests/statusline-segments.test.cjs
```

- `tests/kit/*.test.mjs` — `node:test` unit suites (blocks, natives, settings-config, versions). **32 tests.**
- `tests/statusline-segments.test.cjs` — statusline footer renderer. **20 tests.**
- **52 total, 0 failures = release-ready.**

Run one suite while iterating: `node --test tests/kit/versions.test.mjs`.

CI additionally runs a **CLI smoke** against a sandboxed `HOME` (see `ci.yml`):
`--version`, `--help --all`, `status --json` (asserts valid JSON + `overall`),
`x reference sync` (asserts managed blocks present), `uninstall --dry-run`. If you
change CLI output shape, expect the smoke to catch it.

---

## 5. Branching methodology

- **Default branch:** `main`. It is always releasable — CI runs on every push to it.
- **Small docs / fix commits** land **directly on `main`** (fast-forward). This is
  how `db4607c`, `b33bab2`, `571b593` (docs) went in.
- **Features and non-trivial fixes** go through a **short-lived branch → PR →
  squash-merge** with the PR number appended to the subject, e.g.
  `fix(setup): … (#20)`, `feat(sync): … (#18)`. GitHub auto-deletes the branch on
  merge; prune stale local refs with `git remote prune origin`.
- **Commit convention:** Conventional Commits — `feat` / `fix` / `docs` / `chore` /
  `release`. Release commits are exactly `release: vX.Y.Z`.
- **No `Co-Authored-By` trailers** on commits (repo history is clean of them; the
  tool is a facilitator, not an author).

Typical feature flow:

```bash
git checkout -b feat/thing            # off main
# … work, with `pnpm test` green …
git push -u origin feat/thing
gh pr create --fill                   # or --web
gh pr merge --squash --delete-branch  # after CI passes
git checkout main && git pull --ff-only
```

---

## 6. Versioning (SemVer)

`package.json` `version` is the single source of truth. The npm dist-tag is chosen
**by the shape of the version string** in `release.yml`:

| Version | Example | dist-tag | Meaning |
|---------|---------|----------|---------|
| Prerelease (`-…`) | `4.0.0-alpha.4` | **`next`** | Alpha/beta channel. `ak sync` on a prerelease install tracks `next` *and* `latest` |
| Stable | `4.0.1` | **`latest`** | GA. Stable installs only ever follow `latest` |

Bump rules while in the `4.0.0` alpha line:
- Bug fix or docs → `-alpha.N` → `-alpha.(N+1)`.
- Feature-complete / stabilizing → graduate to `-beta.0`.
- Ship 4.0 → drop the prerelease suffix → `4.0.0` (goes to `latest`).

No feature or breaking change is implied by an alpha bump — those are still 4.0.0.

---

## 7. Release & publish

Publishing is driven **entirely by pushing a `v*` tag**. `release.yml` re-runs the
test gate, enforces `tag == package.json version`, and `pnpm publish`es with npm
provenance. There is no manual `npm publish` step — and you should never run one.

### Checklist

```bash
# 0. Be on an up-to-date main with the release contents already merged.
git checkout main && git pull --ff-only
pnpm test                                   # must be green — CI will re-check anyway

# 1. Bump the version (edit package.json — the ONLY place it lives).
#    e.g. 4.0.0-alpha.4 -> 4.0.0-alpha.5

# 2. Sanity-check the CLI reports the new version.
node bin/agentic-kit.mjs --version          # -> 4.0.0-alpha.5

# 3. Commit with the release convention and push main.
git commit -am "release: v4.0.0-alpha.5"
git push origin main

# 4. Tag (annotated) to match EXACTLY, and push the tag — this is the deploy trigger.
git tag -a v4.0.0-alpha.5 -m "v4.0.0-alpha.5"
git push origin v4.0.0-alpha.5

# 5. Watch the publish.
gh run list --workflow=release.yml --limit 1
gh run watch "$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')" --exit-status

# 6. Verify it landed on the right dist-tag.
npm dist-tag ls @pacphi/agentic-kit
npm view @pacphi/agentic-kit@4.0.0-alpha.5 version dist.tarball
```

**The tag↔version guard is unforgiving:** if the tag name and `package.json`
version don't match, `release.yml` fails before publishing. That's the safety net —
if a release run fails on the guard, you tagged the wrong string.

### Requirements for publishing to work
- `NPM_TOKEN` repo secret — an npm **Automation** token with publish rights
  (already configured). Rotate with `gh secret set NPM_TOKEN`.
- `release.yml` has `id-token: write` for provenance attestation — keep it.

### If a release goes wrong
- **Failed on the guard / tests:** the package was NOT published. Fix, then move the
  tag (`git tag -d vX && git push origin :vX`, correct, re-tag, re-push) or cut the
  next patch.
- **Published a bad version:** don't try to re-publish the same version (npm forbids
  it). Publish a superseding version. Use `npm deprecate @pacphi/agentic-kit@X "…"`
  to warn installers; `npm unpublish` is a last resort and time-limited by npm policy.
- **Wrong dist-tag:** `npm dist-tag add @pacphi/agentic-kit@X next` / `… latest` to
  correct it without republishing.

---

## 8. GitHub workflow automation

| Workflow | Trigger | What it does | Gate? |
|----------|---------|--------------|-------|
| **`ci.yml`** | push to `main`/`npm-kit`, any PR, `workflow_dispatch` | Matrix **3 OS × 3 Node** (ubuntu/macos/windows × 22/24/26): `pnpm test` + CLI smoke against a sandboxed `HOME` | PR merge signal |
| **`release.yml`** | push tag `v*` | Test gate → **tag↔version guard** → `pnpm publish --provenance` (prerelease→`next`, stable→`latest`) | **Publishes** |
| **`nightly.yml`** | cron `17 6 * * *` (06:17 UTC), `workflow_dispatch` | Installs the **real latest** ruflo + agentic-qe via `npm -g`, runs `ak sync --no-upgrade` + deep proofs; fails on upstream drift in `natives`/`security` | Upstream-drift alarm |
| **`dependabot.yml`** | weekly, Monday | Grouped bumps: `github-actions` (keeps action majors current) + `npm` (watchdog even though repo is zero-dep) | Opens PRs |

Notes:
- `release.yml` is **independent of `ci.yml`** — it runs its own test gate on the
  tagged commit. A green `main` CI is reassurance, not a precondition for release.
- A **nightly failure means "upstream changed"**, not "this repo broke" — it's how
  we catch ruflo/aqe drift the day it ships. Triage by reading the drift message.
- Dependabot PRs carry `dependencies` (+ `ci`) labels; merge like any PR after CI.

---

## 9. `gh` CLI cookbook (by use case)

**Releases / publishing**
```bash
gh run list --workflow=release.yml --limit 5          # recent publish runs
gh run watch <run-id> --exit-status                   # follow one to completion
gh run view <run-id> --log-failed                     # why a publish failed
```

**CI**
```bash
gh workflow run ci.yml                                # manual matrix run (workflow_dispatch)
gh run list --workflow=ci.yml --branch main --limit 5
gh run rerun <run-id> --failed                        # re-run only failed jobs
```

**Nightly upstream-drift probe**
```bash
gh workflow run nightly.yml                           # force a live-drift check now
gh run list --workflow=nightly.yml --limit 3
```

**Pull requests**
```bash
gh pr create --fill                                   # open PR from current branch
gh pr checks                                          # CI status for the PR
gh pr merge --squash --delete-branch                  # standard merge
gh pr list --label dependencies                       # pending Dependabot PRs
```

**Repo config / secrets**
```bash
gh secret list                                        # confirm NPM_TOKEN present
gh secret set NPM_TOKEN                               # rotate the publish token
gh repo view --web                                    # open on GitHub
```

**Optional — GitHub Releases**
The kit currently ships via npm on tag push and does **not** create GitHub Release
objects. To add human-readable release notes alongside a tag:
```bash
gh release create v4.0.0-alpha.5 --generate-notes     # after the tag is pushed
```

---

## 10. Quick reference

| I want to… | Do this |
|------------|---------|
| Run the exact CI gate | `pnpm test` |
| Try the CLI locally | `node bin/agentic-kit.mjs <cmd>` |
| Cut a release | Bump `package.json` → `release: vX` commit → push `main` → push `vX` tag |
| See why a publish failed | `gh run view <id> --log-failed` |
| Force an upstream-drift check | `gh workflow run nightly.yml` |
| Confirm what npm sees | `npm dist-tag ls @pacphi/agentic-kit` |
| Prune a merged branch locally | `git remote prune origin` |
| Verify the published tarball contents | `npm pack --dry-run` |
