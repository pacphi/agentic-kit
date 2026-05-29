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

# Shared helpers (colors, ok/warn/run, ask_yes_no, _ruflo_daemon_list) from
# ruflo-lib.sh — repo copy first (we run from the repo), installed copy as fallback.
for _cand in "$HERE/shell/ruflo-lib.sh" "$HOME/.config/ruflo/ruflo-lib.sh"; do
	# shellcheck source=/dev/null
	[ -f "$_cand" ] && { . "$_cand"; break; }
done
[ -n "${_RUFLO_LIB:-}" ] || { echo "error: ruflo-lib.sh not found (expected shell/ruflo-lib.sh)" >&2; exit 2; }

# 1. bin scripts — derived from this repo's bin/, so it always matches install.sh.
for src in "$HERE"/bin/*; do
	[ -f "$src" ] || continue
	f="$HOME/.local/bin/$(basename "$src")"
	[ -f "$f" ] && { run "rm -f '$f'"; ok "removed $f"; }
done

# 2. template
[ -f "$HOME/.config/ruflo/claude-md-template.md" ] && { run "rm -f '$HOME/.config/ruflo/claude-md-template.md'"; ok "removed template"; }

# 2b. shared helper lib (already sourced at the top, so removing it here is safe)
[ -f "$HOME/.config/ruflo/ruflo-lib.sh" ] && { run "rm -f '$HOME/.config/ruflo/ruflo-lib.sh'"; ok "removed helper lib"; }

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
		# shellcheck disable=SC2016  # single-quoted JS for node -e, not shell expansion
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

# 6. Daemon teardown (issue #3): always reap stale (workspace-gone) daemons;
#    with --this-project also stop the daemon bound to THIS repo's workspace.
#    Never touches unrelated live-workspace daemons. The ps-parser (_ruflo_daemon_list)
#    is provided by ruflo-lib.sh, sourced at the top of this script.
echo ""
echo "## Daemon teardown"
if ! command -v _ruflo_daemon_list >/dev/null 2>&1; then
	warn "ruflo-lib.sh not loaded — skipping daemon teardown"
else
	THIS_WS="$(pwd -P)"
	DAEMON_HITS=0
	while IFS="$(printf '\t')" read -r dpid dws; do
		[ -n "${dpid:-}" ] || continue
		stale=0; mine=0
		[ -d "$dws" ] || stale=1
		[ "$dws" = "$THIS_WS" ] && [ "$THIS_PROJECT" -eq 1 ] && mine=1
		if [ "$stale" -eq 1 ] || [ "$mine" -eq 1 ]; then
			DAEMON_HITS=$((DAEMON_HITS+1))
			if [ "$stale" -eq 1 ]; then reason="workspace gone"; else reason="this project"; fi
			if [ "$DRY" -eq 1 ]; then
				printf '%s[dry-run]%s stop daemon pid=%s (%s): %s\n' "$C_DIM" "$C_RESET" "$dpid" "$reason" "$dws"
			else
				if kill "$dpid" 2>/dev/null; then ok "stopped daemon pid=$dpid ($reason): $dws"; else warn "could not stop pid=$dpid"; fi
			fi
		fi
	done <<EOF
$(_ruflo_daemon_list)
EOF
	if [ "$DAEMON_HITS" -eq 0 ]; then
		if [ "$THIS_PROJECT" -eq 1 ]; then
			ok "no daemons to stop (none stale; none for this project)"
		else
			ok "no stale daemons to stop"
		fi
	fi
fi

# 7. (--remove-ruflo / --remove-aqe / --purge) remove global npm packages.
npm_remove_global() {
	local pkg="$1"
	command -v npm >/dev/null 2>&1 || { warn "npm not on PATH — cannot remove $pkg"; return 1; }
	if [ "$DRY" -eq 1 ]; then printf '%s[dry-run]%s npm uninstall -g %s\n' "$C_DIM" "$C_RESET" "$pkg"; return 0; fi
	if npm uninstall -g "$pkg" >/dev/null 2>&1; then
		ok "removed global $pkg"
	else
		warn "could not remove $pkg (try: sudo npm uninstall -g $pkg)"
	fi
}
if [ "$REMOVE_RUFLO" -eq 1 ] || [ "$REMOVE_AQE" -eq 1 ]; then
	echo ""
	echo "## Remove global npm packages (machine-wide — affects ALL projects)"
	if [ "$REMOVE_RUFLO" -eq 1 ]; then
		if [ "$DRY" -eq 1 ] || [ "$ASSUME_YES" -eq 1 ] || ask_yes_no "Remove global ruflo for ALL projects on this machine?" N; then
			npm_remove_global ruflo
		elif [ ! -t 0 ]; then
			warn "ruflo not removed — no TTY to confirm; pass --yes to remove non-interactively"
		else
			ok "kept ruflo"
		fi
	fi
	if [ "$REMOVE_AQE" -eq 1 ]; then
		if [ "$DRY" -eq 1 ] || [ "$ASSUME_YES" -eq 1 ] || ask_yes_no "Remove global agentic-qe for ALL projects on this machine?" N; then
			npm_remove_global agentic-qe
		elif [ ! -t 0 ]; then
			warn "agentic-qe not removed — no TTY to confirm; pass --yes to remove non-interactively"
		else
			ok "kept agentic-qe"
		fi
	fi
fi

echo ""
ok "Uninstalled. Your projects are untouched; global ruflo/agentic-qe removed only if you asked."
