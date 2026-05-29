# ruflo-functions.sh — portable shell helpers for a clean, correct ruflo setup.
#
# Source this from your interactive shell rc:
#   echo 'source "$HOME/.config/ruflo/ruflo-functions.sh"' >> ~/.zshrc   # or ~/.bashrc
#
# Compatible with bash 4+ and zsh. Requires: ruflo, node, npm, claude (Claude
# Code CLI), python3, and sqlite3 on PATH. The companion scripts
# `ruflo-patch-native` and `ruflo-parity-test` should be on PATH too (install.sh
# places them in ~/.local/bin).
#
# Provided commands:
#   ruflo-setup-machine      one-time per machine: register ruflo MCP at user scope
#   ruflo-setup-project      per repo: init + sanitize + activate + verify (recommended)
#   ruflo-patch / -native    make ruflo use native better-sqlite3 on Node >= 24
#   ruflo-remove-mcp         remove ruflo MCP from all scopes (recover ~84k tokens/session)
#   ruflo-memory-checkpoint  force a WAL checkpoint to recover stale memory reads
#   ruflo-reference-refresh  inspect/regenerate the machine-wide CLAUDE.md ruflo block

# ---------------------------------------------------------------------------
# One-time per machine: register ruflo MCP at user scope (all projects).
# Skip this entirely if you prefer CLI-only (saves ~84k tokens/session; the
# machine-wide ~/.claude/CLAUDE.md reference makes the MCP optional).
alias ruflo-setup-machine='claude mcp add ruflo -s user -- ruflo mcp start'

# Reminder alias for the native-SQLite patch (the real work is the PATH binary).
alias ruflo-patch='ruflo-patch-native'

# ---------------------------------------------------------------------------
# Force-checkpoint the ruflo memory WAL into the main DB. Use when:
#   - `ruflo memory store` reports success but reads return 0, AND
#   - native sqlite3 shows rows but ruflo (sql.js/WASM) doesn't (uncheckpointed WAL)
# Default DB: $(pwd)/.swarm/memory.db ; override with first arg.
ruflo-memory-checkpoint() {
	local db="${1:-$PWD/.swarm/memory.db}"
	if [ ! -f "$db" ]; then
		echo "No memory DB at $db" >&2
		return 1
	fi
	if ! command -v sqlite3 >/dev/null 2>&1; then
		echo "sqlite3 not found — install it (e.g. 'brew install sqlite') to checkpoint" >&2
		return 1
	fi
	sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" && echo "✓ Checkpointed $db"
}

# ---------------------------------------------------------------------------
# Remove ruflo MCP from all scopes (user, local for this project, project).
# Idempotent; silently skips scopes where ruflo isn't registered.
ruflo-remove-mcp() {
	local s removed=0
	for s in user local project; do
		if claude mcp remove ruflo -s "$s" >/dev/null 2>&1; then
			echo "✓ Removed ruflo from $s scope"
			removed=1
		fi
	done
	[ "$removed" -eq 0 ] && echo "ruflo MCP not registered in any scope for this project."
	return 0
}

# ---------------------------------------------------------------------------
# Per project: ruflo init, then sanitize and correctly activate everything.
#   - strips .mcp.json (avoids committing ruv-swarm/flow-nexus into the repo)
#   - strips the per-project (local-scope) ruflo MCP entry that init injects
#   - ensures native better-sqlite3 on Node >= 24 (ruflo-patch-native)
#   - pins an ABSOLUTE CLAUDE_FLOW_DB_PATH in .claude/settings.local.json
#     (Claude Code does NOT expand ${CLAUDE_PROJECT_DIR}; a literal silently
#      breaks ruflo's WASM writes)
#   - explicitly runs memory init / swarm init / daemon start AFTER pinning the
#     DB path (ruflo init alone does NOT create the memory DB)
#   - WAL-checkpoints and self-verifies that a store lands an on-disk row
#   - rewrites generated CLAUDE.md to use `ruflo` not `npx @claude-flow/cli@latest`
# Usage:
#   ruflo-setup-project            # --full scaffold + full activation (recommended)
#   ruflo-setup-project --minimal  # smaller agent/skill footprint (still activated)

