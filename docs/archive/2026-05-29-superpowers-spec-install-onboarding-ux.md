# Install & Onboarding UX — Design Spec

**Date:** 2026-05-29
**Branch:** `feat/install-onboarding-ux`
**Status:** Approved (brainstorming complete)

## Problem

A consumer who has *not* already run `npm i -g ruflo` (and optionally `agentic-qe`)
gets a confusing experience: `install.sh` lays down the kit, but the helpers it
installs (`ruflo-patch-native`, `ruflo-enable-learning`, etc.) all abort with
`ruflo not on PATH` because the prerequisite npm packages were never installed.
Nothing in the README states that the npm packages are a prerequisite, and
nothing in `install.sh` detects or offers to install them.

Separately, two surfaces — `install.sh` and the shell/bin helper functions —
overlap in people's minds. Consumers don't know **when to run the script vs. a
function**, which is the core of the onboarding UX.

## Goals

1. Document prerequisites in the README (a clear required-vs-optional section).
2. Make `install.sh` detect missing prerequisites and offer to install them,
   with a friendly **interactive default** that the "in a hurry" user can blast
   through, and flags for power users / CI.
3. Give consumers a **"full boat"** path (ruflo + agentic-qe + activated
   learning/security/statusline/QE) and a **"just ruflo"** path.
4. Make `uninstall.sh` symmetric — able to remove the global npm packages, but
   only behind explicit opt-in flags (never by default).
5. Guide the user, after machine install, into **per-project** onboarding with
   helpful "next command" breadcrumbs and a one-command wrapper.
6. Establish and document a crisp **mental model**: when to use `install.sh`
   vs. the functions.

## Non-goals

- No sudo auto-escalation. On `EACCES` during `npm i -g`, print the exact
  `sudo` command for the user to run; never escalate silently.
- `install.sh` will **not** run `ruflo-setup-project` — that is project-scoped
  and there is no target repo during a machine-level install.
- No new "security" or "learning" npm installs. Security
  (`@claude-flow/security` + `@claude-flow/aidefence`) and learning
  (ruvector/SONA) ship **inside** ruflo and are *activated/verified* by the
  heal step — they are not separate packages.
- No refactor/split of `shell/ruflo-functions.sh` (already ~562 lines). Add the
  small `ruflo-onboard` function + breadcrumb lines only; leave the rest.

## Background: what actually installs vs. activates

| Capability | How it arrives | Kit's role |
|---|---|---|
| `ruflo` | `npm i -g ruflo` (**required**) | install (offer) + heal |
| `agentic-qe` (`aqe`) | `npm i -g agentic-qe` (**optional**) | install (opt-in) + heal |
| security (`@claude-flow/security`, `aidefence`) | ships **inside** ruflo | activate/verify only |
| learning (ruvector/SONA/HNSW) | ships **inside** ruflo | activate/verify only |

So the **"full boat"** = `ruflo` + `agentic-qe` packages, then the kit lights up
learning + security + statusline + QE. **"just ruflo"** = the `ruflo` package,
then learning + security + statusline.

---

## Design

### Section 1 — Prerequisites model

**Hard prerequisites** (install.sh checks):
- Node.js 20–26, npm, git — abort with guidance only if **node or npm** is absent.
- Soft-checked (warn, do not abort): `sqlite3`, `claude` (Claude Code).
- Node version outside 20–26: warn (kit still proceeds; the patch keys off ABI).

**Managed prerequisites** (install.sh can install):
- `ruflo` → `npm i -g ruflo` — required.
- `agentic-qe` → `npm i -g agentic-qe` — optional.

### Section 2 — `install.sh` redesign

**Default (no flags) = interactive guided onboard.** The fast path for someone
in a hurry, but every install/heal step is a confirmable prompt so they can
back off.

**Profile flags** (mutually exclusive shortcuts):

