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
		--shell)
			shift
			SHELL_CHOICE="${1:-}"
			[ -z "$SHELL_CHOICE" ] && { echo "error: --shell requires an argument (zsh or bash)" >&2; exit 2; }
			;;
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
case "$NODE_MAJOR" in
	''|*[!0-9]*)
		warn "could not determine Node major version (got: '${NODE_MAJOR:-empty}') — proceeding"
		NODE_MAJOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 20 ] || [ "$NODE_MAJOR" -gt 26 ]; then
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
	if [ "$WANT_RUFLO" = yes ]; then
		warn "ruflo install failed or not yet on PATH — heal will be skipped."
		warn "Fix: sudo npm install -g ruflo  (or add npm's global bin to PATH), then re-run."
	else
		warn "ruflo is not on PATH — the kit's helpers will not work until it is installed"
	fi
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