# Heal the statusline so it shows the LIVE ruflo version instead of the stale
# hard-coded '3.6' fallback. Upstream ruflo — through the #2195 "delegation
# build" shipped in the latest releases (v3.10.5 at time of writing) — still
# resolves the version from a LOCAL-ONLY package.json probe list that never
# checks a GLOBAL npm install. So `ruflo init` and `ruflo init upgrade` keep
# regenerating a statusline.cjs that prints "RuFlo V3.6" even though
# `ruflo --version` is correct. We patch the freshly generated file:
#   (a) inject the global node_modules path (derived from the node binary that
#       runs the statusline) as the FIRST probe candidate — stays live-correct
#       across future upgrades, and
#   (b) refresh the hard-coded fallback default to the installed version.
# Idempotent (guarded by a marker) and re-applied on every setup, so each new
# ruflo release self-heals. Optional arg 1 overrides the statusline path.
ruflo-fix-statusline-version() {
	local sl="${1:-.claude/helpers/statusline.cjs}"
	[ -f "$sl" ] || sl="$HOME/.claude/helpers/statusline.cjs"
	if [ ! -f "$sl" ]; then
		echo "⚠  No statusline.cjs found to patch (skipping version fix)"
		return 0
	fi
	local live_ver
	live_ver="$(ruflo --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
	if [ -z "$live_ver" ]; then
		echo "⚠  Could not determine ruflo version (skipping statusline version fix)"
		return 0
	fi
	if ! SL="$sl" LIVE_VER="$live_ver" node -e '
const fs=require("fs"); const f=process.env.SL; let s=fs.readFileSync(f,"utf8");
const marker="/* ruflo-machine-ref: global-install version probe */";
if(!s.includes(marker)){
  s=s.replace(/const pkgPaths = \[/,
    `const pkgPaths = [ ${marker} require("path").join(require("path").dirname(process.execPath),"..","lib","node_modules","ruflo","package.json"),`);
}
s=s.replace(/(let (?:ver|pkgVersion) = )(["\x27])\d+\.\d+(?:\.\d+)?\2/, `$1$2${process.env.LIVE_VER}$2`);
fs.writeFileSync(f,s);
'; then
		echo "⚠  Statusline version patch failed (left as-is)"
		return 1
	fi

	# Activation footer: append (below ruflo's native render) a two-line footer that
	# shows ONLY the features genuinely active in this project:
	#   🧠 SONA  <patterns> · <traj> [· ⚡ HNSW]        🛡 aidefence on
	#   🎓 Agentic QE  <patterns> [· <traj>] [· <vec>] · <size>
	# Append-only: never rewrites ruflo's own lines, so it can't break on a ruflo
	# template change. self-learning + security are fs-only; the agentic-qe line uses
	# one guarded sqlite3 call only when .agentic-qe/memory.db exists. The injector is
	# UPGRADE-SAFE: it strips any prior block (legacy or BEGIN/END) and re-injects, so
	# re-running after a ruflo/agentic-qe upgrade always lands the current helper.
	local _seg_tmp; _seg_tmp=$(mktemp)
	cat > "$_seg_tmp" <<'RUFLO_SEG_EOF'
/* ruflo-seg:BEGIN */
function rufloActivationSegments(cwd){
  try {
    var fs = require("fs"), path = require("path"), cp = require("child_process");
    var DIM = "[2m", G = "[1;32m", Y = "[1;33m", C = "[1;36m", R = "[0m";
    // execFileSync (no shell) — db path / sql are passed as argv, never interpolated into a command line.
    function q(db, sql){ try { return cp.execFileSync("sqlite3", [db, sql], {stdio:["ignore","pipe","ignore"], timeout:1500}).toString().trim(); } catch(e){ return ""; } }
    // ── self-learning (SONA) ──
    var learn = "";
    try {
      var sp = path.join(cwd, ".claude-flow", "neural", "stats.json");
      if (fs.existsSync(sp)) {
        var s = JSON.parse(fs.readFileSync(sp, "utf8"));
        var pn = s.patternsLearned || 0, tj = s.trajectoriesRecorded || 0, parts = [];
        if (pn > 0) parts.push(pn + " patterns");
        if (tj > 0) parts.push(tj + " traj");
        if (fs.existsSync(path.join(cwd, ".swarm", "hnsw.index"))) parts.push(G + "⚡ HNSW" + R);
        if (parts.length) learn = C + "🧠 SONA" + R + "  " + parts.join(DIM + " · " + R);
      }
    } catch(e){}
    // ── security (aidefence loaded in the global ruflo install) ──
    var sec = "";
    try {
      var ad = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "ruflo", "node_modules", "@claude-flow", "aidefence", "package.json");
      if (fs.existsSync(ad)) sec = G + "🛡 aidefence on" + R;
    } catch(e){}
    // ── agentic-qe (one guarded sqlite3 read) ──
    var qe = "";
    try {
      var db = path.join(cwd, ".agentic-qe", "memory.db");
      if (fs.existsSync(db)) {
        var qp = [];
        var pat = q(db, "SELECT COUNT(*) FROM qe_patterns");
        if (pat && Number(pat) > 0) qp.push(pat + " patterns");
        var qtj = q(db, "SELECT COUNT(*) FROM qe_trajectories");
        if (qtj && Number(qtj) > 0) qp.push(qtj + " traj");
        var qv = q(db, "SELECT COUNT(*) FROM vectors");
        if (qv && Number(qv) > 0) qp.push(qv + " vec");
        try { var kb = Math.round(fs.statSync(db).size / 1024); qp.push(kb >= 1024 ? (kb/1024).toFixed(1) + "MB" : kb + "KB"); } catch(e){}
        qe = Y + "🎓 Agentic QE" + R + "  " + (qp.length ? qp.join(DIM + " · " + R) : "on");
      }
    } catch(e){}
    // ── assemble: line 1 = learning + security; line 2 = agentic-qe ──
    var l1 = []; if (learn) l1.push(learn); if (sec) l1.push(sec);
    var out = [];
    if (l1.length) out.push(l1.join("      "));
    if (qe) out.push(qe);
    if (!out.length) return "";
    return "\n" + DIM + "─".repeat(44) + R + "\n" + out.join("\n");
  } catch(e){ return ""; }
}
/* ruflo-seg:END */
RUFLO_SEG_EOF
	if ! SL="$sl" SEG="$_seg_tmp" node -e '
const fs=require("fs"); const f=process.env.SL; let s=fs.readFileSync(f,"utf8");
const helper=fs.readFileSync(process.env.SEG,"utf8").trim();
// Strip any prior block: new BEGIN/END, and the legacy marker+function form.
s=s.replace(/\/\* ruflo-seg:BEGIN \*\/[\s\S]*?\/\* ruflo-seg:END \*\/\n?/,"");
s=s.replace(/\/\* ruflo-machine-ref: activation segments \*\/\s*\nfunction rufloActivationSegments\(cwd\)\{[\s\S]*?\n\}\n/,"");
// Strip any prior console.log wrap so we can re-add cleanly.
s=s.replace(/ \+ rufloActivationSegments\(process\.cwd\(\)\)/g,"");
// Re-inject helper after the shebang (keep shebang on line 1).
const lines=s.split("\n");
const at=lines[0].startsWith("#!")?1:0;
lines.splice(at,0,helper);
s=lines.join("\n");
// Wrap the final render.
s=s.replace(/console\.log\(generateStatusline\(\)\)/,"console.log(generateStatusline() + rufloActivationSegments(process.cwd()))");
fs.writeFileSync(f,s);
'; then
		rm -f "$_seg_tmp"
		echo "⚠  Statusline activation-footer patch failed (left as-is)"
	else
		rm -f "$_seg_tmp"
		echo "✓ Statusline activation footer present (🧠 SONA / 🛡 aidefence / 🎓 Agentic QE)"
	fi

	local shown
	shown="$(printf '{}' | node "$sl" 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' \
		| grep -oE 'RuFlo V[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 | sed 's/RuFlo V//')"
	if [ "$shown" = "$live_ver" ]; then
		echo "✓ Statusline version pinned to ruflo v$live_ver"
	else
		echo "⚠  Statusline shows V${shown:-?} but ruflo is v$live_ver — review $sl"
	fi
}

ruflo-setup-project() {
	local with_security=0 extra_args="" a
	for a in "$@"; do
		case "$a" in
			--with-security) with_security=1 ;;
			*) extra_args="$extra_args $a" ;;
		esac
	done
	[ -z "${extra_args// }" ] && extra_args="--full"
	# shellcheck disable=SC2086
	ruflo init $extra_args --force || return $?

	# Native better-sqlite3 on modern Node (no-op on Node <= 22, idempotent).
	if command -v ruflo-patch-native >/dev/null 2>&1; then
		ruflo-patch-native >/dev/null 2>&1 || true
	fi

	# Heal the statusline version that `ruflo init` just regenerated (upstream
	# still hard-codes a '3.6' fallback and never finds a global install).
	ruflo-fix-statusline-version

	# No committed MCP pollution; no leftover local-scope MCP registration.
	rm -f .mcp.json
	claude mcp remove ruflo -s local >/dev/null 2>&1 || true

	# Pin an absolute DB path (see note above re: ${CLAUDE_PROJECT_DIR}).
	mkdir -p .claude
	local settings_file=".claude/settings.local.json"
	local resolved_db_path
	resolved_db_path="$(pwd -P)/.swarm/memory.db"
	if [ ! -f "$settings_file" ]; then
		printf '%s\n' '{' '  "env": {' \
			"    \"CLAUDE_FLOW_DB_PATH\": \"$resolved_db_path\"" \
			'  }' '}' > "$settings_file"
		echo "✓ Wrote $settings_file pinning CLAUDE_FLOW_DB_PATH=$resolved_db_path"
	else
		if RUFLO_DB_PATH="$resolved_db_path" python3 -c "
import json, os
p = '$settings_file'
with open(p) as f: d = json.load(f)
d.setdefault('env', {})
prev = d['env'].get('CLAUDE_FLOW_DB_PATH')
d['env']['CLAUDE_FLOW_DB_PATH'] = os.environ['RUFLO_DB_PATH']
with open(p, 'w') as f: json.dump(d, f, indent=2)
import sys; sys.exit(0 if prev == os.environ['RUFLO_DB_PATH'] else 1)
" 2>/dev/null; then
			echo "✓ CLAUDE_FLOW_DB_PATH already pinned correctly in $settings_file"
		elif [ "$?" -eq 1 ]; then
			echo "✓ Updated CLAUDE_FLOW_DB_PATH in $settings_file → $resolved_db_path"
		else
			cp "$settings_file" "$settings_file.bak"
			echo "⚠  Could not auto-merge — backed up to $settings_file.bak; add manually:"
			echo "    \"env\": { \"CLAUDE_FLOW_DB_PATH\": \"$resolved_db_path\" }"
		fi
	fi

	# Activate subsystems explicitly, with the DB path exported.
	export CLAUDE_FLOW_DB_PATH="$resolved_db_path"
	if ruflo memory init >/dev/null 2>&1; then
		echo "✓ Memory DB initialized at $resolved_db_path"
	else
		echo "⚠  ruflo memory init failed — memory writes may not persist"
	fi
	ruflo swarm init --v3-mode >/dev/null 2>&1 && echo "✓ Swarm initialized (v3-mode)" || echo "⚠  ruflo swarm init failed"
	ruflo daemon start >/dev/null 2>&1 && echo "✓ Daemon started" || echo "⚠  ruflo daemon start failed (may already be running)"

	# WAL checkpoint so the sql.js reader (if used) sees a consistent snapshot.
	if [ -f .swarm/memory.db ] && [ -f .swarm/memory.db-wal ] && command -v sqlite3 >/dev/null 2>&1; then
		sqlite3 .swarm/memory.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 \
			&& echo "✓ Checkpointed .swarm/memory.db WAL into main DB"
	fi

	# Self-verify a store actually persists; clean the probe via native sqlite3
	# (ruflo memory delete reports success but doesn't remove on-disk rows).
	local _probe_key="_setup/verify-$$"
	if ruflo memory store -k "$_probe_key" --value "setup-verify" -n _setup >/dev/null 2>&1 \
		&& [ "$(sqlite3 "$resolved_db_path" "SELECT COUNT(*) FROM memory_entries WHERE key='$_probe_key';" 2>/dev/null)" = "1" ]; then
		echo "✓ Memory write verified (store → on-disk row confirmed)"
		command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$resolved_db_path" \
			"DELETE FROM memory_entries WHERE key='$_probe_key'; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
	else
		echo "⚠  Memory write verification FAILED — store did not persist to $resolved_db_path"
		echo "   Run 'ruflo doctor -c memory' and 'ruflo-patch-native' to investigate."
	fi

	# Sanitize generated CLAUDE.md (legacy npx -> ruflo; drop legacy mcp-add line).
	if [ -f CLAUDE.md ]; then
		if sed --version >/dev/null 2>&1; then
			sed -i 's|npx @claude-flow/cli@latest|ruflo|g' CLAUDE.md
			sed -i '/claude mcp add claude-flow/d' CLAUDE.md
		else
			sed -i '' 's|npx @claude-flow/cli@latest|ruflo|g' CLAUDE.md
			sed -i '' '/claude mcp add claude-flow/d' CLAUDE.md
		fi
		if ! grep -q 'machine-wide ruflo reference' CLAUDE.md; then
			local tmp; tmp=$(mktemp)
			{ echo "<!-- Full ruflo CLI reference: see machine-wide ruflo reference at ~/.claude/CLAUDE.md -->"; echo ""; cat CLAUDE.md; } > "$tmp"
			mv "$tmp" CLAUDE.md
		fi
	fi

	# Optional security pass (--with-security): verify the built-in security surface.
	if [ "$with_security" -eq 1 ]; then
		echo "## Security pass (--with-security)"
		if command -v ruflo-security-verify >/dev/null 2>&1; then
			ruflo-security-verify --quick || echo "⚠  security verification reported issues"
		else
			echo "⚠  --with-security requested but ruflo-security-verify not on PATH (run install.sh)"
		fi
	fi

	ruflo doctor
}

# ---------------------------------------------------------------------------
# Opt-in: initialize agentic-qe (a SEPARATE package) in the current repo, with
# native-SQLite repair + half-init repair. NOT called by ruflo-setup-project.
#
# Two bugs handled:
#   1. agentic-qe depends on better-sqlite3@^12 directly; on Node >= 24 its prebuilt
#      .node is missing (native:false) → `aqe init` fails at "Initialize persistence
#      database". We install the native binary into the global agentic-qe first.
#      (Same root cause as ruflo-patch-native, different package.)
#   2. Half-init: `.agentic-qe/memory.db` exists but the project marker
#      `.claude/skills/agentic-quality-engineering` is missing → re-run with --upgrade.
#
# Ensure a globally-installed agentic-qe has a native better-sqlite3 (Node >= 24).
# Same root cause as ruflo-patch-native, different package. Idempotent; no-op on
# Node <= 22 or when no global agentic-qe is present. Shared by ruflo-setup-aqe and
# ruflo-resync so an agentic-qe upgrade is one command away from healed.
_ruflo_aqe_ensure_native() {
	command -v aqe >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || return 0
	local aqe_root; aqe_root="$(npm root -g)/agentic-qe"
	[ -d "$aqe_root" ] || return 0
	local abi; abi="$(node -e 'process.stdout.write(process.versions.modules)')"
	[ "${abi:-0}" -ge 137 ] 2>/dev/null || return 0
	if ! node -e "const b='$aqe_root/node_modules/better-sqlite3';process.exit(require('fs').existsSync(b+'/build/Release/better_sqlite3.node')?0:1)" 2>/dev/null; then
		echo "Patching native better-sqlite3 into agentic-qe (Node ABI $abi)…"
		( cd "$aqe_root" && npm install better-sqlite3@^12 --no-save --no-audit --no-fund >/dev/null 2>&1 ) \
			&& echo "✓ agentic-qe better-sqlite3 is native" \
			|| echo "⚠  could not patch agentic-qe better-sqlite3 — aqe init may fail"
	fi
}

#   ruflo-setup-aqe            # init (or repair) agentic-qe in this repo
#   ruflo-setup-aqe --force    # force reinitialize (--upgrade)
ruflo-setup-aqe() {
	local force=0
	[ "${1:-}" = "--force" ] && force=1

	_ruflo_aqe_ensure_native

	local AQE
	if command -v aqe >/dev/null 2>&1; then AQE="aqe"; else AQE="npx -y agentic-qe@latest"; fi
	local sdk=".agentic-qe/memory.db"
	local marker=".claude/skills/agentic-quality-engineering"

	if [ "$force" -eq 0 ] && [ -f "$sdk" ] && [ -d "$marker" ]; then
		echo "✓ agentic-qe already initialized (SDK db + project marker present)"
		return 0
	fi

	if [ "$force" -eq 1 ] || { [ -f "$sdk" ] && [ ! -d "$marker" ]; }; then
		[ -f "$sdk" ] && [ ! -d "$marker" ] && echo "⚠  Detected agentic-qe half-init (SDK db present, marker missing) — repairing…"
		# shellcheck disable=SC2086
		$AQE init --auto --upgrade || { echo "⚠  aqe init --upgrade failed"; return 1; }
	else
		# shellcheck disable=SC2086
		$AQE init --auto || { echo "⚠  aqe init failed"; return 1; }
	fi

	if [ -f "$sdk" ] && [ -d "$marker" ]; then
		local nskills; nskills="$(ls .claude/skills/ 2>/dev/null | wc -l | tr -d ' ')"
		echo "✓ agentic-qe initialized (SDK db + marker present, $nskills skills)"
		# refresh the statusline so the 🎓 segment appears
		command -v ruflo-fix-statusline-version >/dev/null 2>&1 && ruflo-fix-statusline-version >/dev/null 2>&1
		return 0
	fi
	echo "⚠  agentic-qe not fully initialized — SDK db: $([ -f "$sdk" ] && echo yes || echo no), marker: $([ -d "$marker" ] && echo yes || echo no)"
	return 1
}

# ---------------------------------------------------------------------------
# ONE command to re-apply everything that a ruflo / agentic-qe upgrade wipes.
# `npm install -g ruflo@latest` (or agentic-qe@latest) re-resolves dependency pins,
# drops the native better-sqlite3 binaries, and regenerates the statusline — so the
# self-learning stack goes dormant and the activation footer disappears. Run this
# from a project root after ANY such upgrade and you are healed in one step:
#
#   1. ruflo-enable-learning   → native bsq3 for ruflo's agentdb + assert 5/5 active
#   2. agentic-qe native repair → native bsq3 for the global agentic-qe (if present)
#   3. statusline re-patch      → version pin + activation footer for THIS project
#   4. --aqe (opt-in)           → re-run aqe init --auto --upgrade to refresh QE skills
#
#   ruflo-resync           # re-apply learning + statusline (recommended after upgrade)
#   ruflo-resync --aqe     # also refresh agentic-qe skills in this repo
ruflo-resync() {
	local do_aqe=0
	[ "${1:-}" = "--aqe" ] && do_aqe=1

	echo "## 1/4 self-learning (ruflo agentdb native + assert)"
	if command -v ruflo-enable-learning >/dev/null 2>&1; then
		ruflo-enable-learning || echo "⚠  self-learning not fully active — see docs/TROUBLESHOOTING.md"
	else
		echo "⚠  ruflo-enable-learning not on PATH (run install.sh)"
	fi

	echo ""; echo "## 2/4 agentic-qe native better-sqlite3 (if installed)"
	_ruflo_aqe_ensure_native

	echo ""; echo "## 3/4 statusline (version + activation footer) for this project"
	ruflo-fix-statusline-version

	if [ "$do_aqe" -eq 1 ]; then
		echo ""; echo "## 4/4 refresh agentic-qe skills (--aqe)"
		if [ -f .agentic-qe/memory.db ]; then
			ruflo-setup-aqe --force
		else
			echo "   (no .agentic-qe in this repo — run 'ruflo-setup-aqe' to initialize)"
		fi
	fi
	echo ""; echo "✓ resync complete"
}

# ---------------------------------------------------------------------------
# Inspect / regenerate the machine-wide CLAUDE.md ruflo block from the template
# at ~/.config/ruflo/claude-md-template.md.
#   ruflo-reference-refresh              status (versions + sentinel)
#   ruflo-reference-refresh --diff       show drift vs template
#   ruflo-reference-refresh --regenerate replace managed block (preserves content
#                                        outside the BEGIN/END sentinels)
#   ruflo-reference-refresh --regenerate -y   skip the y/n prompt
ruflo-reference-refresh() {
	local ref="$HOME/.claude/CLAUDE.md"
	local template="$HOME/.config/ruflo/claude-md-template.md"
	local mode="status" yes=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--diff) mode="diff" ;;
			--regenerate) mode="regenerate" ;;
			-y|--yes) yes=1 ;;
			-h|--help) echo "Usage: ruflo-reference-refresh [--diff|--regenerate [-y]]"; return 0 ;;
			*) echo "Unknown flag: $1"; return 2 ;;
		esac
		shift
	done
	if [ ! -f "$template" ]; then
		echo "No template at $template (run install.sh, or extract from $ref)."
		return 1
	fi
	case "$mode" in
		status)
			echo "ruflo: $(ruflo --version 2>/dev/null || echo 'not installed')"
			echo "installed sentinel: $(grep -E 'ruflo-version' "$ref" 2>/dev/null || echo 'none')"
			echo "template  sentinel: $(grep -E 'ruflo-version' "$template" 2>/dev/null || echo 'none')"
			echo "Use --diff to compare, --regenerate to rebuild."
			;;
		diff)
			local blk; blk=$(mktemp)
			awk '/<!-- BEGIN ruflo-reference -->/,/<!-- END ruflo-reference -->/' "$ref" > "$blk" 2>/dev/null
			if diff -u "$blk" "$template" >/dev/null 2>&1; then echo "✓ identical"; else diff -u "$blk" "$template" | head -200; fi
			rm -f "$blk"
			;;
		regenerate)
			if [ ! -f "$ref" ]; then cp "$template" "$ref"; echo "✓ Installed reference at $ref"; return 0; fi
			local pre post new
			pre=$(mktemp); post=$(mktemp); new=$(mktemp)
			awk '/<!-- BEGIN ruflo-reference -->/{exit} {print}' "$ref" > "$pre"
			awk 'f; /<!-- END ruflo-reference -->/{f=1}' "$ref" > "$post"
			cat "$pre" "$template" "$post" > "$new"
			if diff -q "$ref" "$new" >/dev/null 2>&1; then echo "✓ Already up-to-date."; rm -f "$pre" "$post" "$new"; return 0; fi
			diff -u "$ref" "$new" | head -80
			if [ "$yes" -eq 0 ]; then
				printf "Apply this regeneration? [y/N] "; local r; read -r r
				case "$r" in y|Y) ;; *) echo "Aborted."; rm -f "$pre" "$post" "$new"; return 1 ;; esac
			fi
			cp "$ref" "$ref.bak.$(date +%Y%m%d-%H%M%S)"
			mv "$new" "$ref"; rm -f "$pre" "$post"
			echo "✓ Regenerated $ref (backup saved)"
			;;
	esac
}
