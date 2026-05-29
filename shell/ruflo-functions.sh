# shellcheck shell=bash
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

# ---------------------------------------------------------------------------
# Daemon lifecycle (issue #3). ruflo-setup-project starts a per-workspace daemon
# (continuous self-learning). Without reaping, throwaway/removed workspaces (e.g.
# ruflo-parity-test's /tmp dirs) leave orphan daemons running forever.
#
# Shared helpers (colored output, daemon ps-parser, native better-sqlite3
# primitives) live in ruflo-lib.sh. Prefer the installed copy (~/.config/ruflo);
# fall back to the repo sibling. The sourced-file path is BASH_SOURCE[0] in bash
# and $0 in zsh (with FUNCTION_ARGZERO, the default).
_ruflo_self="${BASH_SOURCE[0]:-$0}"
for _ruflo_cand in \
	"$HOME/.config/ruflo/ruflo-lib.sh" \
	"$(dirname "$_ruflo_self")/ruflo-lib.sh"; do
	# shellcheck source=/dev/null
	[ -f "$_ruflo_cand" ] && { . "$_ruflo_cand"; break; }
done
unset _ruflo_self _ruflo_cand

# List (or, with --kill, stop) ruflo daemons whose --workspace no longer exists.
# Never touches a daemon whose workspace is still present (a live project).
#   ruflo-daemon-gc           # list orphans (dry preview)
#   ruflo-daemon-gc --kill    # stop them
ruflo-daemon-gc() {
	command -v _ruflo_daemon_list >/dev/null 2>&1 || { echo "⚠  ruflo-daemon-lib.sh not loaded — run install.sh, then re-source your shell"; return 1; }
	local do_kill=0
	[ "${1:-}" = "--kill" ] && do_kill=1
	local found=0 pid ws
	while IFS="$(printf '\t')" read -r pid ws; do
		[ -n "${pid:-}" ] || continue
		[ -d "$ws" ] && continue
		found=$((found+1))
		if [ "$do_kill" -eq 1 ]; then
			kill "$pid" 2>/dev/null && echo "✓ stopped orphan daemon pid=$pid (workspace gone: $ws)" \
				|| echo "⚠  could not stop pid=$pid (already exited?)"
		else
			echo "orphan daemon pid=$pid → $ws (workspace gone)"
		fi
	done <<EOF
$(_ruflo_daemon_list)
EOF
	if [ "$found" -eq 0 ]; then
		echo "✓ no orphan daemons (every running daemon's --workspace still exists)"
	elif [ "$do_kill" -eq 0 ]; then
		echo "Found $found orphan(s). Run 'ruflo-daemon-gc --kill' to stop them."
	fi
	return 0
}

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
	# shellcheck disable=SC2016  # single-quoted JS for node -e, not shell expansion
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
	#   🎓 Agentic QE V<version>  <patterns> [· <traj>] [· <vec>] · <size>
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
    function bar(n, max){ n = Math.max(0, Math.min(max, n)); return "[" + "●".repeat(n) + "○".repeat(max - n) + "]"; }
    // ── self-learning (SONA): own line with a volume bar + Δ LoRA (cached at train) ──
    var learn = "";
    try {
      var sp = path.join(cwd, ".claude-flow", "neural", "stats.json");
      if (fs.existsSync(sp)) {
        var s = JSON.parse(fs.readFileSync(sp, "utf8"));
        var pn = s.patternsLearned || 0, tj = s.trajectoriesRecorded || 0, parts = [];
        if (pn > 0 || tj > 0) {
          if (pn > 0) parts.push(pn + " patterns");
          if (tj > 0) parts.push(tj + " traj");
          // Δ LoRA — transient last-step metric, NOT persisted by ruflo and not derivable
          // from the lora-checkpoint (ruvector-training.js). Cached by ruflo-neural-train.
          try { var ld = JSON.parse(fs.readFileSync(path.join(cwd, ".claude-flow", "neural", "lora-delta.json"), "utf8")); if (typeof ld.deltaNorm === "number") parts.push(DIM + "Δ" + R + ld.deltaNorm.toFixed(2) + " LoRA"); } catch(e){}
          if (fs.existsSync(path.join(cwd, ".swarm", "hnsw.index"))) parts.push(G + "⚡ HNSW" + R);
          var dots = Math.max(0, Math.min(5, Math.round(pn / 10)));   // volume gauge: ~10 patterns per dot
          learn = C + "🧠 SONA" + R + "  " + DIM + bar(dots, 5) + R + "  " + parts.join(DIM + " · " + R);
        }
      }
    } catch(e){}
    // ── security (aidefence loaded in the global ruflo install) ──
    var sec = "";
    try {
      var ad = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "ruflo", "node_modules", "@claude-flow", "aidefence", "package.json");
      if (fs.existsSync(ad)) sec = G + "🛡 aidefence on" + R;
    } catch(e){}
    // ── agentic-qe — TTL-cached; one sqlite3 spawn only on a cache miss (issue #3) ──
    var qe = "";
    try {
      var db = path.join(cwd, ".agentic-qe", "memory.db");
      if (fs.existsSync(db)) {
        var cacheDir = path.join(cwd, ".claude-flow", "cache");
        var cacheFile = path.join(cacheDir, "qe-statusline.json");
        var ttl = Number(process.env.RUFLO_QE_STATUSLINE_TTL_MS || 60000);
        var cachedLine = null;
        try {
          var cc = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
          if (cc && typeof cc.line === "string" && ttl > 0 && (Date.now() - cc.ts) < ttl) cachedLine = cc.line;
        } catch(e){}
        if (cachedLine !== null) {
          qe = cachedLine;                   // hit: zero sqlite3 spawns
        } else {
          // miss: ONE sqlite3 call. SQL on stdin + ".bail off" so a missing vector
          // table (name varies by aqe version) doesn't abort the batch. sqlite3 still
          // exits non-zero on the error, so execFileSync throws — recover e.stdout.
          var sql = ".bail off\n"
            + "SELECT 'pat',COUNT(*) FROM qe_patterns;\n"
            + "SELECT 'vec',COUNT(*) FROM qe_pattern_embeddings;\n"
            + "SELECT 'vec',COUNT(*) FROM vectors;\n"
            + "SELECT 'vec',COUNT(*) FROM embeddings;\n"
            + "SELECT 'traj',COUNT(*) FROM qe_trajectories;\n";
          var raw = "";
          try { raw = cp.execFileSync("sqlite3", [db], {input: sql, stdio:["pipe","pipe","ignore"], timeout:1500}).toString(); }
          catch(e){ raw = (e && e.stdout) ? e.stdout.toString() : ""; }
          var pat = 0, qtj = 0, qv = 0;
          raw.split("\n").forEach(function(ln){
            var i = ln.indexOf("|"); if (i < 0) return;
            var k = ln.slice(0, i), v = Number(ln.slice(i + 1)) || 0;
            if (k === "pat") pat = v; else if (k === "traj") qtj = v; else if (k === "vec" && qv === 0) qv = v;
          });
          var qp = [];
          if (pat > 0) qp.push("🎓 " + pat + " patterns");
          if (qtj > 0) qp.push("🧭 " + qtj + " traj");
          if (qv > 0) qp.push("🧬 " + qv + " vec" + G + "⚡" + R);
          try { var kb = Math.round(fs.statSync(db).size / 1024); qp.push("💾 " + (kb >= 1024 ? (kb/1024).toFixed(1) + "MB" : kb + "KB")); } catch(e){}
          // Installed agentic-qe version — shown next to the label, mirroring "RuFlo V<x>"
          // in ruflo's native header. Prefer the global install (matches the aidefence
          // probe above); fall back to a project-local node_modules copy.
          var qver = "";
          try {
            var qpkg = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "agentic-qe", "package.json");
            if (!fs.existsSync(qpkg)) qpkg = path.join(cwd, "node_modules", "agentic-qe", "package.json");
            var qv2 = JSON.parse(fs.readFileSync(qpkg, "utf8")).version;
            if (qv2) qver = " V" + qv2;
          } catch(e){}
          qe = Y + "🎓 Agentic QE" + qver + R + "  " + (qp.length ? qp.join(DIM + " · " + R) : "on");
          try { fs.mkdirSync(cacheDir, {recursive:true}); fs.writeFileSync(cacheFile, JSON.stringify({ts: Date.now(), line: qe})); } catch(e){}
        }
      }
    } catch(e){}
    // ── assemble: line 1 = learning + security (ruflo features); line 2 = agentic-qe ──
    // No rule above the SONA line — SONA + aidefence are ruflo features and sit flush
    // under ruflo's native lines. The divider goes BETWEEN the ruflo block and the
    // agentic-qe line, matching ruflo's native header divider width ('─'.repeat(53) in
    // statusline.cjs) so the two rules line up.
    var l1 = []; if (learn) l1.push(learn); if (sec) l1.push(sec);
    var out = [];
    if (l1.length) out.push(l1.join("      "));
    if (out.length && qe) out.push(DIM + "─".repeat(53) + R);
    if (qe) out.push(qe);
    if (!out.length) return "";
    return "\n" + out.join("\n");
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
		if ! node --check "$sl" 2>/dev/null; then
			echo "⚠  Injected statusline failed node --check — review $sl"
		fi
	fi

	# Ensure Claude Code actually RUNS the rich statusline.cjs. `aqe init` (and
	# `ruflo init`) can repoint .claude/settings.json at a minimal statusline-v3.cjs,
	# which would hide the footer. Make statusline.cjs primary (falls back to v3, then
	# a literal). Only when patching the default project statusline.
	if [ "$sl" = ".claude/helpers/statusline.cjs" ] && [ -f ".claude/settings.json" ] && command -v python3 >/dev/null 2>&1; then
		if python3 - <<'PY' 2>/dev/null
