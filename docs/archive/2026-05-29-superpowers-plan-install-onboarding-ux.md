# Install & Onboarding UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `install.sh` a friendly machine bootstrap that detects/offers the npm prerequisites (ruflo required, agentic-qe optional), with profiles + interactive default; make `uninstall.sh` symmetric; add a per-project `ruflo-onboard` wrapper + breadcrumbs; and document prerequisites and a "which command do I run?" mental model in the README.

**Architecture:** Two surfaces. `install.sh` = one-time machine bootstrap (preflight → resolve plan → npm installs → lay down kit → optional in-process heal that *sources the shipped helpers, no reimplementation*). The shell/bin functions = ongoing surface (`ruflo-resync` after upgrades, `ruflo-onboard` per repo). A shared `ask_yes_no` helper drives interactive prompts and honors `--yes` / no-TTY.

**Tech Stack:** POSIX-ish bash, `npm i -g`, existing `bin/` helpers (`ruflo-patch-native`, `ruflo-enable-learning`, `ruflo-learning-verify`), `shell/ruflo-functions.sh`. Verification: `bash -n`, `shellcheck` (if installed), `--dry-run`/`--help` greps.

**Spec:** `2026-05-29-superpowers-spec-install-onboarding-ux.md`

**Conventions:**
- No `Co-Authored-By` trailer (project `.claude/settings.json` has no `attribution.commit`).
- Commit after each task. Never use `--no-verify`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `install.sh` | Machine bootstrap: preflight, plan resolution, npm installs, lay-down, in-process heal, context banner | Rewrite |
| `uninstall.sh` | Kit removal (default) + opt-in global npm removal behind confirmation | Rewrite |
| `shell/ruflo-functions.sh` | Add `ruflo-onboard`; breadcrumbs on `ruflo-resync`, `ruflo-setup-project` | Modify |
| `bin/ruflo-learning-verify` | Breadcrumb at end of a successful run | Modify |
| `README.md` | Prerequisites section, Quick start, command/uninstall flags, "Which command do I run?" guide | Modify |

---

## Task 1: Rewrite `install.sh`

**Files:**
- Modify: `install.sh` (full rewrite)

- [ ] **Step 1: Write the new `install.sh`**

Replace the entire file with:

