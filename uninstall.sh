#!/usr/bin/env bash
#
# uninstall.sh — remove what install.sh placed on this machine.
#
# Removes:
#   ~/.local/bin/ruflo-patch-native, ~/.local/bin/ruflo-parity-test
#   ~/.config/ruflo/claude-md-template.md
#   the BEGIN/END ruflo-reference block from ~/.claude/CLAUDE.md (content
#     outside the sentinels is preserved)
#   the source line from ~/.zshrc / ~/.bashrc
#
# Leaves your ruflo installation, memory DBs, and project files untouched.
#
# Usage: ./uninstall.sh [--dry-run]

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { sed -n '3,17p' "$0" | sed 's|^# \{0,1\}||'; exit 0; }

if [ -t 1 ]; then C_OK=$'\033[32m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'; else C_OK=""; C_DIM=""; C_RESET=""; fi
ok()  { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
run() { if [ "$DRY" -eq 1 ]; then printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"; else eval "$*"; fi; }

# 1. bin scripts
for f in "$HOME/.local/bin/ruflo-patch-native" "$HOME/.local/bin/ruflo-parity-test"; do
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

echo ""
ok "Uninstalled. Your ruflo install, memory DBs, and projects are untouched."