import json, re, sys
p = ".claude/settings.json"
d = json.load(open(p))
sl = d.get("statusLine") or {}
cur = sl.get("command", "")
m = re.search(r'statusline(-v3)?\.cjs', cur)
if m and m.group(0) == 'statusline.cjs':
    sys.exit(0)  # already primary — no change
sl["type"] = "command"
sl["command"] = ('sh -c \'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/statusline.cjs" 2>/dev/null '
                 '|| node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/statusline-v3.cjs" 2>/dev/null '
                 '|| echo "▊ RuFlo + Agentic QE v3"\'')
sl.setdefault("refreshMs", 5000)
sl.setdefault("enabled", True)
d["statusLine"] = sl
json.dump(d, open(p, "w"), indent=2)
sys.exit(1)  # changed
PY
		then
			echo "✓ settings.json already runs the rich statusline.cjs"
		else
			echo "✓ Pointed settings.json statusLine at statusline.cjs (restore the rich footer)"
		fi
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
	# Idempotent daemon start: never spawn a 2nd daemon for this workspace (issue #3).
	local _ws; _ws="$(pwd -P)"
	if command -v _ruflo_daemon_list >/dev/null 2>&1 && [ -n "$(_ruflo_daemon_list | awk -F'\t' -v w="$_ws" '$2==w{print $1; exit}')" ]; then
		echo "✓ Daemon already running for this workspace (not starting another)"
	else
		ruflo daemon start >/dev/null 2>&1 && echo "✓ Daemon started" || echo "⚠  ruflo daemon start failed (may already be running)"
	fi

	# Defensive (issue #3 RC3): if upstream `ruflo init` wrote daemon.autoStart:true,
	# flip it to false so opening Claude Code does not auto-restart the daemon.
	# No-op when the file/key is absent or already false.
	if [ -f ".claude/settings.json" ] && command -v python3 >/dev/null 2>&1; then
		if python3 - <<'PY' 2>/dev/null