```bash
#!/usr/bin/env bash
#
# install.sh — set up the ruflo machine reference on this machine.
#
# A ONE-TIME machine bootstrap. Optionally installs the npm prerequisites
# (ruflo, optionally agentic-qe), lays down the kit (CLI helpers, CLAUDE.md
# reference, shell functions), and optionally heals the global install (native
# SQLite + self-learning). After this, use the shell functions day-to-day:
# `ruflo-resync` after upgrades, `ruflo-onboard` inside each repo.
#
# Idempotent and re-runnable. Backs up any file it rewrites.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

usage() {
	cat <<'EOF'
install.sh — set up the ruflo machine reference on this machine.

Profiles (pick at most one):
  --full          install ruflo + agentic-qe + heal ("full boat")
  --ruflo-only    install ruflo + heal, no agentic-qe
  --minimal       lay down kit files only (assume prereqs; no install, no heal)
  (no profile)    interactive: detect and ask per step

Granular overrides (compose with / override a profile):
  --with-ruflo / --no-ruflo
  --with-aqe   / --no-aqe
  --heal       / --no-heal

Behavior:
  --yes, -y       non-interactive; accept defaults (also auto when no TTY)
  --shell zsh|bash   force which rc file gets the source line
  --no-shell-rc   skip editing rc (you source the file yourself)
  --dry-run       show what would happen, change nothing
  -h, --help

Examples:
  ./install.sh                 # friendly interactive onboard
  ./install.sh --full --yes    # full boat, no prompts (in a hurry)
  ./install.sh --ruflo-only    # just ruflo + heal
  ./install.sh --minimal       # only lay down the kit files
  ./install.sh --dry-run       # preview
EOF
}

SHELL_CHOICE="auto"
EDIT_RC=1
DRY=0
ASSUME_YES=0
PROFILE=""
WANT_RUFLO="auto"
WANT_AQE="auto"
DO_HEAL="auto"

while [ "$#" -gt 0 ]; do
	case "$1" in
		--full)        PROFILE="full" ;;
		--ruflo-only)  PROFILE="ruflo-only" ;;
		--minimal)     PROFILE="minimal" ;;
		--with-ruflo)  WANT_RUFLO="yes" ;;
		--no-ruflo)    WANT_RUFLO="no" ;;
		--with-aqe)    WANT_AQE="yes" ;;
		--no-aqe)      WANT_AQE="no" ;;
		--heal)        DO_HEAL="yes" ;;
		--no-heal)     DO_HEAL="no" ;;
		--yes|-y)      ASSUME_YES=1 ;;
		--shell)       shift; SHELL_CHOICE="${1:-}" ;;
		--no-shell-rc) EDIT_RC=0 ;;
		--dry-run)     DRY=1 ;;
		-h|--help)     usage; exit 0 ;;
		*) echo "Unknown flag: $1 (try --help)" >&2; exit 2 ;;
	esac
	shift
done

if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'; else C_OK=""; C_WARN=""; C_DIM=""; C_RESET=""; fi
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s⚠%s  %s\n' "$C_WARN" "$C_RESET" "$*"; }
run()  { if [ "$DRY" -eq 1 ]; then printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"; else eval "$*"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

# ask_yes_no PROMPT DEFAULT(Y|N) -> 0 yes / 1 no. Honors --yes and no-TTY.
ask_yes_no() {
	local prompt="$1" def="${2:-Y}" reply hint="[Y/n]"
	[ "$def" = "N" ] && hint="[y/N]"
	if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
		[ "$def" = "Y" ]; return
	fi
	printf '%s %s ' "$prompt" "$hint"
	read -r reply || reply=""
	reply="${reply:-$def}"
	case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

BIN_DIR="$HOME/.local/bin"
CFG_DIR="$HOME/.config/ruflo"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

echo "Installing ruflo machine reference from: $HERE"
echo ""

# --- Preflight: hard deps abort, soft deps warn --------------------------
echo "## Preflight"
have node || { warn "Node.js (20-26) is required — https://nodejs.org"; exit 2; }
have npm  || { warn "npm is required (ships with Node.js)"; exit 2; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if { [ "$NODE_MAJOR" -lt 20 ] || [ "$NODE_MAJOR" -gt 26 ]; } 2>/dev/null; then
	warn "Node $NODE_MAJOR is outside the tested 20-26 range — proceeding anyway"
else
	ok "Node $NODE_MAJOR, npm $(npm -v 2>/dev/null)"
fi
have git     || warn "git not found (needed to update this kit later)"
have sqlite3 || warn "sqlite3 not found — statusline + memory checks need it"
have claude  || warn "claude (Claude Code) not found — that's what this configures"
echo ""

# --- Resolve plan: profile fills only 'auto' slots; granular flags win ----
case "$PROFILE" in
	full)       [ "$WANT_RUFLO" = auto ] && WANT_RUFLO=yes; [ "$WANT_AQE" = auto ] && WANT_AQE=yes; [ "$DO_HEAL" = auto ] && DO_HEAL=yes ;;
	ruflo-only) [ "$WANT_RUFLO" = auto ] && WANT_RUFLO=yes; [ "$WANT_AQE" = auto ] && WANT_AQE=no;  [ "$DO_HEAL" = auto ] && DO_HEAL=yes ;;
	minimal)    [ "$WANT_RUFLO" = auto ] && WANT_RUFLO=no;  [ "$WANT_AQE" = auto ] && WANT_AQE=no;  [ "$DO_HEAL" = auto ] && DO_HEAL=no ;;
esac

if [ "$WANT_RUFLO" = auto ]; then
	if have ruflo; then WANT_RUFLO=no
	elif ask_yes_no "ruflo is not installed. Install it now (npm i -g ruflo)?" Y; then WANT_RUFLO=yes
	else WANT_RUFLO=no; fi
fi
if [ "$WANT_AQE" = auto ]; then
	if have aqe; then WANT_AQE=no
	elif ask_yes_no "Install agentic-qe too? (optional QE fleet)" N; then WANT_AQE=yes
	else WANT_AQE=no; fi
fi
if [ "$DO_HEAL" = auto ]; then
	if ask_yes_no "Run the heal now? (native SQLite + activate self-learning)" Y; then DO_HEAL=yes; else DO_HEAL=no; fi
fi

# --- npm prerequisites ----------------------------------------------------
npm_install_global() {
	local pkg="$1"
	if [ "$DRY" -eq 1 ]; then printf '%s[dry-run]%s npm install -g %s\n' "$C_DIM" "$C_RESET" "$pkg"; return 0; fi
	if npm install -g "$pkg" >/dev/null 2>&1; then ok "installed $pkg"; return 0; fi
	warn "could not install $pkg globally — try:  sudo npm install -g $pkg"
	return 1
}
if [ "$WANT_RUFLO" = yes ] || [ "$WANT_AQE" = yes ]; then
	echo "## npm prerequisites"
	[ "$WANT_RUFLO" = yes ] && npm_install_global ruflo
	[ "$WANT_AQE"   = yes ] && npm_install_global agentic-qe
	echo ""
fi
if [ "$DRY" -ne 1 ] && ! have ruflo; then
	warn "ruflo is not on PATH — the kit's helpers will not work until it is installed"
fi

# --- Lay down the kit -----------------------------------------------------
# CLI helpers — installed from bin/ (derived, so install/uninstall never drift).
echo "## CLI helpers -> $BIN_DIR"
run "mkdir -p '$BIN_DIR'"
for src in "$HERE"/bin/*; do
	[ -f "$src" ] || continue
	f="$(basename "$src")"
	run "install -m 0755 '$src' '$BIN_DIR/$f'"
	ok "$f"
done
case ":$PATH:" in
	*":$BIN_DIR:"*) ok "$BIN_DIR already on PATH" ;;
	*) warn "$BIN_DIR is NOT on your PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
echo ""

# CLAUDE.md reference template
echo "## CLAUDE.md reference template -> $CFG_DIR/claude-md-template.md"
run "mkdir -p '$CFG_DIR'"
run "cp '$HERE/claude/ruflo-reference.md' '$CFG_DIR/claude-md-template.md'"
ok "template installed"
echo ""

# Merge the reference block into ~/.claude/CLAUDE.md (sentinel-managed)
echo "## ruflo-reference block -> $CLAUDE_MD"
run "mkdir -p '$HOME/.claude'"
if [ "$DRY" -eq 1 ]; then
	printf '%s[dry-run]%s merge BEGIN/END ruflo-reference block into %s\n' "$C_DIM" "$C_RESET" "$CLAUDE_MD"
elif [ ! -f "$CLAUDE_MD" ]; then
	cp "$HERE/claude/ruflo-reference.md" "$CLAUDE_MD"
	ok "created $CLAUDE_MD from template"
elif grep -q '<!-- BEGIN ruflo-reference -->' "$CLAUDE_MD"; then
	cp "$CLAUDE_MD" "$CLAUDE_MD.bak.$(date +%Y%m%d-%H%M%S)"
	pre=$(mktemp); post=$(mktemp); new=$(mktemp)
	awk '/<!-- BEGIN ruflo-reference -->/{exit} {print}' "$CLAUDE_MD" > "$pre"
	awk 'f; /<!-- END ruflo-reference -->/{f=1}' "$CLAUDE_MD" > "$post"
	cat "$pre" "$HERE/claude/ruflo-reference.md" "$post" > "$new"
	mv "$new" "$CLAUDE_MD"; rm -f "$pre" "$post"
	ok "updated managed block (backup saved; content outside sentinels preserved)"
else
	cp "$CLAUDE_MD" "$CLAUDE_MD.bak.$(date +%Y%m%d-%H%M%S)"
	{ echo ""; cat "$HERE/claude/ruflo-reference.md"; } >> "$CLAUDE_MD"
	ok "appended ruflo-reference block (backup saved)"
fi
echo ""

# Shell rc source line
if [ "$EDIT_RC" -eq 1 ]; then
	echo "## shell functions"
	RC=""
	case "$SHELL_CHOICE" in
		zsh)  RC="$HOME/.zshrc" ;;
		bash) RC="$HOME/.bashrc" ;;
		auto)
			if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then RC="$HOME/.zshrc"; else RC="$HOME/.bashrc"; fi
			;;
		*) warn "unknown --shell '$SHELL_CHOICE'; skipping rc edit"; RC="" ;;
	esac
	if [ -n "$RC" ]; then
		SRC_LINE="source \"$HERE/shell/ruflo-functions.sh\""
		if [ -f "$RC" ] && grep -qF "$SRC_LINE" "$RC" 2>/dev/null; then
			ok "$RC already sources ruflo-functions.sh"
		else
			run "printf '\n# ruflo machine reference helpers\n%s\n' '$SRC_LINE' >> '$RC'"
			ok "added source line to $RC"
		fi
		echo "   (run 'exec \$SHELL' or open a new terminal to load the functions)"
	fi
else
	echo "## shell functions (skipped --no-shell-rc)"
	echo "   Add manually:  source \"$HERE/shell/ruflo-functions.sh\""
fi
echo ""

# --- Global heal (optional) — reuse shipped helpers, no reimplementation ---
if [ "$DO_HEAL" = yes ]; then
	echo "## Heal (native SQLite + self-learning)"
	if [ "$DRY" -eq 1 ]; then
		printf '%s[dry-run]%s run ruflo-patch-native, ruflo-enable-learning, agentic-qe native patch\n' "$C_DIM" "$C_RESET"
	elif have ruflo; then
		# shellcheck source=/dev/null
		[ -f "$HERE/shell/ruflo-functions.sh" ] && . "$HERE/shell/ruflo-functions.sh"
		"$BIN_DIR/ruflo-patch-native"    || warn "native patch reported issues — see docs/TROUBLESHOOTING.md"
		"$BIN_DIR/ruflo-enable-learning" || warn "self-learning activation reported issues"
		if command -v _ruflo_aqe_ensure_native >/dev/null 2>&1; then _ruflo_aqe_ensure_native; fi
	else
		warn "skipping heal — ruflo not on PATH"
	fi
	echo ""
fi

ok "Done."
echo ""
echo "Next steps:"
echo "  1. exec \$SHELL                 # load the helper functions"
if [ "$DO_HEAL" != yes ]; then
	echo "  2. ruflo-resync                # native SQLite + self-learning + statusline"
fi
TARGET=""
if [ "$(pwd -P)" != "$HERE" ] && [ -d ".git" ]; then TARGET="$(pwd -P)"; fi
if [ -n "$TARGET" ]; then
	echo "  3. ruflo-onboard               # you're in a repo ($TARGET) — set it up now"
else
	echo "  3. cd <your-repo> && ruflo-onboard   # per-project: setup + verify in one step"
fi
echo "  4. ruflo-parity-test           # end-to-end memory smoke test (isolated /tmp dir)"
```

