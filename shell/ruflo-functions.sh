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
#                            (interactive tool-family picker; --all to allow everything)
#   ruflo-setup-project      per repo: init + sanitize + activate + verify (recommended)
#   ruflo-patch / -native    make ruflo use native better-sqlite3 on Node >= 24
#   ruflo-remove-mcp         remove the ruflo MCP registration (and kit deny rules)
#   ruflo-memory-checkpoint  force a WAL checkpoint to recover stale memory reads
#   ruflo-reference-refresh  inspect/regenerate the machine-wide CLAUDE.md ruflo block

# ---------------------------------------------------------------------------
# One-time per machine: register the ruflo MCP server at USER scope (all projects),
# with a tool-family picker.
#
# Why this is safe now (it wasn't always): Claude Code defers MCP tool schemas and
# loads them on demand (ToolSearch), so registration no longer front-loads ~84k tokens
# of tool definitions per session — the residual context cost is roughly one name line
# per tool. ruflo 3.28 exposes ~276 tools across ~35 families and has NO server-side
# tool gating, so the picker enforces exclusions client-side: every tool in a family
# you exclude gets an exact `mcp__claude-flow__<tool>` entry in permissions.deny in
# ~/.claude/settings.json (backed up first).
#
# The registration key is `claude-flow` (upstream #2206 — plugin tool refs like
# mcp__claude-flow__* resolve, and `ruflo init`'s dedup guard (#1779/#2612) detects the
# user-scope entry, so init stops writing a per-project .mcp.json).
#
#   ruflo-setup-machine          # show family inventory, pick exclusions, register
#   ruflo-setup-machine --all    # non-interactive: register with every family allowed
# (unalias guard: this was an alias before 2026-07; zsh cannot define a function over
#  a live alias, so any stale copy in a user's rc would otherwise break this file.)
unalias ruflo-setup-machine 2>/dev/null
ruflo-setup-machine() {
	command -v claude >/dev/null 2>&1 || { echo "claude CLI not on PATH" >&2; return 2; }
	command -v node >/dev/null 2>&1 || { echo "node not on PATH" >&2; return 2; }
	local all=0
	[ "${1:-}" = "--all" ] && all=1

	# Enumerate tool families from the installed package (source of truth, so the
	# inventory tracks whatever ruflo version is installed).
	local inv
	inv="$(node -e '
const fs=require("fs"),path=require("path"),cp=require("child_process");
let root; try{root=cp.execSync("npm root -g",{stdio:["ignore","pipe","ignore"]}).toString().trim();}catch(e){process.exit(1);}
const dir=path.join(root,"ruflo","node_modules","@claude-flow","cli","dist","src","mcp-tools");
if(!fs.existsSync(dir))process.exit(1);
const names=new Set();
for(const f of fs.readdirSync(dir)){
  if(!f.endsWith(".js"))continue;
  const s=fs.readFileSync(path.join(dir,f),"utf8");
  for(const m of s.matchAll(/name:\s*["\x27]([a-z][a-z0-9]*_[a-z0-9_]+)["\x27]/g)) names.add(m[1]);
}
const fam={};
for(const n of names){const p=n.split("_")[0];(fam[p]=fam[p]||[]).push(n);}
for(const [p,l] of Object.entries(fam).sort((a,b)=>b[1].length-a[1].length))
  console.log(p+"\t"+l.length+"\t"+l.sort().join(","));
' 2>/dev/null)"
	if [ -z "$inv" ]; then
		echo "⚠  Could not enumerate MCP tools from the installed ruflo — registering without a picker."
		all=1
	fi

	local exclude=""
	if [ "$all" -eq 0 ]; then
		echo "ruflo MCP tool families (from the installed ruflo):"
		printf '%s\n' "$inv" | awk -F'\t' '{printf "  %-14s %3d tools\n", $1, $2}'
		echo ""
		echo "Schemas load on demand, so allowing everything is cheap; exclude families you"
		echo "never want callable (each excluded tool becomes a permissions.deny rule)."
		printf "Families to EXCLUDE (comma-separated, or Enter for none): "
		local r; read -r r
		exclude="$(printf '%s' "$r" | tr -d ' ')"
	fi

	# Migrate: drop a legacy `ruflo`-keyed registration so we never double-register.
	claude mcp remove ruflo -s user >/dev/null 2>&1 && echo "✓ removed legacy 'ruflo' MCP registration (re-adding as 'claude-flow')"

	if claude mcp list 2>/dev/null | grep -q '^claude-flow[[:space:]:]'; then
		echo "✓ claude-flow MCP already registered"
	elif claude mcp add claude-flow -s user -- ruflo mcp start >/dev/null 2>&1; then
		echo "✓ registered claude-flow MCP at user scope (ruflo mcp start)"
	else
		echo "⚠  claude mcp add failed — run manually: claude mcp add claude-flow -s user -- ruflo mcp start"
		return 1
	fi

	# Apply exclusions as exact-name deny rules (client-side gate; see comment above).
	if [ -n "$exclude" ]; then
		INV="$inv" EXCLUDE="$exclude" node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const p=path.join(os.homedir(),".claude","settings.json");
let d={}; try{d=JSON.parse(fs.readFileSync(p,"utf8"));}catch(e){}
try{fs.copyFileSync(p,p+".bak");}catch(e){}
const excl=new Set(process.env.EXCLUDE.split(",").filter(Boolean));
const deny=new Set((d.permissions&&d.permissions.deny)||[]);
let n=0;
for(const line of process.env.INV.split("\n")){
  const [fam,,tools]=line.split("\t");
  if(!excl.has(fam))continue;
  for(const t of (tools||"").split(",").filter(Boolean)){deny.add("mcp__claude-flow__"+t);n++;}
}
d.permissions=d.permissions||{};d.permissions.deny=Array.from(deny).sort();
fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");
console.log("✓ denied "+n+" tool(s) in excluded families via ~/.claude/settings.json (backup: settings.json.bak)");
' || echo "⚠  could not write deny rules — edit ~/.claude/settings.json permissions.deny manually"
	fi
	echo "Revisit anytime: ruflo-remove-mcp to unregister, or re-run ruflo-setup-machine."
}

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
# Remove the ruflo MCP registration from all scopes (user, local, project), under
# both the current `claude-flow` key (#2206) and the legacy `ruflo` key, and strip
# any kit-written mcp__claude-flow__* deny rules (meaningless without the server).
# Idempotent; silently skips scopes where nothing is registered.
ruflo-remove-mcp() {
	local s k removed=0
	for k in claude-flow ruflo; do
		for s in user local project; do
			if claude mcp remove "$k" -s "$s" >/dev/null 2>&1; then
				echo "✓ Removed $k from $s scope"
				removed=1
			fi
		done
	done
	[ "$removed" -eq 0 ] && echo "ruflo MCP not registered in any scope for this project."
	command -v node >/dev/null 2>&1 && node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const p=path.join(os.homedir(),".claude","settings.json");
let d; try{d=JSON.parse(fs.readFileSync(p,"utf8"));}catch(e){process.exit(0);}
const deny=(d.permissions&&d.permissions.deny)||[];
const kept=deny.filter(r=>!/^mcp__claude-flow__/.test(r));
if(kept.length!==deny.length){
  d.permissions.deny=kept;
  fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");
  console.log("✓ removed "+(deny.length-kept.length)+" kit deny rule(s) for mcp__claude-flow__*");
}
' 2>/dev/null
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

# Statusline heal. Historically this injected a global-node_modules version probe
# because upstream's statusline only checked LOCAL package.json paths and rendered a
# stale hard-coded version. ruflo 3.28 ships that fix natively (#2221: probes global
# roots derived from process.execPath + npm_config_prefix, highest-version-wins), so
# the probe injection is gone. What remains kit-owned:
#   (a) refresh the hard-coded fallback version string to the installed version, and
#   (b) inject the activation FOOTER (ruflo-seg block: SONA / Δ‖W‖ / RL / daemon /
#       Agentic QE segments) — kit-unique, re-applied after every init/upgrade.
# Idempotent and re-applied on every setup. Optional arg 1 overrides the path.

# ---------------------------------------------------------------------------
# Daemon lifecycle. Since ruflo 3.27/3.28 (#2661) the daemon is safe by default:
# AI workers (headless `claude --print` runs that spend tokens) are OPT-IN
# (RUFLO_DAEMON_AI_WORKERS=1 / --headless), governed by a machine-wide launch budget
# (`ruflo daemon budget show|pause|resume`; defaults 1 concurrent, 2/hour, 12/day),
# deduped across worktrees, and the daemon self-terminates after a native TTL
# (RUFLO_DAEMON_TTL_SECS, default 12h, #2356). So ruflo-setup-project now STARTS a
# local-only daemon by default (kit policy — $0 workers: map/audit/optimize local
# paths). The June-2026 token-burn incident (immortal auto-started daemons spawning
# uncapped worker sessions) cannot recur from this path: the expensive part is
# opt-in + budgeted upstream, and the reapers below remain as an independent check.
# ruflo-daemon-gc / the interactive-shell auto-reaper stop daemons that are orphaned
# (workspace deleted) or outlive the TTL — belt-and-suspenders over upstream's own TTL.
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
# Independent safety net over upstream's native TTL (#2356): even if a daemon predates
# 3.28, loses its workspace, or has TTL disabled, it is reaped here once it exceeds
# the kit TTL. Interactive-only (never kills/prints from scripts or subshells).
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
	# Refresh only the hard-coded fallback version string; 3.28's own probing (#2221)
	# handles live resolution, and any legacy kit probe marker is stripped if present.
	# shellcheck disable=SC2016  # single-quoted JS for node -e, not shell expansion
	if ! SL="$sl" LIVE_VER="$live_ver" node -e '
const fs=require("fs"); const f=process.env.SL; let s=fs.readFileSync(f,"utf8");
s=s.replace(/ \/\* ruflo-machine-ref: global-install version probe \*\/ require\("path"\)\.join\(require\("path"\)\.dirname\(process\.execPath\),"\.\.","lib","node_modules","ruflo","package\.json"\),/,"");
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
    // ── self-learning (SONA): own line with a volume bar (patterns/traj/HNSW) plus a
    // LIVE micro-LoRA adaptation field (Δ‖W‖, appended further below). The Δ‖W‖ tracker
    // is maintained inline in this same function — see the "micro-LoRA LIVE adaptation"
    // block after the route-Q segment.
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
    // ── micro-LoRA LIVE adaptation: Δ‖W‖<cum> +<session> <trend> n<count> ──
    // Shows the model ACTUALLY ADAPTING FROM YOUR WORK, live. ruflo's own micro-LoRA is
    // per-process scratch ("resets per process", intelligence.js) — every hook reinits it
    // (random A, B=0), applies that call's signals, then DISCARDS the weights; only
    // patterns.json / stats.json persist. So the kit persists what ruflo throws away: a
    // single cumulative micro-LoRA in lora-live.json, advanced HERE (inline, mtime+TTL
    // gated) by feeding each NEW distilled pattern ruflo has learned from your work
    // (.claude-flow/neural/patterns.json) through the genuine @ruvector/ruvllm 2.5.6
    // gradient path (real since F4 fixed), weighted by ruflo's OWN per-pattern confidence
    // (no fabricated reward). The init RNG is seeded and weights are restored each tick, so
    // the result is DETERMINISTIC (no 41%-CV random-init noise) and cumulative.
    //   Δ‖W‖ = ‖scaling·(A·B)‖_F  (federated-LoRA's standard adaptation-magnitude monitor)
    //   +<session> = growth since this session began (the live "from your work" signal)
    //   n = distinct patterns fed (REINFORCE updates).  Gate: cum norm > 0.
    // Honest scope: a kit-persisted MIRROR of ruflo's discarded adapter, fed ruflo's real
    // confidence-weighted patterns. NOT shown: amplification factor (no frozen base W) and
    // a live reward curve (neural-train's WASM path records trajectories, not signals → 0).
    try {
      var nd = path.join(cwd, ".claude-flow", "neural");
      var pPath = path.join(nd, "patterns.json"), sPath = path.join(nd, "lora-live.json");
      if (fs.existsSync(pPath)) {
        var st = null; try { st = JSON.parse(fs.readFileSync(sPath, "utf8")); } catch(e){}
        var nowS = Math.floor(Date.now() / 1000);
        var pMtimeMs = fs.statSync(pPath).mtimeMs;   // ms precision: same-second writes still detected
        var TTL = Number(process.env.RUFLO_LORA_TTL_S || 60);
        // Session boundary: prefer Claude Code's real session_id (piped on stdin) so the
        // +<session> delta resets exactly when YOU start a new session — not on a clock.
        // getStdinData() is the host statusline's cached single-read of that JSON; guard the
        // call so the segment still works on a template that lacks it, or run standalone.
        var sid = "";
        try { if (typeof getStdinData === "function") { var _sd = getStdinData(); sid = (_sd && (_sd.session_id || _sd.sessionId)) || ""; } } catch(e){}
        // Refresh when: no state yet, the session changed (reset the +session baseline even
        // with no new patterns), or patterns changed and the TTL has elapsed.
        var sidChanged = !!(sid && st && (st.sessionId || "") !== sid);
        var stale = !st || sidChanged || (pMtimeMs > (st.pms || 0) && (nowS - (st.ts || 0)) >= TTL);
        if (stale) {
          // Resolve the installed ruvllm SonaCoordinator (same global layout as the version probe).
          var SC = null;
          try {
            var sj = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "ruflo",
                               "node_modules", "@ruvector", "ruvllm", "dist", "cjs", "sona.js");
            if (fs.existsSync(sj)) SC = require(sj).SonaCoordinator;
          } catch(e){}
          if (SC) {
            var pats = JSON.parse(fs.readFileSync(pPath, "utf8"));
            // Seed Math.random so the first-ever loraA init is deterministic; restore after ctor.
            var seed = 0x9e3779b9, orig = Math.random;
            Math.random = function(){ seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
            var coord = new SC({ backgroundLoopEnabled: false });
            Math.random = orig;
            var applied = new Set((st && st.appliedIds) || []);
            var n = (st && st.n) || 0;
            if (st && st.loraA) { try { coord.microLora.setWeights({ loraA: st.loraA, loraB: st.loraB, scaling: st.scaling }); } catch(e){} }
            var prevSid = st ? (st.sessionId || "") : "";
            var newSession;
            if (sid) {
              newSession = !st || prevSid !== sid;          // real per-session boundary
            } else {
              newSession = !st || (nowS - (st.ts || 0) > 1800);  // no id (manual run): idle fallback
              sid = prevSid;                                // preserve the session we're in
            }
            var sessionBase = newSession ? (st ? (st.deltaNorm || 0) : 0) : (st.sessionBase || 0);
            var sessionTs = newSession ? nowS : (st.sessionTs || nowS);
            for (var i = 0; i < (Array.isArray(pats) ? pats.length : 0); i++) {
              var p = pats[i], id = String(p.id || i);
              if (applied.has(id)) continue;
              var conf = (typeof p.confidence === "number") ? p.confidence : Number(p.confidence);
              coord.recordSignal({ requestId: id, type: p.type || "pattern",
                                   quality: (conf >= 0 && conf <= 1) ? conf : 0.7, correction: String(p.content || id) });
              applied.add(id); n++;
            }
            var w = coord.microLora.getWeights(), nm = coord.stats().microLora.deltaNorm;
            var rec = { loraA: w.loraA, loraB: w.loraB, scaling: w.scaling, appliedIds: Array.from(applied),
                        n: n, deltaNorm: nm, sessionBase: sessionBase, sessionTs: sessionTs, sessionId: sid,
                        pms: pMtimeMs, ts: nowS };
            try { var tmp = sPath + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, sPath); } catch(e){}
            st = rec;
          }
        }
        if (st && typeof st.deltaNorm === "number" && st.deltaNorm > 0) {
          var sess = st.deltaNorm - (st.sessionBase || 0);
          var trend = "";
          if (Math.abs(sess) / st.deltaNorm < 0.005) trend = DIM + "→" + R;
          else trend = sess > 0 ? (G + "▲" + R) : (Y + "▼" + R);
          var sessStr = (Math.abs(sess) / st.deltaNorm >= 0.005)
            ? (" " + (sess > 0 ? G : Y) + (sess > 0 ? "+" : "") + sess.toFixed(4) + R) : "";
          var dseg = C + "Δ‖W‖" + st.deltaNorm.toFixed(4) + R + sessStr + trend + DIM + " n" + st.n + R;
          if (learn) { learn += DIM + " · " + R + dseg; }
          else { learn = C + "🧠 Δ LoRA" + R + "  " + dseg; }
        }
      }
    } catch(e){}
    // ── route Q-learner (📈 RL): live agent-routing metrics, fs-only, honesty-gated ──
    // F3 (ruvnet/ruflo#2239) is fixed in ruflo 3.10.11 (FNV-1a lossless fold) — the
    // state encoder no longer collapses keyword-distinct tasks, so |Q| is a
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
    // ── security: 🛡 renders ONLY when @claude-flow/aidefence (the actual runtime
    // defense engine behind `security defend`) is resolvable. ruflo 3.28 dropped it
    // from the dependency tree while the command still imports it (ruvnet/ruflo#2670),
    // so a bare 3.28 install has NO working injection defense — the segment honestly
    // disappears until ruflo-resync reinstalls the package (@claude-flow/security is
    // auth/validation primitives, not detection; probing it would overstate).
    var sec = "";
    try {
      var nmBase = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "ruflo", "node_modules", "@claude-flow");
      if (fs.existsSync(path.join(nmBase, "aidefence", "package.json"))) sec = G + "🛡 aidefence on" + R;
    } catch(e){}
    // ── daemon visibility (⚙): GLOBAL count of running ruflo daemons, so no daemon
    // is ever invisible (token-burn incident lesson). Machine-global, not per-project,
    // so it is cached in tmpdir and shared across every project's statusline — one
    // pgrep per TTL window, not per render. Daemons are default-on (local-only
    // workers, budget-governed AI workers) since the 3.28 baseline, so one per active
    // project is the EXPECTED steady state: dim up to 3, YELLOW at >=4 (more daemons
    // than you're plausibly working projects — ruflo-daemon-gc to inspect; upstream
    // TTL + kit auto-reap will also converge it). Opt out: RUFLO_DAEMON_STATUSLINE=0.
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
          var dCol = dCount >= 4 ? Y : DIM;
          daemon = dCol + "⚙ " + dCount + " ruflo daemon" + (dCount === 1 ? "" : "s") + R
                 + (dCount >= 4 ? DIM + " — ruflo-daemon-gc to inspect" + R : "");
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

	# LEGACY-STATE healing: aqe <3.12.1 used to repoint .claude/settings.json at its
	# minimal statusline-v3.cjs (hiding the footer). aqe >=3.12.1 preserves a custom
	# statusLine (isAqeStatusLine guard), so new inits can no longer cause this — but
	# projects initialized under older aqe still carry the v3 pointer, and this heals
	# them on the next setup/resync. Make statusline.cjs primary (falls back to v3,
	# then a literal). Only when patching the default project statusline.
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
	# Daemon: default-ON with LOCAL-ONLY workers (kit policy on the 3.28 baseline).
	# Safe because upstream #2661 made the expensive part opt-in: AI workers (headless
	# `claude --print`) only run with RUFLO_DAEMON_AI_WORKERS=1 / --headless, governed
	# by the machine-wide launch budget, and the daemon self-terminates after
	# RUFLO_DAEMON_TTL_SECS (native, default 12h). Local workers are $0 Node work.
	local _ws; _ws="$(pwd -P)"
	if command -v _ruflo_daemon_list >/dev/null 2>&1 && [ -n "$(_ruflo_daemon_list | awk -F'\t' -v w="$_ws" '$2==w{print $1; exit}')" ]; then
		echo "✓ Daemon already running for this workspace"
	elif ruflo daemon start >/dev/null 2>&1; then
		echo "✓ Daemon started (local-only workers; self-terminates after 12h TTL)"
		echo "   AI workers are OFF — enable with RUFLO_DAEMON_AI_WORKERS=1; caps: 'ruflo daemon budget show'"
	else
		echo "⚠  Daemon failed to start — run 'ruflo daemon start' manually; 'ruflo daemon status' to inspect"
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
# Two failure modes handled:
#   1. agentic-qe depends on better-sqlite3@^12 directly; on Node >= 24 its prebuilt
#      .node is missing (native:false) → `aqe init` fails at "Initialize persistence
#      database". We install the native binary into the global agentic-qe first.
#      (Same root cause as ruflo-patch-native, different package.)
#   2. Half-init: `.agentic-qe/memory.db` exists but the project marker
#      `.claude/skills/agentic-quality-engineering` is missing (interrupted init) →
#      re-run with --upgrade.
# NOTE: since aqe 3.12.1, `aqe init` merges .claude/settings.json non-destructively
# (one-time backup; preserves ruflo hooks, custom statusLine, user AQE_* env). The
# hook-stripping / statusLine-clobbering hazards this function used to defend against
# are fixed upstream — keep aqe >= 3.12.1.
#
# Ensure @claude-flow/aidefence is present in the global ruflo tree. ruflo 3.28
# dropped it from the dependency tree while `security defend` still dynamically
# imports it, leaving the CLI's prompt-injection defense silently non-functional
# (filed: ruvnet/ruflo#2670). Installing it --no-save restores correct behavior
# (exit 1=threat / 0=clean). The install is wiped by the next `npm i -g ruflo`,
# so this runs from ruflo-resync — the kit's standard re-heal path. Idempotent;
# no-op when the package already resolves or ruflo/npm are absent.
_ruflo_ensure_aidefence() {
	command -v ruflo >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || return 0
	command -v _ruflo_global_root >/dev/null 2>&1 || return 0
	local ruflo_root; ruflo_root="$(_ruflo_global_root)/ruflo"
	[ -d "$ruflo_root" ] || return 0
	# fs check, not require.resolve — the package's `exports` map does not expose
	# ./package.json as a resolvable subpath.
	if [ -f "$ruflo_root/node_modules/@claude-flow/aidefence/package.json" ]; then
		return 0   # already present
	fi
	echo "Installing @claude-flow/aidefence into ruflo ('security defend' imports it but 3.28 stopped shipping it — ruvnet/ruflo#2670)…"
	if ( cd "$ruflo_root" && npm install @claude-flow/aidefence --no-save --no-audit --no-fund >/dev/null 2>&1 ); then
		ok "@claude-flow/aidefence installed — 'ruflo security defend' functional again"
	else
		warn "could not install @claude-flow/aidefence — 'ruflo security defend' stays non-functional (see ruvnet/ruflo#2670)"
	fi
}

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