import json, sys
p = ".claude/settings.json"
try:
    with open(p) as f: d = json.load(f)
except Exception:
    sys.exit(0)
cf = d.get("claudeFlow")
dm = cf.get("daemon") if isinstance(cf, dict) else None
if isinstance(dm, dict) and dm.get("autoStart") is True:
    dm["autoStart"] = False
    with open(p, "w") as f: json.dump(d, f, indent=2)
    sys.exit(1)  # changed
sys.exit(0)      # no change
PY
		then
			:  # unchanged (absent/false) — stay quiet
		else
			echo "✓ Set claudeFlow.daemon.autoStart=false in .claude/settings.json (was true)"
		fi
	fi

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
	echo "Next: ruflo-learning-verify   (prove self-learning persists on disk)"
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
	command -v _ruflo_bsq3_is_native >/dev/null 2>&1 || return 0   # ruflo-lib.sh not loaded
	local aqe_root; aqe_root="$(_ruflo_global_root)/agentic-qe"
	[ -d "$aqe_root" ] || return 0
	local abi; abi="$(_ruflo_node_abi)"
	[ "${abi:-0}" -ge 137 ] 2>/dev/null || return 0
	if ! _ruflo_bsq3_is_native "$aqe_root"; then
		echo "Patching native better-sqlite3 into agentic-qe (Node ABI $abi)…"
		_ruflo_bsq3_install "$aqe_root" \
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
		local nskills; nskills="$(find .claude/skills -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
		echo "✓ agentic-qe initialized (SDK db + marker present, $nskills skills)"
		# refresh the statusline so the 🎓 segment appears
		command -v ruflo-fix-statusline-version >/dev/null 2>&1 && ruflo-fix-statusline-version >/dev/null 2>&1
		return 0
	fi
	echo "⚠  agentic-qe not fully initialized — SDK db: $([ -f "$sdk" ] && echo yes || echo no), marker: $([ -d "$marker" ] && echo yes || echo no)"
	return 1
}

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
			ruflo-setup-aqe || echo "⚠  setup-aqe reported issues — see docs/TROUBLESHOOTING.md"
		else
			echo "⚠  agentic-qe not installed — re-run:  install.sh --with-aqe   (or npm i -g agentic-qe)"
		fi
	fi

	echo ""
	echo "✓ Onboard complete for $(pwd -P)"
	echo "  After any 'npm i -g ruflo@latest' (or agentic-qe@latest), run: ruflo-resync"
}