| Flag | Meaning |
|---|---|
| `--full` | ruflo + agentic-qe + global heal ("full boat") |
| `--ruflo-only` | ruflo + global heal, no agentic-qe |
| `--minimal` | lay down kit files only; assume prereqs; no npm install, no heal (today's behavior) |

**Granular overrides** (compose with / override the profile):
`--with-aqe` / `--no-aqe`, `--with-ruflo` / `--no-ruflo`, `--heal` / `--no-heal`.

**Behavior flags:** `--yes` / `-y` (non-interactive, accept all defaults — also
auto-enabled when stdout is not a TTY so CI never hangs). Existing flags kept:
`--shell`, `--no-shell-rc`, `--dry-run`, `--help`.

**Flag-resolution rules:**
- A profile sets baseline intent; granular flags override individual decisions.
- Conflicting granular flags (e.g. `--with-aqe --no-aqe`) → last one wins
  (consistent with the existing arg loop) and a warning is printed.
- `--minimal` + `--heal` → lay down + heal, still no npm installs.
- agentic-qe is installed only when chosen via `--full`, `--with-aqe`, or an
  interactive "yes" (interactive default for aqe is **No** — it's the heavier
  opt-in).

**Order of operations:**
1. **Preflight** — detect Node version (warn if outside 20–26), npm, git;
   soft-check sqlite3 / claude. Abort only if node/npm absent.
2. **Resolve plan** — from profile/granular flags, or interactive prompts:
   - ruflo missing? → "Install ruflo globally (`npm i -g ruflo`)? [Y/n]"
   - (interactive or `--full`) → "Install agentic-qe too? [y/N]"
   - "Run the heal now (native SQLite + activate learning)? [Y/n]"
3. **npm installs** — `npm i -g …`. On `EACCES`, print the exact `sudo` command
   instead of escalating. If ruflo is required but declined/failed, lay down the
   kit anyway and warn clearly that helpers will not work until ruflo is on PATH.
4. **Lay down kit files** — bin/, template, CLAUDE.md block, shell rc line
   (today's steps 1–4, unchanged).
5. **Global heal** (if enabled) — **source `shell/ruflo-functions.sh`
   in-process** and run `ruflo-patch-native`, `ruflo-enable-learning`, and the
   agentic-qe native patch (if aqe present). Single source of truth — install.sh
   reimplements nothing. Deliberately **not** `ruflo-setup-project`.
6. **Summary + context-aware next steps** (see Section 5c).

**Helpers:** a small `ask_yes_no "<prompt>" <default>` function that returns the
default immediately when `--yes` is set or no TTY is attached; respects
`--dry-run` (prints intended actions, makes no changes).

### Section 3 — `uninstall.sh` redesign

Default behavior stays **kit-only** (today's steps 1–5) — never touches npm
packages. Opt-in flags for machine-wide removal, each gated by a confirmation
prompt + a "this is machine-wide" warning:

| Flag | Meaning |
|---|---|
| `--remove-ruflo` | `npm uninstall -g ruflo` (confirm + warn) |
| `--remove-aqe` | `npm uninstall -g agentic-qe` (confirm + warn) |
| `--purge` | both of the above |
| `--yes` | skip confirmations (scripted use) |

Existing `--dry-run`, `--this-project`, `--help` unchanged.

**Order:** remove kit footprint (steps 1–4) → optional `--this-project`
statusline revert (step 5) → **new:** optional npm-package removal, last, behind
confirmation → summary. Reuses the same `ask_yes_no` helper semantics as
install.

### Section 4 — README changes

- **New "✅ Prerequisites" section** *before* Quick start: required-vs-optional
  table with the npm commands, plus a note that `install.sh` can install them
  for you.
- **Updated Quick start**: show the in-a-hurry path (`./install.sh --full --yes`)
  and the interactive default; explain the profile flags.
- **Updated "The commands" / Uninstall sections** with the new flags
  (`ruflo-onboard`, install profiles, uninstall removal flags).
- **New "Which command do I run?" decision guide** (Section 6 content) — the
  lifecycle table + rule-of-thumb.
- A short **order-of-operations** list so users see exactly what runs when.

### Section 5 — Per-project onboarding guidance

**(a) Breadcrumb pattern** — every helper ends by printing the *next* logical
command:
- `ruflo-resync` → "Next: `cd <your-repo> && ruflo-onboard`"
- `ruflo-setup-project` → "Next: `ruflo-learning-verify` to prove learning persists"
- `ruflo-learning-verify` → "Done. After any `npm i -g ruflo@latest`, run `ruflo-resync`."
- `ruflo-onboard` → final summary of what's active + how to verify.

**(b) New `ruflo-onboard` wrapper** (shell function in `ruflo-functions.sh`) —
run from inside a repo; does the per-project sequence with a header/footer
summary:
- `ruflo-onboard` → `ruflo-setup-project` → `ruflo-learning-verify`
- `ruflo-onboard --with-security` → adds the security pass to setup-project
- `ruflo-onboard --aqe` → also runs `ruflo-setup-aqe`; if agentic-qe is not
  installed, warn and point to `install.sh --with-aqe`.
- Guard: if `ruflo` is not on PATH, print the same "run install.sh first"
  guidance the other helpers use.

**(c) Context-aware install banner** — `install.sh`'s closing next-steps detects
context: if it was run from inside a real project (cwd has `.git` and is not the
kit repo dir), print that exact `cd <path> && ruflo-onboard`; otherwise the
generic `cd <your-repo> && ruflo-onboard`.

### Section 6 — Mental model: `install.sh` vs. the functions

**One sentence:** `install.sh` is the front door you walk through once; the
functions are how you live in the house.

**The boundary:**

| | `install.sh` | The functions/helpers |
|---|---|---|
| Nature | A script run *from the kit repo* | Commands on `PATH`/shell, available everywhere after install |
| Frequency | Once per machine (+ rarely, to re-lay the kit) | Ongoing, day-to-day |
| Scope | Machine-level bootstrap | Machine-recurring **and** per-project |
| Run it when | You don't have the kit set up yet | You already do |

**Why install.sh also calls functions (no drift):** on first run the functions
aren't sourced yet, so install.sh sources `ruflo-functions.sh` in-process and
calls the same `ruflo-patch-native` / `ruflo-enable-learning`. One source of
truth; after the first run you never need install.sh for healing again.

**The lifecycle:**

| Situation | Run this | Why not the other |
|---|---|---|
| Brand-new machine | `install.sh` | Nothing's on PATH yet |
| Re-cloned kit / new shell / wiped `~/.local/bin` | `install.sh` | Re-lays kit files (idempotent) |
| After `npm i -g ruflo@latest` (or aqe) | `ruflo-resync` | Upgrade only wiped native binaries |
| Starting in a new repo | `ruflo-onboard` | Per-project; install.sh won't touch the repo |
| Routine checks | functions (`ruflo-parity-test`, `ruflo-learning-verify`) | No need to re-bootstrap |

**Rule of thumb (README verbatim):**
- "I'm setting up" → `install.sh` (once).
- "I upgraded ruflo/aqe" → `ruflo-resync`.
- "I'm starting work in a repo" → `ruflo-onboard`.

---

## Files touched

- `install.sh` — flags, preflight, interactive plan, npm installs, in-process
  heal, context-aware banner, `ask_yes_no` helper.
- `uninstall.sh` — `--remove-ruflo` / `--remove-aqe` / `--purge` / `--yes`,
  confirmation prompts, `ask_yes_no` helper.
- `shell/ruflo-functions.sh` — new `ruflo-onboard` function; breadcrumb lines
  appended to `ruflo-resync`, `ruflo-setup-project`, `ruflo-learning-verify`.
  (`ruflo-learning-verify` is in `bin/` — its breadcrumb goes there.)
- `bin/ruflo-learning-verify` — breadcrumb at end of successful run.
- `README.md` — Prerequisites section, Quick start, command/uninstall flag docs,
  "Which command do I run?" guide.

## Testing / acceptance

- `./install.sh --dry-run` and `./install.sh --full --dry-run` print the full
  intended plan without mutating anything.
- `./install.sh --minimal` reproduces today's lay-down-only behavior.
- On a machine without ruflo: interactive run offers to install it; `--full --yes`
  installs ruflo + agentic-qe + heals with no prompts; declining leaves a clear
  warning and a working kit footprint.
- No-TTY invocation (piped) never blocks on a prompt.
- `./uninstall.sh` (no flags) removes only the kit footprint; `--purge --dry-run`
  shows the npm-uninstall commands it *would* run.
- `ruflo-onboard` from inside a repo runs setup-project → learning-verify and
  prints a coherent summary; `--aqe` without agentic-qe installed warns and
  points to `install.sh --with-aqe`.
- README "Which command do I run?" guide matches the implemented lifecycle.