# Quarantine corrupt/oversized RVF (ruvector) pattern stores in a project's
# .agentic-qe/ so agentic-qe's shared RVF adapter initializes cleanly instead of
# failing with "RVF error 0x0303: FsyncFailed" and silently dropping OFF ruvector
# for the whole run (falling back to the SQLite/hnswlib path).
#
# Root cause seen in the wild: a pattern store balloons to an absurd size
# (a real per-repo store is KB–MB; we found a patterns.rvf at ~277 GB) after a
# hard exit mid-write. The next `aqe` startup cannot fsync it, so the RVF backend
# is disabled for that run. Any .rvf past a sane cap is therefore corrupt: it is
# DELETED (it is a derived cache, rebuilt from the source of truth
# .agentic-qe/memory.db on the next run — not primary data) along with its
# .idmap.json/.manifest.json/.lock sidecars. Idempotent; no-op when there is no
# .agentic-qe/ or nothing is corrupt. Ordinary stale *.rvf.lock files are left for
# aqe, which self-heals them ("Removed stale lock file … Retrying open") — EXCEPT
# a lock whose content starts with the RVF magic "FLVR": that means store bytes were
# written into the lock path by an interrupted write (seen in the wild 2026-07-14:
# a 162-byte brain.rvf + FLVR-content lock → FsyncFailed on every init, and aqe did
# NOT self-heal it). Those locks and their truncated sibling .rvf are quarantined.
#
# Cap override: RUFLO_AQE_RVF_MAX_BYTES (default 2147483648 = 2 GiB; 0 disables).
_ruflo_aqe_repair_rvf() {
	local dir="${1:-.agentic-qe}"
	[ -d "$dir" ] || return 0
	local repaired=0 f sz gib lk
	# Corrupt-lock quarantine: RVF magic bytes in a .lock = interrupted write.
	for lk in "$dir"/*.rvf.lock; do
		[ -e "$lk" ] || continue
		if [ "$(head -c 4 "$lk" 2>/dev/null)" = "FLVR" ]; then
			f="${lk%.lock}"
			warn "corrupt agentic-qe RVF lock: $lk (contains store bytes — interrupted write) — quarantining lock + $f; aqe will rebuild from memory.db"
			rm -f "$lk" "$f" "$f".idmap.json "$f".manifest.json 2>/dev/null
			repaired=1
		fi
	done
	local cap="${RUFLO_AQE_RVF_MAX_BYTES:-2147483648}"
	[ "${cap:-0}" -gt 0 ] 2>/dev/null || { [ "$repaired" -eq 1 ] && ok "quarantined corrupt RVF store(s) — ruvector adapter will initialize cleanly next run"; return 0; }
	for f in "$dir"/*.rvf; do
		[ -e "$f" ] || continue
		# Portable size: BSD stat (-f%z) then GNU stat (-c%s).
		sz="$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null)"
		[ -n "$sz" ] || continue
		if [ "$sz" -gt "$cap" ] 2>/dev/null; then
			gib="$(awk "BEGIN{printf \"%.1f\", $sz/1073741824}")"
			warn "corrupt agentic-qe RVF store: $f (~${gib} GiB, over $((cap/1073741824)) GiB cap) — deleting; aqe will rebuild from memory.db"
			rm -f "$f" "$f".idmap.json "$f".manifest.json "$f".lock 2>/dev/null
			repaired=1
		fi
	done
	[ "$repaired" -eq 1 ] && ok "quarantined corrupt RVF store(s) — ruvector adapter will initialize cleanly next run"
	return 0
}

# Best-effort: install the OPTIONAL @ruvector/solver-node into the global
# agentic-qe so `useSublinearSolver` uses the native sublinear-PageRank path over
# the pattern citation graph instead of the TypeScript power-iteration fallback
# (practical cap ≈ 50K nodes). agentic-qe already ships @ruvector/rvf-node,
# @ruvector/attention and @ruvector/gnn as its own deps; solver-node is the one
# optional native `aqe upgrade` recommends. Idempotent; no-op if present or if
# aqe/npm absent. Failure is non-fatal — the TS fallback still works.
_ruflo_aqe_ensure_ruvector_native() {
	command -v aqe >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || return 0
	local aqe_root; aqe_root="$(_ruflo_global_root)/agentic-qe"
	[ -d "$aqe_root" ] || return 0
	if node -e "require.resolve('@ruvector/solver-node',{paths:['$aqe_root']})" >/dev/null 2>&1; then
		return 0   # already present
	fi
	echo "Installing optional @ruvector/solver-node into agentic-qe (native sublinear PageRank)…"
	if ( cd "$aqe_root" && npm install @ruvector/solver-node --no-save --no-audit --no-fund >/dev/null 2>&1 ); then
		ok "@ruvector/solver-node installed — native sublinear solver active"
	else
		warn "could not install @ruvector/solver-node — sublinear PageRank uses TS fallback (fine for <50K nodes)"
	fi
}

#   ruflo-setup-aqe            # init (or repair) agentic-qe in this repo
#   ruflo-setup-aqe --force    # force reinitialize (--upgrade)
ruflo-setup-aqe() {
	local force=0
	[ "${1:-}" = "--force" ] && force=1

	_ruflo_aqe_ensure_native
	_ruflo_aqe_repair_rvf              # delete corrupt/oversized .rvf so RVF init won't FsyncFail
	_ruflo_aqe_ensure_ruvector_native  # optional native sublinear solver

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
			if command -v ruflo-verify-aqe >/dev/null 2>&1; then
				echo ""; echo "## prove agentic-qe is on ruvector"
				ruflo-verify-aqe || echo "⚠  agentic-qe not fully on ruvector — see docs/TROUBLESHOOTING.md"
			fi
		else
			echo "⚠  agentic-qe not installed — re-run:  install.sh --with-aqe   (or npm i -g agentic-qe)"
		fi
	fi

	# Machine-level MCP: offered by default (deferred schemas make it cheap; the
	# family picker lets you exclude tool families). One-time — skipped once registered.
	if command -v claude >/dev/null 2>&1 && ! claude mcp list 2>/dev/null | grep -q '^claude-flow[[:space:]:]'; then
		echo ""
		if ask_yes_no "Register the ruflo MCP server at user scope (one-time, tool-family picker)?" "y"; then
			ruflo-setup-machine || echo "⚠  MCP setup failed — re-run 'ruflo-setup-machine' later"
		else
			echo "  Skipped. Register later with: ruflo-setup-machine"
		fi
	fi

	echo ""
	echo "✓ Onboard complete for $(pwd -P)"
	echo "  After any 'npm i -g ruflo@latest' (or agentic-qe@latest), run: ruflo-resync"
}

# ---------------------------------------------------------------------------
# Advance the LIVE micro-LoRA adaptation tracker for the current project.
#
# The actual tracking logic lives INLINE in the statusline (rufloActivationSegments):
# it maintains a kit-persisted, deterministic, cumulative micro-LoRA in
# .claude-flow/neural/lora-live.json, advancing it by feeding each NEW pattern ruflo has
# distilled from your work through the genuine @ruvector/ruvllm 2.5.6 gradient path
# (confidence-weighted, seeded init → no random-init noise). ruflo's own micro-LoRA is
# per-process scratch and discarded; the kit persists what it throws away. The statusline
# advances it automatically on render (mtime+TTL gated), so it tracks live as you work.
# This helper just triggers one render so the file refreshes on demand (after a train, a
# resync, or an upgrade) without waiting for the next statusline tick.
#
#   ruflo-lora-track            # advance lora-live.json now (else: auto on next render)
ruflo-lora-track() {
	command -v node >/dev/null 2>&1 || { echo "node not on PATH" >&2; return 2; }
	local sl=".claude/helpers/statusline.cjs"
	[ -f "$sl" ] || sl="$HOME/.claude/helpers/statusline.cjs"
	[ -f "$sl" ] || { echo "no statusline.cjs — run ruflo-onboard first" >&2; return 0; }
	# Force the inline updater past its TTL by clearing the cached state's ts, then render.
	RUFLO_LORA_TTL_S=0 node "$sl" >/dev/null 2>&1 || true
	local lv=".claude-flow/neural/lora-live.json"
	[ -f "$lv" ] && node -e 'const s=require("fs").readFileSync(".claude-flow/neural/lora-live.json","utf8");const j=JSON.parse(s);process.stdout.write("  Δ‖W‖ "+(+j.deltaNorm).toFixed(6)+" · n"+j.n+" patterns adapted\n")' 2>/dev/null
}

# ---------------------------------------------------------------------------
# Thin passthrough to `ruflo neural train` in the CURRENT project, then advance the
# live micro-LoRA tracker so the statusline Δ‖W‖ field reflects any newly-learned patterns.
#
#   ruflo-neural-train                       # = ruflo neural train (default args)
#   ruflo-neural-train -p security -e 100    # any `ruflo neural train` args pass through
ruflo-neural-train() {
	command -v ruflo >/dev/null 2>&1 || { echo "ruflo not on PATH" >&2; return 2; }
	ruflo neural train "$@"
	local _exit=$?
	[ $_exit -eq 0 ] && command -v ruflo-lora-track >/dev/null 2>&1 && ruflo-lora-track
	return $_exit
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
	# Security defense engine: re-install the package 3.28 dropped but still imports
	# (ruvnet/ruflo#2670) — an `npm i -g ruflo` upgrade wipes the --no-save install.
	_ruflo_ensure_aidefence

	echo ""; echo "## 2/4 agentic-qe native + ruvector health (if installed)"
	_ruflo_aqe_ensure_native
	_ruflo_aqe_ensure_ruvector_native
	[ -d .agentic-qe ] && _ruflo_aqe_repair_rvf

	echo ""; echo "## 3/4 statusline (version + activation footer) for this project"
	ruflo-fix-statusline-version
	# Advance the live micro-LoRA tracker so the Δ‖W‖ field reflects the new
	# @ruvector/ruvllm (an upgrade may change the gradient path). Best-effort.
	command -v ruflo-lora-track >/dev/null 2>&1 && ruflo-lora-track

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
