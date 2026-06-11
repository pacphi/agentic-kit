# shellcheck shell=bash
# ruflo-lib.sh — shared helpers for the ruflo machine-reference kit.
#
# One place for the logic that was previously copy-pasted across install.sh,
# uninstall.sh, and the bin/ helpers: colored output, yes/no prompting, a dry-run
# wrapper, PATH guards, the ruflo-daemon ps-parser (issue #3), and the Node-ABI /
# native better-sqlite3 primitives.
#
# Sourced by: install.sh, uninstall.sh, shell/ruflo-functions.sh, and every bin/
# script. install.sh deploys this to ~/.config/ruflo/ruflo-lib.sh so the
# standalone bin scripts (which run from ~/.local/bin, no repo nearby) can source
# it from a stable absolute path; consumers fall back to the repo copy.
#
# Pure definitions — sourcing has no side effects beyond setting the C_* color
# vars and defining functions. Compatible with bash 4+ and zsh. The functions
# meant for external callers are intentionally "unused" within this file.
# shellcheck disable=SC2329

# --- colored output ---------------------------------------------------------
# Set once at source time (matches the per-script behavior these replaced).
# C_HEAD is used by an external consumer (parity-test's head_line), not in this file.
# shellcheck disable=SC2034
if [ -t 1 ]; then
	C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_FAIL=$'\033[31m'
	C_DIM=$'\033[2m'; C_HEAD=$'\033[1;36m'; C_RESET=$'\033[0m'
else
	C_OK=""; C_WARN=""; C_FAIL=""; C_DIM=""; C_HEAD=""; C_RESET=""
fi

ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s⚠%s  %s\n' "$C_WARN" "$C_RESET" "$*"; }
fail() { printf '%s✗%s %s\n' "$C_FAIL" "$C_RESET" "$*"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

# run CMD… — execute, or just print it under dry-run (DRY=1). Used by install/uninstall.
run() { if [ "${DRY:-0}" -eq 1 ]; then printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"; else eval "$*"; fi; }

# have CMD — true if CMD is on PATH.
have() { command -v "$1" >/dev/null 2>&1; }

# _ruflo_need CMD… — abort (exit 2) if any CMD is missing. For standalone scripts.
_ruflo_need() {
	local c
	for c in "$@"; do
		command -v "$c" >/dev/null 2>&1 || { fail "$c not on PATH"; exit 2; }
	done
}

# ask_yes_no PROMPT DEFAULT(Y|N) -> 0 yes / 1 no. Honors ASSUME_YES and no-TTY.
ask_yes_no() {
	local prompt="$1" def="${2:-Y}" reply hint="[Y/n]"
	[ "$def" = "N" ] && hint="[y/N]"
	if [ "${ASSUME_YES:-0}" -eq 1 ] || [ ! -t 0 ]; then
		[ "$def" = "Y" ]; return
	fi
	printf '%s %s ' "$prompt" "$hint"
	read -r reply || reply=""
	reply="${reply:-$def}"
	case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# --- ruflo daemon process helpers (issue #3) --------------------------------
# _ruflo_daemon_list — emit "<pid>\t<workspace>" for every running ruflo daemon.
# Portable: `ps axww` (on BSD/macOS `-e` means "environment", so it is avoided;
# `ww` prevents column truncation of long --workspace paths). `read -r pid rest`
# trims ps's leading PID-column padding. The `cli.js` filter excludes unrelated
# processes (e.g. the shell running this parser) whose argv merely contains the
# literal strings "daemon start"/"--workspace".
_ruflo_daemon_list() {
	ps axww -o pid=,args= 2>/dev/null | while read -r pid rest; do
		case "$rest" in *"daemon start"*) ;; *) continue ;; esac
		case "$rest" in *cli.js*) ;; *) continue ;; esac
		case "$rest" in *"--workspace "*) ;; *) continue ;; esac
		ws=${rest#*--workspace }; ws=${ws%% --*}
		[ -n "$pid" ] && [ -n "$ws" ] && printf '%s\t%s\n' "$pid" "$ws"
	done
}

# _ruflo_daemon_age_secs PID — elapsed seconds since the process started, parsed
# from `ps -o etime=` ([[dd-]hh:]mm:ss; portable across macOS BSD ps and Linux,
# neither of which guarantees the `etimes` field). Echoes 0 if the pid is gone or
# unparseable, so callers can compare numerically without guarding.
_ruflo_daemon_age_secs() {
	local et
	et=$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' ')
	[ -n "$et" ] || { echo 0; return; }
	printf '%s' "$et" | awk -F'[:-]' '{
		n=NF; s=$n; m=(n>=2)?$(n-1):0; h=(n>=3)?$(n-2):0; d=(n>=4)?$(n-3):0;
		print ((d*24+h)*60+m)*60+s
	}'
}