- [ ] **Step 2: Syntax check**

Run: `bash -n install.sh`
Expected: no output, exit 0.

- [ ] **Step 3: Lint (if shellcheck installed)**

Run: `command -v shellcheck >/dev/null && shellcheck -S warning install.sh || echo "shellcheck not installed — skipping"`
Expected: no errors (warnings about sourced files / `eval` in `run` are acceptable). If shellcheck absent, the echo prints and that's fine.

- [ ] **Step 4: Verify help renders**

Run: `./install.sh --help`
Expected: usage text showing `--full`, `--ruflo-only`, `--minimal`, `--with-aqe`, `--yes`, and the Examples block.

- [ ] **Step 5: Verify dry-run plans**

Run: `./install.sh --minimal --dry-run`
Expected: Preflight lines, NO "## npm prerequisites" section, the lay-down `[dry-run]` lines, NO "## Heal" section.

Run: `./install.sh --full --yes --dry-run`
Expected: Preflight, "## npm prerequisites" with `[dry-run] npm install -g ruflo` and `[dry-run] npm install -g agentic-qe`, lay-down dry-run lines, and "## Heal" with the `[dry-run] run ruflo-patch-native …` line. No interactive prompt appears (because `--yes`).

- [ ] **Step 6: Commit**

```bash
git add install.sh
git commit -m "feat(install): profiles + interactive prereq onboarding (preflight, npm install, in-process heal, context banner)"
```