# ---------------------------------------------------------------------------
# Run `ruflo neural train` in the CURRENT project and cache the (transient) MicroLoRA
# Delta Norm so the status-line SONA segment can display Δ<n> LoRA.
#
# Why a wrapper: deltaNorm is the magnitude of the LAST adaptation step (see
# ruvector-training.js JsMicroLoRA._deltaNorm). ruflo computes it at runtime, prints it
# in the train output, but does NOT persist it — and it cannot be recovered from the
# lora-checkpoint (which stores the accumulated A/B matrices, not the last step). So we
# capture it from the command output here and write .claude-flow/neural/lora-delta.json.
#
#   ruflo-neural-train                 # = ruflo neural train -p coordination (default)
#   ruflo-neural-train -p security -e 100   # any `ruflo neural train` args pass through
ruflo-neural-train() {
	command -v ruflo >/dev/null 2>&1 || { echo "ruflo not on PATH" >&2; return 2; }
	local out
	out="$(ruflo neural train "$@" 2>&1)"
	printf '%s\n' "$out"
	local d
	d="$(printf '%s\n' "$out" | grep -i "MicroLoRA Delta Norm" | grep -oE '[0-9]+\.[0-9]+' | head -1)"
	if [ -n "$d" ] && [ -d .claude-flow/neural ]; then
		printf '{"deltaNorm": %s, "ts": %s}\n' "$d" "$(date +%s)" > .claude-flow/neural/lora-delta.json
		echo "✓ cached Δ LoRA = $d → .claude-flow/neural/lora-delta.json (status line SONA segment will show it)"
	fi
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
# Sync the conditional agentic-qe sub-block in ~/.claude/CLAUDE.md: present iff `aqe` is
# installed (upsert from the staged template), stripped otherwise (self-healing on uninstall).
# Quiet unless the block's presence actually changes. Needs ruflo-lib.sh (_ruflo_block_*).
_ruflo_sync_aqe_block() {
	local ref="$HOME/.claude/CLAUDE.md"
	local tmpl="$HOME/.config/ruflo/aqe-md-template.md"
	local b='<!-- BEGIN ruflo-aqe-reference -->' e='<!-- END ruflo-aqe-reference -->'
	command -v _ruflo_block_upsert >/dev/null 2>&1 || return 0
	[ -f "$ref" ] || return 0
	if command -v aqe >/dev/null 2>&1; then
		[ -f "$tmpl" ] || return 0
		grep -qF "$b" "$ref" || echo "  + agentic-qe present → adding ruflo-aqe-reference block to $ref"
		_ruflo_block_upsert "$ref" "$b" "$e" "$tmpl"
	elif grep -qF "$b" "$ref" 2>/dev/null; then
		echo "  - agentic-qe absent → stripping stale ruflo-aqe-reference block from $ref"
		_ruflo_block_strip "$ref" "$b" "$e"
	fi
}

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

	echo ""; echo "## machine-wide ~/.claude/CLAUDE.md: conditional agentic-qe reference block"
	_ruflo_sync_aqe_block && echo "✓ ruflo-aqe-reference block in sync with agentic-qe install state"

	if [ "$do_aqe" -eq 1 ]; then
		echo ""; echo "## 4/4 refresh agentic-qe skills (--aqe)"
		if [ -f .agentic-qe/memory.db ]; then
			ruflo-setup-aqe --force
		else
			echo "   (no .agentic-qe in this repo — run 'ruflo-setup-aqe' to initialize)"
		fi
	fi
	echo ""; echo "✓ resync complete"
	echo ""
	echo "Next: cd <your-repo> && ruflo-onboard   (per-project setup + verify)"
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
			--sync-aqe) mode="sync-aqe" ;;
			-y|--yes) yes=1 ;;
			-h|--help) echo "Usage: ruflo-reference-refresh [--diff|--regenerate [-y]|--sync-aqe]"; return 0 ;;
			*) echo "Unknown flag: $1"; return 2 ;;
		esac
		shift
	done
	# --sync-aqe only touches the conditional agentic-qe block; no ruflo template needed.
	if [ "$mode" = "sync-aqe" ]; then _ruflo_sync_aqe_block; return 0; fi
	if [ ! -f "$template" ]; then
		echo "No template at $template (run install.sh, or extract from $ref)."
		return 1
	fi
	local aqe_begin='<!-- BEGIN ruflo-aqe-reference -->'
	case "$mode" in
		status)
			echo "ruflo: $(ruflo --version 2>/dev/null || echo 'not installed')"
			echo "installed sentinel: $(grep -E 'ruflo-version' "$ref" 2>/dev/null || echo 'none')"
			echo "template  sentinel: $(grep -E 'ruflo-version' "$template" 2>/dev/null || echo 'none')"
			if command -v aqe >/dev/null 2>&1; then
				grep -qF "$aqe_begin" "$ref" 2>/dev/null && echo "agentic-qe: installed — aqe block present" || echo "agentic-qe: installed — aqe block MISSING (run --sync-aqe)"
			else
				grep -qF "$aqe_begin" "$ref" 2>/dev/null && echo "agentic-qe: absent — aqe block STALE (run --sync-aqe to strip)" || echo "agentic-qe: absent — aqe block correctly absent"
			fi
			echo "Use --diff to compare, --regenerate to rebuild, --sync-aqe to fix the agentic-qe block."
			;;
		diff)
			local blk; blk=$(mktemp)
			awk '/<!-- BEGIN ruflo-reference -->/,/<!-- END ruflo-reference -->/' "$ref" > "$blk" 2>/dev/null
			if diff -u "$blk" "$template" >/dev/null 2>&1; then echo "✓ identical"; else diff -u "$blk" "$template" | head -200; fi
			rm -f "$blk"
			;;
		regenerate)
			if [ ! -f "$ref" ]; then cp "$template" "$ref"; echo "✓ Installed reference at $ref"; _ruflo_sync_aqe_block; return 0; fi
			local pre post new
			pre=$(mktemp); post=$(mktemp); new=$(mktemp)
			awk '/<!-- BEGIN ruflo-reference -->/{exit} {print}' "$ref" > "$pre"
			awk 'f; /<!-- END ruflo-reference -->/{f=1}' "$ref" > "$post"
			cat "$pre" "$template" "$post" > "$new"
			if diff -q "$ref" "$new" >/dev/null 2>&1; then echo "✓ Already up-to-date."; rm -f "$pre" "$post" "$new"; _ruflo_sync_aqe_block; return 0; fi
			diff -u "$ref" "$new" | head -80
			if [ "$yes" -eq 0 ]; then
				printf "Apply this regeneration? [y/N] "; local r; read -r r
				case "$r" in y|Y) ;; *) echo "Aborted."; rm -f "$pre" "$post" "$new"; return 1 ;; esac
			fi
			cp "$ref" "$ref.bak.$(date +%Y%m%d-%H%M%S)"
			mv "$new" "$ref"; rm -f "$pre" "$post"
			echo "✓ Regenerated $ref (backup saved)"
			_ruflo_sync_aqe_block
			;;
	esac
}
