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
export ASSUME_YES   # read by ask_yes_no() in ruflo-lib.sh (export marks it used)
PROFILE=""
WANT_RUFLO="auto"
WANT_AQE="auto"
DO_HEAL="auto"
ALL_ARGS=" $* "

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
			case "$SHELL_CHOICE" in
				zsh|bash) ;;
				"") echo "error: --shell requires an argument (zsh or bash)" >&2; exit 2 ;;
				*)  echo "error: --shell must be 'zsh' or 'bash' (got '$SHELL_CHOICE')" >&2; exit 2 ;;
			esac
			;;
		--no-shell-rc) EDIT_RC=0 ;;
		--dry-run)     DRY=1 ;;
		-h|--help)     usage; exit 0 ;;
		*) echo "Unknown flag: $1 (try --help)" >&2; exit 2 ;;
	esac
	shift
done

# Shared helpers (colors, ok/warn/run/have, ask_yes_no) from ruflo-lib.sh — repo
# copy first (we run from the repo), installed copy as fallback.
for _cand in "$HERE/shell/ruflo-lib.sh" "$HOME/.config/ruflo/ruflo-lib.sh"; do
	# shellcheck source=/dev/null
	[ -f "$_cand" ] && { . "$_cand"; break; }
done
[ -n "${_RUFLO_LIB:-}" ] || { echo "error: ruflo-lib.sh not found (expected shell/ruflo-lib.sh)" >&2; exit 2; }

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

# --- Warn on conflicting granular flags (last one wins, but flag the conflict) ---
warn_conflict() {
	case "$ALL_ARGS" in *" $1 "*) case "$ALL_ARGS" in *" $2 "*) warn "both $1 and $2 passed — last one wins" ;; esac ;; esac
}
warn_conflict --with-ruflo --no-ruflo
warn_conflict --with-aqe --no-aqe
warn_conflict --heal --no-heal

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

# CLAUDE.md reference templates: the always-on ruflo-reference base + every conditional
# sub-block template from the registry in ruflo-lib.sh (agentic-qe, superpowers, …).
# Staging is registry-driven — adding a tool there auto-stages its template, no edit here.
echo "## CLAUDE.md reference templates -> $CFG_DIR/"
run "mkdir -p '$CFG_DIR'"
run "cp '$HERE/claude/ruflo-reference.md' '$CFG_DIR/claude-md-template.md'"
_ruflo_cond_blocks | while IFS='|' read -r _slug _src _tmpl _detector; do
	[ -n "$_slug" ] || continue
	run "cp '$HERE/claude/$_src' '$CFG_DIR/$_tmpl'"
done
ok "templates installed (ruflo-reference + $(_ruflo_cond_blocks | grep -c .) conditional blocks)"
echo ""

# Shared helper lib — deployed to a stable absolute path so the standalone bin
# scripts (which run from ~/.local/bin, no repo nearby) can source it.
echo "## shared helper lib -> $CFG_DIR/ruflo-lib.sh"
run "cp '$HERE/shell/ruflo-lib.sh' '$CFG_DIR/ruflo-lib.sh'"
ok "helper lib installed"

# Shell functions — also deployed to the stable CFG_DIR so the repo can be
# moved or deleted after install without breaking the shell. Re-run install.sh
# to pick up function changes (intentional — updates should be explicit).
echo "## shell functions -> $CFG_DIR/ruflo-functions.sh"
run "cp '$HERE/shell/ruflo-functions.sh' '$CFG_DIR/ruflo-functions.sh'"
ok "shell functions installed"
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