---

## Task 2: Rewrite `uninstall.sh`

**Files:**
- Modify: `uninstall.sh` (full rewrite)

- [ ] **Step 1: Write the new `uninstall.sh`**

Replace the entire file with:

```bash
#!/usr/bin/env bash
#
# uninstall.sh — remove what install.sh placed on this machine.
#
# By default removes ONLY the kit's own footprint:
#   - every helper this repo ships in bin/ from ~/.local/bin/ (derived from bin/)
#   - ~/.config/ruflo/claude-md-template.md
#   - the BEGIN/END ruflo-reference block from ~/.claude/CLAUDE.md (content
#     outside the sentinels is preserved)
#   - the source line from ~/.zshrc / ~/.bashrc
#
# Leaves your ruflo install, memory DBs, and project files untouched. Per-project
# data (.swarm/, .claude-flow/, .agentic-qe/) is intentionally NOT touched —
# remove that per-project with `ruflo cleanup --force`.
#
# Opt-in machine-wide removal (each prompts to confirm; never runs by default):
#   --remove-ruflo   npm uninstall -g ruflo
#   --remove-aqe     npm uninstall -g agentic-qe
#   --purge          both of the above
#
# With --this-project, ALSO reverts the kit's statusline patches in the current
# repo's .claude/helpers/statusline.cjs. Run it from the project root.
#
# Behavior:
#   --yes, -y        skip confirmations (also auto when no TTY)
#   --dry-run        preview without changing anything
#   -h, --help

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

usage() {
	cat <<'EOF'
uninstall.sh — remove what install.sh placed on this machine.

Default: removes only the kit footprint (bin helpers, template, CLAUDE.md block,
rc source line). Your ruflo install, memory DBs, and projects are untouched.

Options:
  --remove-ruflo   ALSO npm-uninstall global ruflo (machine-wide; confirms)
  --remove-aqe     ALSO npm-uninstall global agentic-qe (machine-wide; confirms)
  --purge          --remove-ruflo + --remove-aqe
  --this-project   ALSO revert this repo's statusline patches (run from repo root)
  --yes, -y        skip confirmation prompts (also auto when no TTY)
  --dry-run        preview without changing anything
  -h, --help

Examples:
  ./uninstall.sh                 # kit footprint only
  ./uninstall.sh --this-project  # + revert this repo's statusline
  ./uninstall.sh --purge         # + remove global ruflo & agentic-qe (asks first)
EOF
}

DRY=0
THIS_PROJECT=0
REMOVE_RUFLO=0
REMOVE_AQE=0
ASSUME_YES=0
while [ "$#" -gt 0 ]; do
	case "$1" in
		--dry-run)      DRY=1 ;;
		--this-project) THIS_PROJECT=1 ;;
		--remove-ruflo) REMOVE_RUFLO=1 ;;
		--remove-aqe)   REMOVE_AQE=1 ;;
		--purge)        REMOVE_RUFLO=1; REMOVE_AQE=1 ;;
		--yes|-y)       ASSUME_YES=1 ;;
		-h|--help)      usage; exit 0 ;;
		*) echo "Unknown flag: $1 (try --help)" >&2; exit 2 ;;
	esac
	shift
done

if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'; else C_OK=""; C_WARN=""; C_DIM=""; C_RESET=""; fi
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s⚠%s  %s\n' "$C_WARN" "$C_RESET" "$*"; }
run()  { if [ "$DRY" -eq 1 ]; then printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"; else eval "$*"; fi; }

# ask_yes_no PROMPT DEFAULT(Y|N) -> 0 yes / 1 no. Honors --yes and no-TTY.
ask_yes_no() {
	local prompt="$1" def="${2:-Y}" reply hint="[Y/n]"
	[ "$def" = "N" ] && hint="[y/N]"
	if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
		[ "$def" = "Y" ]; return
	fi
	printf '%s %s ' "$prompt" "$hint"
	read -r reply || reply=""
	reply="${reply:-$def}"
	case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# 1. bin scripts — derived from this repo's bin/, so it always matches install.sh.
for src in "$HERE"/bin/*; do
	[ -f "$src" ] || continue
	f="$HOME/.local/bin/$(basename "$src")"
	[ -f "$f" ] && { run "rm -f '$f'"; ok "removed $f"; }
done

# 2. template
[ -f "$HOME/.config/ruflo/claude-md-template.md" ] && { run "rm -f '$HOME/.config/ruflo/claude-md-template.md'"; ok "removed template"; }

# 3. CLAUDE.md managed block
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
if [ -f "$CLAUDE_MD" ] && grep -q '<!-- BEGIN ruflo-reference -->' "$CLAUDE_MD"; then
	if [ "$DRY" -eq 1 ]; then
		printf '%s[dry-run]%s strip ruflo-reference block from %s\n' "$C_DIM" "$C_RESET" "$CLAUDE_MD"
	else
		cp "$CLAUDE_MD" "$CLAUDE_MD.bak.$(date +%Y%m%d-%H%M%S)"
		new=$(mktemp)
		awk '/<!-- BEGIN ruflo-reference -->/{skip=1} /<!-- END ruflo-reference -->/{skip=0; next} !skip' "$CLAUDE_MD" > "$new"
		mv "$new" "$CLAUDE_MD"
		ok "stripped ruflo-reference block (backup saved; rest of file preserved)"
	fi
fi

# 4. rc source lines
for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do
	if [ -f "$RC" ] && grep -qF "shell/ruflo-functions.sh" "$RC" 2>/dev/null; then
		if [ "$DRY" -eq 1 ]; then
			printf '%s[dry-run]%s remove source line from %s\n' "$C_DIM" "$C_RESET" "$RC"
		else
			cp "$RC" "$RC.bak.$(date +%Y%m%d-%H%M%S)"
			grep -v "shell/ruflo-functions.sh" "$RC" | grep -v "^# ruflo machine reference helpers$" > "$RC.tmp" && mv "$RC.tmp" "$RC"
			ok "removed source line from $RC (backup saved)"
		fi
	fi
done

# 5. (--this-project) revert the kit's statusline patches in the current repo.
if [ "$THIS_PROJECT" -eq 1 ]; then
	echo ""
	echo "## --this-project: revert statusline patches in $(pwd -P)"
	SL=".claude/helpers/statusline.cjs"
	if [ ! -f "$SL" ]; then
		ok "no $SL here — nothing to revert"
	elif ! grep -qE "ruflo-seg:BEGIN|ruflo-machine-ref:" "$SL"; then
		ok "$SL has no ruflo-machine-ref patches — nothing to revert"
	elif [ "$DRY" -eq 1 ]; then
		printf '%s[dry-run]%s strip activation footer + version-probe injection + console.log wrap from %s\n' "$C_DIM" "$C_RESET" "$SL"
	else
		cp "$SL" "$SL.bak.$(date +%Y%m%d-%H%M%S)"
		SL="$SL" node -e '
const fs=require("fs"); const f=process.env.SL; let s=fs.readFileSync(f,"utf8");
s=s.replace(/\/\* ruflo-seg:BEGIN \*\/[\s\S]*?\/\* ruflo-seg:END \*\/\n?/,"");
s=s.replace(/\/\* ruflo-machine-ref: activation segments \*\/\s*\nfunction rufloActivationSegments\(cwd\)\{[\s\S]*?\n\}\n/,"");
s=s.replace(/ \+ rufloActivationSegments\(process\.cwd\(\)\)/g,"");
s=s.replace(/(const pkgPaths = \[) \/\* ruflo-machine-ref: global-install version probe \*\/ require\("path"\)\.join\([^\n]*?"package\.json"\),/,"$1");
fs.writeFileSync(f,s);
' && ok "reverted statusline patches in $SL (backup saved; ruflo render restored)"
		echo "   (the pinned version-string fallback is left as-is — harmless; original value unknown)"
		echo "   To remove ruflo/agentic-qe DATA in this repo: ruflo cleanup --force"
	fi
fi

# 6. (--remove-ruflo / --remove-aqe / --purge) remove global npm packages.
npm_remove_global() {
	local pkg="$1"
	command -v npm >/dev/null 2>&1 || { warn "npm not on PATH — cannot remove $pkg"; return 1; }
	if [ "$DRY" -eq 1 ]; then printf '%s[dry-run]%s npm uninstall -g %s\n' "$C_DIM" "$C_RESET" "$pkg"; return 0; fi
	npm uninstall -g "$pkg" >/dev/null 2>&1 && ok "removed global $pkg" || warn "could not remove $pkg (try: sudo npm uninstall -g $pkg)"
}
if [ "$REMOVE_RUFLO" -eq 1 ] || [ "$REMOVE_AQE" -eq 1 ]; then
	echo ""
	echo "## Remove global npm packages (machine-wide — affects ALL projects)"
	if [ "$REMOVE_RUFLO" -eq 1 ]; then
		if ask_yes_no "Remove global ruflo for ALL projects on this machine?" N; then npm_remove_global ruflo; else ok "kept ruflo"; fi
	fi
	if [ "$REMOVE_AQE" -eq 1 ]; then
		if ask_yes_no "Remove global agentic-qe for ALL projects on this machine?" N; then npm_remove_global agentic-qe; else ok "kept agentic-qe"; fi
	fi
fi

echo ""
ok "Uninstalled. Your projects are untouched; global ruflo/agentic-qe removed only if you asked."
```