# --- Node ABI / native better-sqlite3 primitives ----------------------------
# _ruflo_node_abi — the running Node's NODE_MODULE_VERSION (ABI), e.g. 137.
_ruflo_node_abi() { node -e 'process.stdout.write(process.versions.modules)' 2>/dev/null; }

# _ruflo_global_root — `npm root -g` (global node_modules dir).
_ruflo_global_root() { npm root -g 2>/dev/null; }

# _ruflo_bsq3_is_native DIR — 0 if a native better-sqlite3 resolves from DIR.
_ruflo_bsq3_is_native() {
	node -e "
try {
  const p = require.resolve('better-sqlite3', { paths: ['$1'] });
  const base = p.split('/better-sqlite3/')[0] + '/better-sqlite3';
  process.exit(require('fs').existsSync(base + '/build/Release/better_sqlite3.node') ? 0 : 1);
} catch (e) { process.exit(1); }
" 2>/dev/null
}

# _ruflo_bsq3_install DIR [RANGE] — install better-sqlite3 into DIR (default ^12).
_ruflo_bsq3_install() {
	( cd "$1" && npm install "better-sqlite3@${2:-^12}" --no-save --no-audit --no-fund >/dev/null 2>&1 )
}

# --- sentinel-delimited block management (CLAUDE.md sub-blocks) -------------
# Manage a `<!-- BEGIN x -->`…`<!-- END x -->` block in a file. These are the generic
# primitives behind every conditional block in ~/.claude/CLAUDE.md (see the
# conditional-block registry below). Idempotent; preserve everything outside the
# markers. Markers are matched as fixed substrings (awk index()).

# _ruflo_block_upsert FILE BEGIN END SRC — replace the BEGIN..END block in FILE with
# the contents of SRC (which must itself contain the markers); append if the block is
# absent; create FILE from SRC if FILE is missing. Returns 1 if SRC is unreadable.
_ruflo_block_upsert() {
	local file="$1" begin="$2" end="$3" src="$4"
	[ -f "$src" ] || return 1
	mkdir -p "$(dirname "$file")" 2>/dev/null
	if [ ! -f "$file" ]; then cat "$src" > "$file"; return 0; fi
	if grep -qF "$begin" "$file"; then
		local pre post new; pre=$(mktemp); post=$(mktemp); new=$(mktemp)
		awk -v b="$begin" 'index($0,b){exit} {print}' "$file" > "$pre"
		awk -v e="$end" 'f; index($0,e){f=1}' "$file" > "$post"
		cat "$pre" "$src" "$post" > "$new"
		cat "$new" > "$file"; rm -f "$pre" "$post" "$new"
	else
		{ printf '\n'; cat "$src"; } >> "$file"
	fi
}

# _ruflo_block_strip FILE BEGIN END — remove the BEGIN..END block (inclusive) from
# FILE. No-op if FILE or the block is absent.
_ruflo_block_strip() {
	local file="$1" begin="$2" end="$3"
	[ -f "$file" ] || return 0
	grep -qF "$begin" "$file" || return 0
	local new; new=$(mktemp)
	awk -v b="$begin" -v e="$end" '
		index($0,b){skip=1}
		!skip{print}
		index($0,e){skip=0}
	' "$file" > "$new"
	cat "$new" > "$file"; rm -f "$new"
}

# _ruflo_block_prepend FILE SRC — insert SRC (which carries its own BEGIN/END markers)
# at the very TOP of FILE; create FILE from SRC if missing. Unlike _ruflo_block_upsert
# (which appends when the marker is absent), this is for an always-on block that must
# lead the file. Returns 1 if SRC is unreadable.
_ruflo_block_prepend() {
	local file="$1" src="$2" new
	[ -f "$src" ] || return 1
	mkdir -p "$(dirname "$file")" 2>/dev/null
	new=$(mktemp)
	if [ -f "$file" ]; then { cat "$src"; printf '\n'; cat "$file"; } > "$new"; else cat "$src" > "$new"; fi
	cat "$new" > "$file"; rm -f "$new"
}