# Conditional operating blocks (agentic-qe, superpowers, …): each present in
# ~/.claude/CLAUDE.md ONLY when its tool is detected; stripped otherwise (self-healing on
# uninstall). Driven by the registry in ruflo-lib.sh — see docs/CONDITIONAL-BLOCKS.md.
echo "## conditional CLAUDE.md blocks (per detected tool) -> $CLAUDE_MD"
if [ "$DRY" -eq 1 ]; then
	_ruflo_cond_blocks | while IFS='|' read -r _slug _src _tmpl _detector; do
		[ -n "$_slug" ] || continue
		if eval "$_detector" >/dev/null 2>&1; then
			printf '%s[dry-run]%s upsert %s (detector matched)\n' "$C_DIM" "$C_RESET" "$_slug"
		else
			printf '%s[dry-run]%s strip %s (detector did not match)\n' "$C_DIM" "$C_RESET" "$_slug"
		fi
	done
else
	_ruflo_sync_cond_blocks "$CLAUDE_MD" "$CFG_DIR"
	ok "conditional blocks synced to detected tools"
fi
echo ""

# Shell rc source line — point at the STABLE installed copy, not the repo.
# This lets the repo be moved or deleted after install without breaking the shell.
# Existing installs with a legacy repo-path source line are migrated automatically.
if [ "$EDIT_RC" -eq 1 ]; then
	echo "## shell rc source line"
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
		STABLE_LINE="source \"$CFG_DIR/ruflo-functions.sh\""
		if [ "$DRY" -eq 1 ]; then
			printf '%s[dry-run]%s ensure %s sources %s\n' "$C_DIM" "$C_RESET" "$RC" "$CFG_DIR/ruflo-functions.sh"
		elif [ -f "$RC" ] && grep -qF "$STABLE_LINE" "$RC" 2>/dev/null; then
			ok "$RC already sources ruflo-functions.sh from stable path"
		elif [ -f "$RC" ] && grep -qF "ruflo-functions.sh" "$RC" 2>/dev/null; then
			# Migrate legacy repo-path source line to the stable installed path
			if sed --version >/dev/null 2>&1; then
				sed -i "s|source \".*ruflo-functions\.sh\"|$STABLE_LINE|g" "$RC"
			else
				sed -i '' "s|source \".*ruflo-functions\.sh\"|$STABLE_LINE|g" "$RC"
			fi
			ok "migrated $RC: repo-path source → stable path"
		else
			printf '\n# ruflo machine reference helpers\n%s\n' "$STABLE_LINE" >> "$RC"
			ok "added source line to $RC"
		fi
		echo "   (run 'exec \$SHELL' or open a new terminal to load the functions)"
	fi
else
	echo "## shell rc source line (skipped --no-shell-rc)"
	echo "   Add manually:  source \"$CFG_DIR/ruflo-functions.sh\""
fi
echo ""

# --- Global heal (optional) — reuse shipped helpers, no reimplementation ---
if [ "$DO_HEAL" = yes ]; then
	echo "## Heal (native SQLite + self-learning)"
	if [ "$DRY" -eq 1 ]; then
		printf '%s[dry-run]%s run ruflo-patch-native, ruflo-enable-learning, agentic-qe native patch\n' "$C_DIM" "$C_RESET"
	elif have ruflo; then
		# shellcheck source=/dev/null
		[ -f "$CFG_DIR/ruflo-functions.sh" ] && . "$CFG_DIR/ruflo-functions.sh"
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
n=1
echo "  $n. exec \$SHELL                 # load the helper functions"; n=$((n+1))
if [ "$DO_HEAL" != yes ]; then
	echo "  $n. ruflo-resync                # native SQLite + self-learning + statusline"; n=$((n+1))
fi
TARGET=""
if [ "$(pwd -P)" != "$HERE" ] && [ -d ".git" ]; then TARGET="$(pwd -P)"; fi
if [ -n "$TARGET" ]; then
	echo "  $n. ruflo-onboard               # you're in a repo ($TARGET) — set it up now"; n=$((n+1))
else
	echo "  $n. cd <your-repo> && ruflo-onboard   # per-project: setup + verify in one step"; n=$((n+1))
fi
echo "  $n. ruflo-parity-test           # end-to-end memory smoke test (isolated /tmp dir)"