- [ ] **Step 2: Syntax check**

Run: `bash -n uninstall.sh`
Expected: no output, exit 0.

- [ ] **Step 3: Lint (if shellcheck installed)**

Run: `command -v shellcheck >/dev/null && shellcheck -S warning uninstall.sh || echo "shellcheck not installed — skipping"`
Expected: no errors.

- [ ] **Step 4: Verify help + dry-runs**

Run: `./uninstall.sh --help`
Expected: usage with `--remove-ruflo`, `--remove-aqe`, `--purge`, `--this-project`.

Run: `./uninstall.sh --dry-run`
Expected: kit-footprint `[dry-run]` lines only; NO "## Remove global npm packages" section.

Run: `./uninstall.sh --purge --dry-run`
Expected: kit-footprint lines PLUS "## Remove global npm packages" with `[dry-run] npm uninstall -g ruflo` and `[dry-run] npm uninstall -g agentic-qe` (no prompt, because dry-run still resolves via `[dry-run]` path; note prompts are skipped here because dry-run prints the intended command directly).

- [ ] **Step 5: Commit**

```bash
git add uninstall.sh
git commit -m "feat(uninstall): opt-in --remove-ruflo/--remove-aqe/--purge with confirmation; keep default kit-only"
```

---

## Task 3: Add `ruflo-onboard` to `shell/ruflo-functions.sh`

