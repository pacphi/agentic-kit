#!/usr/bin/env bash
#
# install.sh — set up the ruflo machine reference on this machine.
#
# Installs:
#   bin/ruflo-patch-native, bin/ruflo-parity-test   -> ~/.local/bin/
#   claude/ruflo-reference.md                        -> ~/.config/ruflo/claude-md-template.md
#   the ruflo-reference block                        -> ~/.claude/CLAUDE.md (sentinel-managed)
#   a source line for shell/ruflo-functions.sh       -> ~/.zshrc or ~/.bashrc
#
# Idempotent and re-runnable. Backs up any file it rewrites.
#
# Usage:
#   ./install.sh                 # auto-detect shell rc, install everything
#   ./install.sh --shell zsh     # force zshrc
#   ./install.sh --shell bash    # force bashrc
#   ./install.sh --no-shell-rc   # skip editing rc (you source the file yourself)
#   ./install.sh --dry-run       # show what would happen
#   ./install.sh --help

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

SHELL_CHOICE="auto"
EDIT_RC=1
DRY=0
while [ "$#" -gt 0 ]; do
	case "$1" in
		--shell) shift; SHELL_CHOICE="$1" ;;
		--no-shell-rc) EDIT_RC=0 ;;
		--dry-run) DRY=1 ;;
		-h|--help) sed -n '3,22p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
		*) echo "Unknown flag: $1 (try --help)" >&2; exit 2 ;;
	esac
	shift
done

if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'; else C_OK=""; C_WARN=""; C_DIM=""; C_RESET=""; fi
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s⚠%s  %s\n' "$C_WARN" "$C_RESET" "$*"; }
run()  { if [ "$DRY" -eq 1 ]; then printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"; else eval "$*"; fi; }

BIN_DIR="$HOME/.local/bin"
CFG_DIR="$HOME/.config/ruflo"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

echo "Installing ruflo machine reference from: $HERE"
echo ""

# 1. bin scripts — installed from bin/ (derived, so install/uninstall never drift).
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

# 2. CLAUDE.md reference template
echo "## CLAUDE.md reference template -> $CFG_DIR/claude-md-template.md"
run "mkdir -p '$CFG_DIR'"
run "cp '$HERE/claude/ruflo-reference.md' '$CFG_DIR/claude-md-template.md'"
ok "template installed"
echo ""

# 3. Merge the reference block into ~/.claude/CLAUDE.md (sentinel-managed)
echo "## ruflo-reference block -> $CLAUDE_MD"
run "mkdir -p '$HOME/.claude'"
if [ "$DRY" -eq 1 ]; then
	printf '%s[dry-run]%s merge BEGIN/END ruflo-reference block into %s\n' "$C_DIM" "$C_RESET" "$CLAUDE_MD"
elif [ ! -f "$CLAUDE_MD" ]; then
	cp "$HERE/claude/ruflo-reference.md" "$CLAUDE_MD"
	ok "created $CLAUDE_MD from template"
elif grep -q '<!-- BEGIN ruflo-reference -->' "$CLAUDE_MD"; then
	# Replace existing managed block, preserve everything outside it.
	cp "$CLAUDE_MD" "$CLAUDE_MD.bak.$(date +%Y%m%d-%H%M%S)"
	pre=$(mktemp); post=$(mktemp); new=$(mktemp)
	awk '/<!-- BEGIN ruflo-reference -->/{exit} {print}' "$CLAUDE_MD" > "$pre"
	awk 'f; /<!-- END ruflo-reference -->/{f=1}' "$CLAUDE_MD" > "$post"
	cat "$pre" "$HERE/claude/ruflo-reference.md" "$post" > "$new"
	mv "$new" "$CLAUDE_MD"; rm -f "$pre" "$post"
	ok "updated managed block (backup saved; content outside sentinels preserved)"
else
	# Append the block to existing user content.
	cp "$CLAUDE_MD" "$CLAUDE_MD.bak.$(date +%Y%m%d-%H%M%S)"
	{ echo ""; cat "$HERE/claude/ruflo-reference.md"; } >> "$CLAUDE_MD"
	ok "appended ruflo-reference block (backup saved)"
fi
echo ""

# 4. Shell rc source line
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

ok "Done."
echo ""
echo "Next steps:"
echo "  1. exec \$SHELL                 # load the helper functions"
echo "  2. ruflo-patch-native --check  # confirm native SQLite status on your Node"
echo "  3. cd <your repo> && ruflo-setup-project"
echo "  4. ruflo-parity-test           # end-to-end smoke test (isolated /tmp dir)"
