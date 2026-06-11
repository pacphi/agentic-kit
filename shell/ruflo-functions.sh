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
# Daemon lifecycle (issue #3 + token-burn incident). The daemon is now OPT-IN:
# ruflo-setup-project does NOT auto-start one. If you start a daemon yourself,
# ruflo-daemon-gc and the interactive-shell auto-reaper stop it once it is orphaned
# (workspace deleted) or exceeds RUFLO_DAEMON_TTL_SECS (default 12h) — so a started-
# and-forgotten daemon can no longer spawn worker sessions 24/7 for weeks.
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

# List (or, with --kill, stop) STALE ruflo daemons. A daemon is stale if EITHER
# its --workspace was deleted (an orphan) OR it has been running longer than the
# TTL (RUFLO_DAEMON_TTL_SECS, default 12h). Rationale: the kit auto-started one
# permanent daemon per onboarded project and nothing ever stopped them, so six
# projects leaked six immortal daemons spawning worker sessions 24/7 for weeks
# (the token-burn incident). A wall-clock TTL is a robust "you're not actively
# working this one project for 12h straight" proxy; orphan-only reaping (the old
# behaviour) missed every one because the projects still existed.
#   ruflo-daemon-gc              # dry preview of stale daemons
#   ruflo-daemon-gc --kill       # stop them
#   RUFLO_DAEMON_TTL_SECS=0 ...  # disable the age rule (orphan-only, legacy)
ruflo-daemon-gc() {
	command -v _ruflo_daemon_list >/dev/null 2>&1 || { echo "⚠  ruflo-daemon-lib.sh not loaded — run install.sh, then re-source your shell"; return 1; }
	local do_kill=0
	[ "${1:-}" = "--kill" ] && do_kill=1
	local ttl="${RUFLO_DAEMON_TTL_SECS:-43200}"
	local found=0 live=0 pid ws age reason
	while IFS="$(printf '\t')" read -r pid ws; do
		[ -n "${pid:-}" ] || continue
		age=$(_ruflo_daemon_age_secs "$pid")
		reason=""
		if [ ! -d "$ws" ]; then
			reason="workspace gone"
		elif [ "$ttl" -gt 0 ] && [ "${age:-0}" -gt "$ttl" ]; then
			reason="age ${age}s > ttl ${ttl}s"
		else
			live=$((live+1)); continue
		fi
		found=$((found+1))
		if [ "$do_kill" -eq 1 ]; then
			kill "$pid" 2>/dev/null && echo "✓ stopped stale daemon pid=$pid ($reason): $ws" \
				|| echo "⚠  could not stop pid=$pid (already exited?)"
		else
			echo "stale daemon pid=$pid → $ws ($reason)"
		fi
	done <<EOF
$(_ruflo_daemon_list)
EOF
	if [ "$found" -eq 0 ]; then
		echo "✓ no stale daemons ($live live within TTL ${ttl}s)"
	elif [ "$do_kill" -eq 0 ]; then
		echo "Found $found stale daemon(s). Run 'ruflo-daemon-gc --kill' to stop them."
	fi
	return 0
}

# Auto-reap stale daemons on interactive shell start, and surface any that remain.
# This is the safety net behind the opt-in policy (daemons are no longer auto-started
# by ruflo-setup-project): even if one gets started and forgotten, it is reaped once it
# exceeds the TTL. Interactive-only (never kills/prints from scripts or subshells).
# Throttled to once per RUFLO_DAEMON_AUTOREAP_THROTTLE secs (default 300) via a stamp,
# so a burst of new terminals does one ps scan, not N. Opt out: RUFLO_DAEMON_AUTOREAP=0.
_ruflo_daemon_autoreap() {
	[ "${RUFLO_DAEMON_AUTOREAP:-1}" = "0" ] && return 0
	case "$-" in *i*) ;; *) return 0 ;; esac            # interactive shells only
	command -v _ruflo_daemon_list >/dev/null 2>&1 || return 0
	local stamp="${TMPDIR:-/tmp}/.ruflo-autoreap.stamp"
	local throttle="${RUFLO_DAEMON_AUTOREAP_THROTTLE:-300}"
	local now; now=$(date +%s 2>/dev/null) || return 0
	if [ -f "$stamp" ]; then
		local last; last=$(cat "$stamp" 2>/dev/null || echo 0)
		[ $((now - ${last:-0})) -lt "$throttle" ] && return 0
	fi
	printf '%s' "$now" > "$stamp" 2>/dev/null
	local ttl="${RUFLO_DAEMON_TTL_SECS:-43200}"
	local killed=0 remain=0 pid ws age
	while IFS="$(printf '\t')" read -r pid ws; do
		[ -n "${pid:-}" ] || continue
		age=$(_ruflo_daemon_age_secs "$pid")
		if [ ! -d "$ws" ] || { [ "$ttl" -gt 0 ] && [ "${age:-0}" -gt "$ttl" ]; }; then
			if kill "$pid" 2>/dev/null; then
				killed=$((killed+1))
				printf '🧹 reaped stale ruflo daemon pid=%s (%s)\n' "$pid" \
					"$( [ -d "$ws" ] && echo "age ${age}s>ttl" || echo "workspace gone" )" >&2
			fi
		else
			remain=$((remain+1))
		fi
	done <<EOF