**Files:**
- Modify: `shell/ruflo-functions.sh`

- [ ] **Step 1: Read the area around `ruflo-setup-aqe` to choose an insertion point**

Run: `grep -n '^ruflo-neural-train()\|^ruflo-setup-aqe()\|^ruflo-resync()' shell/ruflo-functions.sh`
Expected: line numbers for these functions. Insert `ruflo-onboard` immediately *before* the `ruflo-neural-train()` definition (after `ruflo-setup-aqe` closes).

- [ ] **Step 2: Insert the `ruflo-onboard` function**

Use Edit to insert this block immediately before the `# ---` comment line that precedes `ruflo-neural-train()` (anchor the Edit on the existing comment block that documents `ruflo-neural-train`):

```bash
# ---------------------------------------------------------------------------
# ONE guided per-project setup. Run from inside a repo. Chains the per-project
# steps and prints a summary so you always know what's next.
#
#   ruflo-onboard                 # setup-project + learning-verify
#   ruflo-onboard --with-security # also run the security pass in setup-project
#   ruflo-onboard --aqe           # also initialize agentic-qe in this repo
ruflo-onboard() {
	command -v ruflo >/dev/null 2>&1 || { echo "ruflo not on PATH — run install.sh first" >&2; return 2; }
	local with_security=0 do_aqe=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--with-security)   with_security=1 ;;
			--aqe|--with-aqe)  do_aqe=1 ;;
			*) echo "ruflo-onboard: unknown flag $1" >&2; return 2 ;;
		esac
		shift
	done

	echo "## ruflo-onboard — $(pwd -P)"
	echo ""
	echo "## 1/3 project setup"
	if [ "$with_security" -eq 1 ]; then
		ruflo-setup-project --with-security || { echo "⚠  setup-project failed"; return 1; }
	else
		ruflo-setup-project || { echo "⚠  setup-project failed"; return 1; }
	fi

	echo ""; echo "## 2/3 prove self-learning persists"
	if command -v ruflo-learning-verify >/dev/null 2>&1; then
		ruflo-learning-verify || echo "⚠  learning-verify reported issues — see docs/TROUBLESHOOTING.md"
	else
		echo "⚠  ruflo-learning-verify not on PATH (run install.sh)"
	fi

	if [ "$do_aqe" -eq 1 ]; then
		echo ""; echo "## 3/3 agentic-qe"
		if command -v aqe >/dev/null 2>&1; then
			ruflo-setup-aqe
		else
			echo "⚠  agentic-qe not installed — re-run:  install.sh --with-aqe   (or npm i -g agentic-qe)"
		fi
	fi

	echo ""
	echo "✓ Onboard complete for $(pwd -P)"
	echo "  After any 'npm i -g ruflo@latest' (or agentic-qe@latest), run: ruflo-resync"
}

```

- [ ] **Step 3: Syntax check**

Run: `bash -n shell/ruflo-functions.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Verify the function loads**

Run: `bash -c 'set +u; . shell/ruflo-functions.sh >/dev/null 2>&1; type ruflo-onboard | head -1'`
Expected: `ruflo-onboard is a function`.

- [ ] **Step 5: Commit**

```bash
git add shell/ruflo-functions.sh
git commit -m "feat(onboard): add ruflo-onboard one-command per-project setup wrapper"
```

---

## Task 4: Add breadcrumbs to existing helpers

**Files:**
- Modify: `shell/ruflo-functions.sh` (end of `ruflo-resync`, end of `ruflo-setup-project`)
- Modify: `bin/ruflo-learning-verify` (end of successful run)

- [ ] **Step 1: Find the tail of `ruflo-resync` and `ruflo-setup-project`**

Run: `awk '/^ruflo-resync\(\)/{r=NR} /^ruflo-setup-project\(\)/{p=NR} END{print "resync@"r" setup-project@"p}' shell/ruflo-functions.sh`
Then Read ~20 lines at each location to find the closing `}` of each function.

- [ ] **Step 2: Append a breadcrumb to `ruflo-resync`**

Locate the final lines of `ruflo-resync` (after the `--aqe` block, before the closing `}`). Add this as the last statement inside the function, before `}`:

```bash
	echo ""
	echo "Next: cd <your-repo> && ruflo-onboard   (per-project setup + verify)"
```

- [ ] **Step 3: Append a breadcrumb to `ruflo-setup-project`**

As the last statement inside `ruflo-setup-project`, before its closing `}`, add:

```bash
	echo "Next: ruflo-learning-verify   (prove self-learning persists on disk)"