# _ruflo_strip_legacy_preamble FILE — one-time migration. Early kit versions shipped the
# operating-rules preamble (H1 "# Machine-wide Claude Code Reference" + Operating rules +
# coordination + routing …) as UNMANAGED text above the sentinel blocks. It now lives in
# the managed `ruflo-preamble` block. Drop that legacy leading region so it isn't
# duplicated. Surgically bounded: removes only from the top down to the first foreign
# marker — the `# Ruflo Integration` block written by `ruflo init`, or the first
# `<!-- BEGIN ruflo-` managed block — so neither is touched. Guards: no-op unless the
# file literally starts with the kit H1 (genuine user notes with a different title are
# safe) and the file isn't already migrated (idempotent).
_ruflo_strip_legacy_preamble() {
	local file="$1" new
	[ -f "$file" ] || return 0
	grep -qF '<!-- BEGIN ruflo-preamble -->' "$file" && return 0
	head -1 "$file" 2>/dev/null | grep -qF '# Machine-wide Claude Code Reference' || return 0
	new=$(mktemp)
	awk '
		BEGIN{drop=1}
		drop && (/^# Ruflo Integration \(auto-generated/ || /^<!-- BEGIN ruflo-/){drop=0}
		!drop{print}
	' "$file" > "$new"
	cat "$new" > "$file"; rm -f "$new"
}

# --- conditional-block registry --------------------------------------------
# Some CLAUDE.md sub-blocks belong in ~/.claude/CLAUDE.md only when a companion
# tool is installed (the agentic-qe fleet, the superpowers plugin, …). Rather than
# hand-code the present/absent gate for each one across install.sh, uninstall.sh,
# and ruflo-reference-refresh, every conditional block is listed here ONCE. Adding a
# tool = ship claude/<name>-reference.md and add a single row below; install, resync,
# status, and uninstall all pick it up with no further edits. See
# docs/CONDITIONAL-BLOCKS.md for the design and how to author a new block's content.
#
# Row format (pipe-separated, one block per line):
#   <slug> | <source file in claude/> | <staged template in ~/.config/ruflo/> | <detector>
# - <slug>     doubles as the sentinel name: <!-- BEGIN <slug> --> … <!-- END <slug> -->
# - <detector> is any command; exit 0 means "tool present → include the block".
# An ALWAYS-ON block uses the detector `true` (always exit 0). `ruflo-preamble` is one:
# the machine-wide operating-rules preamble, owned by the repo so it survives onboarding
# and `ruflo-reference-refresh`. The sync loop below special-cases it to lead the file
# (prepend, not append) and to supersede any legacy unmanaged preamble.
_ruflo_cond_blocks() {
	cat <<'EOF'
ruflo-preamble|ruflo-preamble.md|preamble-md-template.md|true
ruflo-aqe-reference|aqe-reference.md|aqe-md-template.md|have aqe
ruflo-superpowers-reference|superpowers-reference.md|superpowers-md-template.md|have_superpowers
EOF
}

# have_superpowers — true if the superpowers plugin is installed on disk at
# ~/.claude/plugins/cache/<marketplace>/superpowers/<version>/. This is
# presence-on-disk, mirroring how `have aqe` means "installed" (not "provably active
# this session"). `find … -quit` returns on the first match; empty output if none, and
# a missing cache dir is swallowed by 2>/dev/null. Works in both bash and zsh.
have_superpowers() {
	[ -n "$(find "$HOME/.claude/plugins/cache" -maxdepth 4 -type d -name superpowers -print -quit 2>/dev/null)" ]
}

# _ruflo_sync_cond_blocks REF CFG — reconcile every registry block against its detector:
# upsert from CFG/<staged template> when the detector passes, strip the block otherwise.
# Idempotent; prints a line only when a block is actually added or removed. No-op if REF
# is missing or the block primitives are not loaded. Shared by install.sh and ruflo-resync.
_ruflo_sync_cond_blocks() {
	local ref="$1" cfg="$2" slug src tmpl detector b e
	[ -f "$ref" ] || return 0
	command -v _ruflo_block_upsert >/dev/null 2>&1 || return 0
	_ruflo_cond_blocks | while IFS='|' read -r slug src tmpl detector; do
		[ -n "$slug" ] || continue
		b="<!-- BEGIN $slug -->"; e="<!-- END $slug -->"
		if eval "$detector" >/dev/null 2>&1; then
			[ -f "$cfg/$tmpl" ] || continue
			if ! grep -qF "$b" "$ref" 2>/dev/null; then
				if [ "$slug" = "ruflo-preamble" ]; then
					# always-on operating-rules preamble: lead the file and supersede
					# any legacy unmanaged preamble — migrate-then-prepend, don't append.
					_ruflo_strip_legacy_preamble "$ref"
					_ruflo_block_prepend "$ref" "$cfg/$tmpl"
					echo "  + $slug → added (top of file)"
					continue
				fi
				echo "  + $slug → tool present, adding block"
			fi
			_ruflo_block_upsert "$ref" "$b" "$e" "$cfg/$tmpl"
		elif grep -qF "$b" "$ref" 2>/dev/null; then
			echo "  - $slug → tool absent, stripping stale block"
			_ruflo_block_strip "$ref" "$b" "$e"
		fi
	done
}

_RUFLO_LIB=1   # sentinel: consumers check this to confirm the lib loaded