$(_ruflo_daemon_list)
EOF
	[ "$remain" -gt 0 ] && printf 'ℹ  %s ruflo daemon(s) running (within TTL). ruflo-daemon-gc to inspect.\n' "$remain" >&2
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
    // ── self-learning (SONA): own line with a volume bar (patterns/traj/HNSW) ──
    // Δ LoRA is intentionally NOT shown: the matrix-LoRA path is inert because
    // processInstantLearning is a no-op stub in the published @ruvector/ruvllm (latest
    // 2.5.5), so the delta is never consumed in a decision and deltaNorm=0. #519 was
    // closed WITHOUT a published fix; the live tracker is ruvnet/RuVector#553. Re-add the
    // Δ LoRA field only once ruvllm ships a real impl and the delta moves. (#8 F4 gate.)
    var learn = "";
    try {
      var sp = path.join(cwd, ".claude-flow", "neural", "stats.json");
      if (fs.existsSync(sp)) {
        var s = JSON.parse(fs.readFileSync(sp, "utf8"));
        var pn = s.patternsLearned || 0, tj = s.trajectoriesRecorded || 0, parts = [];
        if (pn > 0 || tj > 0) {
          if (pn > 0) parts.push(pn + " patterns");
          if (tj > 0) parts.push(tj + " traj");
          if (fs.existsSync(path.join(cwd, ".swarm", "hnsw.index"))) parts.push(G + "⚡ HNSW" + R);
          var dots = Math.max(0, Math.min(5, Math.round(pn / 10)));   // volume gauge: ~10 patterns per dot
          learn = C + "🧠 SONA" + R + "  " + DIM + bar(dots, 5) + R + "  " + parts.join(DIM + " · " + R);
        }
      }
    } catch(e){}
    // ── route Q-learner (📈 RL): live agent-routing metrics, fs-only, honesty-gated ──
    // F3 (ruvnet/ruflo#2239) is fixed in ruflo 3.10.6+/3.10.31 — the state encoder no
    // longer collapses keyword-distinct tasks (FNV-1a, ENCODER_VERSION=2), so |Q| is a
    // real task-diversity count. Source the persisted Q-model directly; never the broken
    // `route stats` CLI. Gate hard: render ONLY when the learner has actually run
    // (updateCount>0), else emit nothing — no zero-state noise.
    var route = "";
    try {
      var qp = path.join(cwd, ".swarm", "q-learning-model.json");
      if (fs.existsSync(qp)) {
        var qm = JSON.parse(fs.readFileSync(qp, "utf8"));
        var st = qm.stats || {};
        var upd = st.updateCount || 0;
        if (upd > 0) {
          var eps = typeof st.epsilon === "number" ? st.epsilon : null;
          var td = typeof st.avgTDError === "number" ? st.avgTDError : null;
          var qn = qm.qTable && typeof qm.qTable === "object" ? Object.keys(qm.qTable).length : 0;
          var rp = [];
          if (eps !== null) rp.push("ε" + eps.toFixed(2) + DIM + "↓" + R);
          if (td !== null) rp.push("δ̄" + td.toFixed(3) + DIM + "↓" + R);
          if (qn > 0) rp.push("|Q|" + qn);
          rp.push("upd" + upd);
          route = C + "📈 RL" + R + "  " + rp.join(DIM + " · " + R);
        }
      } else {
        // Fallback: ruflo's metrics surface (no broken route-stats CLI). Only when it
        // reflects real routing decisions.
        var lp = path.join(cwd, ".claude-flow", "metrics", "learning.json");
        if (fs.existsSync(lp)) {
          var lj = JSON.parse(fs.readFileSync(lp, "utf8"));
          var rt = lj.routing || {};
          if ((rt.decisions || 0) > 0) {
            var rp2 = [];
            if (typeof rt.accuracy === "number") rp2.push("acc" + Math.round(rt.accuracy * 100) + "%");
            rp2.push("dec" + rt.decisions);
            route = C + "📈 RL" + R + "  " + rp2.join(DIM + " · " + R);
          }
        }
      }
    } catch(e){}
    // ── proof verdict (self-improvement eval): ALARM-ONLY, fs-only ──
    // Sources the most recent ruflo-improvement-eval run (.claude-flow/improvement.json):
    // a pre-registered causal test (one-sided permutation p + Cohen's d + above-chance)
    // that the route Q-learner self-improves vs a no-learning ablation. It is a SYNTHETIC
    // proof-of-mechanism (its own reward env), NOT a live measure of real routing — that
    // is what the 📈 RL line above is. So PASS is the expected state and is rendered
    // SILENTLY; only a FAIL (a real regression worth a look) surfaces, as ◷ proof FAIL.
    // The run age (im.ts) is appended so a stale FAIL reads honestly. Never a fabricated
    // source. Fields per #8: Δpp · CI · p · d · age. (#8 — alarm-only per user decision.)
    var proof = "";
    try {
      var ip = path.join(cwd, ".claude-flow", "improvement.json");
      if (fs.existsSync(ip)) {
        var im = JSON.parse(fs.readFileSync(ip, "utf8"));
        if (im && im.verdict === "FAIL") {
          var pp = [];
          if (typeof im.deltaPP === "number") pp.push("Δ" + (im.deltaPP >= 0 ? "+" : "") + im.deltaPP + "pp");
          if (typeof im.ci95 === "number") pp.push("CI±" + im.ci95);
          if (typeof im.pValue === "number") pp.push("p" + (im.pValue < 0.001 ? "<.001" : "=" + im.pValue.toFixed(3)));
          if (typeof im.cohensD === "number") pp.push("d" + (im.cohensD >= 999 ? "∞" : im.cohensD));
          if (typeof im.ts === "number") {
            var ageSec = Math.floor(Date.now() / 1000) - im.ts;
            if (ageSec >= 86400) pp.push(Math.floor(ageSec / 86400) + "d ago");
            else if (ageSec >= 3600) pp.push(Math.floor(ageSec / 3600) + "h ago");
          }
          proof = Y + "◷ proof FAIL" + R + (pp.length ? "  " + DIM + pp.join(" · ") + R : "");
        }
      }
    } catch(e){}
    // ── security (aidefence loaded in the global ruflo install) ──
    var sec = "";
    try {
      var ad = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "ruflo", "node_modules", "@claude-flow", "aidefence", "package.json");
      if (fs.existsSync(ad)) sec = G + "🛡 aidefence on" + R;
    } catch(e){}
    // ── stray-daemon alarm (⚙): GLOBAL count of running ruflo daemons, so a
    // started-and-forgotten daemon can never again be invisible (token-burn
    // incident). Machine-global, not per-project, so it is cached in tmpdir and
    // shared across every project's statusline — one pgrep per TTL window, not per
    // render. Alarm-only: absent at 0 (the expected opt-in steady state), dim at
    // 1-2 (a daemon you likely started on purpose), YELLOW at >=3 (a leak — run
    // ruflo-daemon-gc --kill). Opt out: RUFLO_DAEMON_STATUSLINE=0.
    var daemon = "";
    try {
      if (process.env.RUFLO_DAEMON_STATUSLINE !== "0") {
        var os = require("os");
        var dCache = path.join(os.tmpdir(), "ruflo-daemon-count.json");
        var dTtl = Number(process.env.RUFLO_DAEMON_STATUSLINE_TTL_MS || 30000);
        var dCount = null;
        try { var dc = JSON.parse(fs.readFileSync(dCache, "utf8")); if (dc && typeof dc.n === "number" && dTtl > 0 && (Date.now() - dc.ts) < dTtl) dCount = dc.n; } catch(e){}
        if (dCount === null) {
          try {
            var pg = cp.execFileSync("pgrep", ["-f", "cli.js daemon start"], {stdio:["ignore","pipe","ignore"], timeout:1500}).toString().trim();
            dCount = pg ? pg.split("\n").filter(Boolean).length : 0;
          } catch(e){ dCount = 0; }   // pgrep exits 1 (=> throws) when nothing matches
          try { fs.writeFileSync(dCache, JSON.stringify({ts: Date.now(), n: dCount})); } catch(e){}
        }
        if (dCount > 0) {
          var dCol = dCount >= 3 ? Y : DIM;
          daemon = dCol + "⚙ " + dCount + " ruflo daemon" + (dCount === 1 ? "" : "s") + R
                 + (dCount >= 3 ? DIM + " — ruflo-daemon-gc --kill" + R : "");
        }
      }
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
    // ── assemble: one ruflo feature per line (SONA, 📈 RL, ◷ proof FAIL alarm,
    // aidefence), then a divider, then the agentic-qe line. Each segment renders on its
    // OWN line so the live route metrics and the security state are individually scannable
    // and don't wrap. No rule above the SONA line — these are ruflo features and sit flush
    // under ruflo's native lines. The divider matches ruflo's native header width
    // ('─'.repeat(53) in statusline.cjs) so the two rules line up.
    var out = [];
    if (learn) out.push(learn);
    if (route) out.push(route);
    if (proof) out.push(proof);
    if (sec) out.push(sec);
    if (daemon) out.push(daemon);
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
	# Daemon is OPT-IN (token-burn incident): setup no longer auto-starts a
	# per-workspace daemon. Each one ran forever and nothing ever stopped it, so N
	# onboarded projects leaked N immortal daemons spawning worker sessions 24/7.
	# Start one yourself only when you want continuous background self-learning for a
	# project you are actively working — and the auto-reaper will still TTL-reap it.
	local _ws; _ws="$(pwd -P)"
	if command -v _ruflo_daemon_list >/dev/null 2>&1 && [ -n "$(_ruflo_daemon_list | awk -F'\t' -v w="$_ws" '$2==w{print $1; exit}')" ]; then
		echo "✓ Daemon already running for this workspace"
	else
		echo "ℹ  Daemon NOT started (opt-in). Run 'ruflo daemon start' for background self-learning; 'ruflo-daemon-gc' to inspect/reap."
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

	# Replace generated CLAUDE.md with a lean project-specific stub.
	# The machine-wide ~/.claude/CLAUDE.md already supplies all generic guidance
	# (operating rules, agent comms, routing tables, memory patterns, CLI reference).
	# Only project-specific facts belong here: swarm topology, build commands, and
	# any AQE config written later by ruflo-setup-aqe.
	if [ -f CLAUDE.md ]; then
		local _project_name; _project_name="$(basename "$(pwd)")"
		cat > CLAUDE.md <<STUB
<!-- Full ruflo CLI reference: see machine-wide ruflo reference at ~/.claude/CLAUDE.md -->

# ${_project_name}

## Swarm Config

- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

\`\`\`bash
ruflo swarm init --topology hierarchical --max-agents 8 --strategy specialized
\`\`\`

## Build & Test

\`\`\`bash
npm run build && npm test
\`\`\`

## Agentic QE v3
<!-- managed by ruflo-setup-aqe — aqe init skips regeneration when this sentinel is present -->
<!-- see ~/.claude/CLAUDE.md for full AQE operating guidance -->
STUB
		ok "wrote lean project CLAUDE.md (generic guidance lives in ~/.claude/CLAUDE.md)"
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

	# Ensure the AQE sentinel is in CLAUDE.md before aqe init runs.
	# Phase 11 (claude-md) skips regeneration when '## Agentic QE v3' already exists,
	# so the sentinel prevents the generic duplicate content from being appended.
	if [ -f CLAUDE.md ] && ! grep -q '## Agentic QE v3' CLAUDE.md; then
		printf '\n## Agentic QE v3\n<!-- managed by ruflo-setup-aqe — aqe init skips regeneration when this sentinel is present -->\n<!-- see ~/.claude/CLAUDE.md for full AQE operating guidance -->\n' >> CLAUDE.md
		echo "✓ wrote AQE sentinel into CLAUDE.md (prevents duplicate guidance from aqe init)"
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
# Thin passthrough to `ruflo neural train` in the CURRENT project.
#
# Historically this wrapper also captured the transient MicroLoRA Delta Norm and wrote
# .claude-flow/neural/lora-delta.json so the status line could show Δ<n> LoRA. That
# caching is REMOVED: the Δ LoRA footer field was dropped because the matrix-LoRA path
# is inert until @ruvector/ruvllm ships a real processInstantLearning (see the SONA
# segment note in rufloActivationSegments). #519 was closed without a published fix;
# the live tracker is ruvnet/RuVector#553. A deltaNorm that changes no decision is not a
# real adaptation signal, so there is nothing honest to display or cache yet. Re-add the
# capture here (and the footer field) only once ruvllm ships the wired impl.
#
#   ruflo-neural-train                 # = ruflo neural train -p coordination (default)
#   ruflo-neural-train -p security -e 100   # any `ruflo neural train` args pass through
ruflo-neural-train() {
	command -v ruflo >/dev/null 2>&1 || { echo "ruflo not on PATH" >&2; return 2; }
	ruflo neural train "$@"
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
# Sync ALL conditional reference sub-blocks in ~/.claude/CLAUDE.md (agentic-qe,
# superpowers, …) against their detectors: present when the tool is installed, stripped
# otherwise. The registry and the upsert/strip logic live in ruflo-lib.sh
# (_ruflo_cond_blocks, _ruflo_sync_cond_blocks); see docs/CONDITIONAL-BLOCKS.md. The name
# is kept for back-compat with existing callers and the `--sync-aqe` flag that predate the
# registry — it now reconciles every block, not just agentic-qe.
_ruflo_sync_aqe_block() {
	command -v _ruflo_sync_cond_blocks >/dev/null 2>&1 || return 0
	_ruflo_sync_cond_blocks "$HOME/.claude/CLAUDE.md" "$HOME/.config/ruflo"
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

	echo ""; echo "## machine-wide ~/.claude/CLAUDE.md: conditional reference blocks (agentic-qe, superpowers, …)"
	_ruflo_sync_aqe_block && echo "✓ conditional blocks in sync with detected tools"

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
#   ruflo-reference-refresh --sync-blocks reconcile conditional blocks (aqe, superpowers,
#                                        …) with detected tools (--sync-aqe is an alias)
ruflo-reference-refresh() {
	local ref="$HOME/.claude/CLAUDE.md"
	local template="$HOME/.config/ruflo/claude-md-template.md"
	local mode="status" yes=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--diff) mode="diff" ;;
			--regenerate) mode="regenerate" ;;
			--sync-aqe|--sync-blocks) mode="sync-blocks" ;;
			-y|--yes) yes=1 ;;
			-h|--help) echo "Usage: ruflo-reference-refresh [--diff|--regenerate [-y]|--sync-blocks]"; return 0 ;;
			*) echo "Unknown flag: $1"; return 2 ;;
		esac
		shift
	done
	# --sync-blocks (a.k.a. --sync-aqe) only reconciles the conditional blocks; no ruflo template needed.
	if [ "$mode" = "sync-blocks" ]; then _ruflo_sync_aqe_block; return 0; fi
	if [ ! -f "$template" ]; then
		echo "No template at $template (run install.sh, or extract from $ref)."
		return 1
	fi
	case "$mode" in
		status)
			echo "ruflo: $(ruflo --version 2>/dev/null || echo 'not installed')"
			echo "installed sentinel: $(grep -E 'ruflo-version' "$ref" 2>/dev/null || echo 'none')"
			echo "template  sentinel: $(grep -E 'ruflo-version' "$template" 2>/dev/null || echo 'none')"
			# Reconcile every conditional block (agentic-qe, superpowers, …) against its detector.
			if command -v _ruflo_cond_blocks >/dev/null 2>&1; then
				_ruflo_cond_blocks | while IFS='|' read -r _slug _src _tmpl _detector; do
					[ -n "$_slug" ] || continue
					_present=no; eval "$_detector" >/dev/null 2>&1 && _present=yes
					_inref=no; grep -qF "<!-- BEGIN $_slug -->" "$ref" 2>/dev/null && _inref=yes
					if   [ "$_present" = yes ] && [ "$_inref" = yes ]; then echo "$_slug: tool present — block present ✓"
					elif [ "$_present" = yes ] && [ "$_inref" = no  ]; then echo "$_slug: tool present — block MISSING (run --sync-blocks)"
					elif [ "$_present" = no  ] && [ "$_inref" = yes ]; then echo "$_slug: tool absent — block STALE (run --sync-blocks to strip)"
					else echo "$_slug: tool absent — block correctly absent"; fi
				done
			fi
			echo "Use --diff to compare, --regenerate to rebuild, --sync-blocks to fix conditional blocks."
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

# Run the stale-daemon safety net once this file is sourced into an interactive
# shell (no-op in scripts; throttled; opt out with RUFLO_DAEMON_AUTOREAP=0).
_ruflo_daemon_autoreap