```

- [ ] **Step 4: Append a breadcrumb to `bin/ruflo-learning-verify`**

Read the end of `bin/ruflo-learning-verify` to find the final success path. Immediately before the final successful `exit 0` (or as the last echo before the script ends on success), add:

```bash
echo "Done. After any 'npm i -g ruflo@latest', run: ruflo-resync"
```

(If the script branches into success/failure, add it only on the success branch so a failed verify doesn't print a misleading "Done.")

- [ ] **Step 5: Syntax check both files**

Run: `bash -n shell/ruflo-functions.sh && bash -n bin/ruflo-learning-verify && echo OK`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add shell/ruflo-functions.sh bin/ruflo-learning-verify
git commit -m "feat(onboard): next-step breadcrumbs on resync, setup-project, learning-verify"
```

---

## Task 5: README — Prerequisites + Quick start

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Insert a Prerequisites section before Quick start**

Find the line `## 🚀 Quick start` and insert this block immediately *before* it (keep the surrounding `---` separators tidy):

```markdown
## ✅ Prerequisites

This kit *configures and heals* ruflo — it doesn't bundle it. You need a few
things on your machine first. `install.sh` checks for these and can install the
npm packages for you (interactively, or via flags).

**Required (install.sh aborts if missing):**

| Tool | Why | Get it |
|---|---|---|
| Node.js 20–26 | runtime for ruflo & the helpers | <https://nodejs.org> |
| npm | installs the global packages | ships with Node.js |
| `ruflo` | the orchestration toolkit this kit configures | `npm i -g ruflo` (install.sh can do this) |

**Recommended (install.sh warns, then continues):**

| Tool | Why |
|---|---|
| `claude` (Claude Code) | the agent this all runs inside |
| `sqlite3` | the status line + memory verifications read the DBs |
| `git` | to clone/update this kit |

**Optional (only for the QE fleet):**

| Tool | Why | Get it |
|---|---|---|
| `agentic-qe` (`aqe`) | the standalone quality-engineering fleet (🎓 segment) | `npm i -g agentic-qe` (install.sh `--with-aqe`) |

> 🔑 **"Security" and "learning" are not separate installs.** `@claude-flow/security`,
> `@claude-flow/aidefence`, and the ruvector self-learning engine all ship *inside*
> ruflo — this kit *activates and verifies* them. So the "full boat" is just two
> npm packages (`ruflo` + `agentic-qe`); the kit lights up the rest.

---
```

- [ ] **Step 2: Replace the Quick start body**

Replace the existing Quick start code block + the token note under `## 🚀 Quick start` with:

```markdown
The fastest path — install the kit, prereqs, and heal in one go:

```bash
# 1. Get the kit
git clone https://github.com/pacphi/ruflo-machine-ref.git && cd ruflo-machine-ref

# 2. Bootstrap the machine (pick your level)
./install.sh                 # friendly interactive onboard (asks per step)
./install.sh --full --yes    # "full boat": ruflo + agentic-qe + heal, no prompts
./install.sh --ruflo-only    # just ruflo + heal
./install.sh --minimal       # only lay down the kit files (you have the prereqs)
exec $SHELL                  # load the helper functions

# 3. In any project you work in
cd ~/my-project
ruflo-onboard                # clean setup + prove self-learning persists, in one step
ruflo-onboard --aqe          # …and also initialize the agentic-qe fleet here
```

Try `./install.sh --dry-run` first to preview exactly what it will do.

🪙 **Prefer CLI-only (no MCP, ~84k tokens saved per session)?** Skip
`ruflo-setup-machine`; the installed `~/.claude/CLAUDE.md` reference teaches
Claude Code to drive ruflo through plain Bash.
```

- [ ] **Step 3: Verify the markdown still renders coherently**

Run: `grep -n "## ✅ Prerequisites\|## 🚀 Quick start\|ruflo-onboard" README.md`
Expected: Prerequisites appears before Quick start; `ruflo-onboard` referenced in Quick start.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Prerequisites section and one-command Quick start with profiles"
```

---

## Task 6: README — commands table, uninstall, decision guide

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `ruflo-onboard` to the commands table**

In the `## 🛠️ The commands` table, add this row directly under the `ruflo-resync` row:

```markdown
| 📂 `ruflo-onboard [--with-security] [--aqe]` | **Per-repo, run from inside it.** One command: clean `setup-project` → prove learning persists → (`--aqe`) initialize agentic-qe. Prints what's active + what's next. |
```

- [ ] **Step 2: Add a "Which command do I run?" decision guide**

Insert this new section immediately *after* the `## 🛠️ The commands` table (before `## 📟 The status line`):

```markdown
---

## 🧭 Which command do I run?

**`install.sh` is the front door you walk through once; the functions are how you live in the house.**

| | `install.sh` | The functions |
|---|---|---|
| **Nature** | a script run *from the kit repo* | commands on your `PATH`, available everywhere after install |
| **Frequency** | once per machine (+ rarely, to re-lay the kit) | ongoing, day-to-day |
| **Scope** | machine-level bootstrap | machine-recurring **and** per-project |

On first run the functions aren't sourced yet, so `install.sh` sources them
in-process and calls the *same* `ruflo-patch-native` / `ruflo-enable-learning`
to heal — one source of truth, no drift. After that you never need `install.sh`
for healing again.

| Situation | Run this | Why not the other |
|---|---|---|
| 🆕 Brand-new machine | **`install.sh`** | nothing's on PATH yet — only the script can bootstrap |
| 🔁 Re-cloned kit / new shell / wiped `~/.local/bin` | **`install.sh`** | re-lays the kit files (idempotent, backs up) |
| ⬆️ After `npm i -g ruflo@latest` (or aqe) | **`ruflo-resync`** | the upgrade only wiped native binaries — re-running install.sh is the heavier wrong tool |
| 📂 Starting in a new repo | **`ruflo-onboard`** | per-project; install.sh is machine-level and won't touch your repo |
| 🔍 Routine checks | **functions** (`ruflo-parity-test`, `ruflo-learning-verify`) | no reason to re-bootstrap |

**Rule of thumb:**
- *"I'm setting up"* → `install.sh` (once).
- *"I upgraded ruflo/aqe"* → `ruflo-resync`.
- *"I'm starting work in a repo"* → `ruflo-onboard`.

---
```

- [ ] **Step 3: Update the Uninstall section**

Replace the code block + prose under `## 🗑️ Uninstall` with:

```markdown
```bash
./uninstall.sh                  # kit footprint only: bin scripts, template, CLAUDE.md block, rc line
./uninstall.sh --this-project   # ALSO revert the kit's statusline patches in the current repo
./uninstall.sh --remove-ruflo   # ALSO npm-uninstall global ruflo (machine-wide; asks first)
./uninstall.sh --remove-aqe     # ALSO npm-uninstall global agentic-qe (machine-wide; asks first)
./uninstall.sh --purge          # --remove-ruflo + --remove-aqe
./uninstall.sh --dry-run        # preview without changing anything
```

The plain `uninstall.sh` removes only machine-level kit setup; your ruflo
install, memory DBs, and **project files** are left untouched. The
`--remove-ruflo` / `--remove-aqe` / `--purge` flags reach the *global npm
packages* — they affect every project on the machine, so each one prompts to
confirm (pass `--yes` to skip in scripts). Add `--this-project` from a repo root
to revert that repo's statusline patches too (it backs up first and leaves all
ruflo/agentic-qe data alone — use `ruflo cleanup --force` for per-project data).
```

- [ ] **Step 4: Update the "What's in the box" tree**

In the `## 📦 What's in the box` code block, update the `install.sh` / `uninstall.sh` comment lines and the `shell/` line to:

```
├── install.sh                 # machine bootstrap: prereqs + kit + heal (profiles, interactive)
├── uninstall.sh               # clean reversal (opt-in --purge for global npm packages)
```

and

```
│   └── ruflo-functions.sh     # ruflo-resync, ruflo-onboard, ruflo-setup-project, ruflo-setup-aqe, …
```

- [ ] **Step 5: Verify references**

Run: `grep -n "ruflo-onboard\|--purge\|Which command do I run" README.md`
Expected: matches in the commands table, the decision guide, and the uninstall section.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): ruflo-onboard command, 'which command do I run?' guide, uninstall flags"
```

---

## Task 7: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Syntax-check everything**

Run: `bash -n install.sh && bash -n uninstall.sh && bash -n shell/ruflo-functions.sh && bash -n bin/ruflo-learning-verify && echo ALL-OK`
Expected: `ALL-OK`.

- [ ] **Step 2: Lint everything (if shellcheck installed)**

Run: `command -v shellcheck >/dev/null && shellcheck -S warning install.sh uninstall.sh || echo "shellcheck not installed — skipping"`
Expected: no errors.

- [ ] **Step 3: Dry-run matrix**

Run each and eyeball against the expectations in Tasks 1 & 2:
```bash
./install.sh --help
./install.sh --minimal --dry-run
./install.sh --full --yes --dry-run
./install.sh --ruflo-only --yes --dry-run
./uninstall.sh --help
./uninstall.sh --dry-run
./uninstall.sh --purge --dry-run
```
Expected: `--ruflo-only` shows `npm install -g ruflo` but NOT `agentic-qe`; everything else as described in the per-task steps.

- [ ] **Step 4: No-TTY safety check**

Run: `printf '' | ./install.sh --dry-run >/tmp/inst.out 2>&1; grep -c "Install ruflo is not installed" /tmp/inst.out; tail -3 /tmp/inst.out`
Expected: the run completes without blocking on a prompt (no-TTY → defaults used). The exact grep count isn't important; the point is it returns rather than hanging.

- [ ] **Step 5: Confirm working tree is clean and review the log**

Run: `git status --short && git log --oneline -8`
Expected: clean tree; the 6 implementation commits plus the spec commit visible.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1 prereqs → Task 1 preflight + Task 5 README. §2 install profiles/flags/order → Task 1. §3 uninstall flags → Task 2. §4 README → Tasks 5–6. §5 breadcrumbs + `ruflo-onboard` + context banner → Tasks 3, 4, and Task 1's banner. §6 mental model → Task 6 decision guide. All covered.
- **Placeholders:** none — every step has concrete code/commands.
- **Type/name consistency:** `ask_yes_no PROMPT DEFAULT` identical in install.sh and uninstall.sh; `WANT_RUFLO/WANT_AQE/DO_HEAL` use the `auto|yes|no` tri-state throughout; `ruflo-onboard` flags (`--with-security`, `--aqe`/`--with-aqe`) match the README rows and Quick start usage.
- **Known soft spots flagged for execution:** Task 4 requires reading the exact closing `}` of `ruflo-resync`/`ruflo-setup-project` and the success branch of `bin/ruflo-learning-verify` before editing (the breadcrumb text is fixed; only the anchor must be located live).
