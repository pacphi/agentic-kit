# Daemon & Statusline Resource Leak Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the kit from leaking orphan `ruflo daemon` processes and from spawning 2–4 `sqlite3` subprocesses per statusline render, the two confirmed root causes behind issue #3's `ENOSPC` session crashes.

**Architecture:** Keep the daemon (it drives continuous self-learning) but make its start idempotent per-workspace and give every surface that starts one a way to stop it: parity-test teardown stops its throwaway-workspace daemon, `uninstall.sh` stops stale + this-project daemons, and a new `ruflo-daemon-gc` reaps daemons whose `--workspace` is gone. The statusline footer caches its QE metrics to a TTL'd file (zero sqlite3 spawns within the window) and, on a miss, runs **one** stdin-fed `.bail off` sqlite3 call with `e.stdout` recovery.

**Tech Stack:** POSIX-ish bash + zsh (functions are sourced into the user's interactive shell), `ps axww -o pid=,args=`, `sqlite3`, Node (injected `statusline.cjs`), `python3` (JSON edits). Verification: `bash -n`, `shellcheck` (if installed), `node --check`, behavioral greps, and a live orphan-daemon round-trip.

**Spec:** `2026-05-29-superpowers-spec-daemon-statusline-resource-fix.md`

**Conventions:**
- No `Co-Authored-By` trailer (project `.claude/settings.json` has no `attribution.commit`).
- Commit after each task. Never use `--no-verify`.
- `ps axww -o pid=,args=` is the portable (macOS + Linux) full-width process listing; `-e` means "environment" on BSD/macOS, so it is NOT used.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `shell/ruflo-daemon-lib.sh` | **Shared** `_ruflo_daemon_list` ps-parser (defined once); sourced by the three consumers below (DRY — R10) | Create |
| `shell/ruflo-functions.sh` | Source the lib; `ruflo-daemon-gc`; idempotent daemon start + `autoStart` guard in `ruflo-setup-project`; cache + single-query in the injected statusline footer; `node --check` after injection | Modify |
| `bin/ruflo-parity-test` | Source the lib; stop the throwaway-workspace daemon in `cleanup_on_exit` (every exit path) | Modify |
| `uninstall.sh` | Source the lib; daemon teardown: GC stale daemons always; stop this-repo daemon with `--this-project`; remove the installed lib | Modify |
| `install.sh` | Deploy `ruflo-daemon-lib.sh` to `~/.config/ruflo/` (stable path for standalone bin scripts) | Modify |
| `docs/TROUBLESHOOTING.md` | Document daemon lifecycle + `ruflo-daemon-gc` + `CLAUDE_CODE_TMPDIR` workaround | Modify |

> **DRY note (added after the user's request, R10):** the `_ruflo_daemon_list`
> `ps`-parser was initially written inline in all three consumers; it is now
> extracted into `shell/ruflo-daemon-lib.sh` (Task 7) and deployed by `install.sh`
> so the standalone-installed bin scripts can source it from a stable path.

---

## Task 1: Daemon lifecycle helpers + idempotent start + autoStart guard

**Files:**
- Modify: `shell/ruflo-functions.sh` (add helpers before `ruflo-setup-project`; edit the daemon-start line ~320 and add an autoStart guard after it)

- [ ] **Step 1: Add `_ruflo_daemon_list` and `ruflo-daemon-gc`**

Insert this block immediately before the `ruflo-fix-statusline-version() {` definition (currently line 90):

```bash
# ---------------------------------------------------------------------------
# Daemon lifecycle (issue #3). ruflo-setup-project starts a per-workspace daemon
# (continuous self-learning). Without reaping, throwaway/removed workspaces (e.g.
# ruflo-parity-test's /tmp dirs) leave orphan daemons running forever.
#
# _ruflo_daemon_list emits "<pid>\t<workspace>" for every ruflo daemon process.
# Portable: ps axww (-e means "environment" on macOS, so it is avoided).
_ruflo_daemon_list() {
	ps axww -o pid=,args= 2>/dev/null | while IFS= read -r line; do
		case "$line" in *"daemon start"*) ;; *) continue ;; esac
		case "$line" in *"--workspace "*) ;; *) continue ;; esac
		local ws=${line#*--workspace }; ws=${ws%% --*}
		local pid=${line%% *}
		[ -n "$pid" ] && [ -n "$ws" ] && printf '%s\t%s\n' "$pid" "$ws"
	done
}

# List (or, with --kill, stop) ruflo daemons whose --workspace no longer exists.
# Never touches a daemon whose workspace is still present (a live project).
#   ruflo-daemon-gc           # list orphans (dry preview)
#   ruflo-daemon-gc --kill    # stop them
ruflo-daemon-gc() {
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
```

- [ ] **Step 2: Make the daemon start idempotent in `ruflo-setup-project`**

Replace the single daemon-start line (currently line 320):

```bash
	ruflo daemon start >/dev/null 2>&1 && echo "✓ Daemon started" || echo "⚠  ruflo daemon start failed (may already be running)"
```

with:

```bash
	# Idempotent daemon start: never spawn a 2nd daemon for this workspace (issue #3).
	local _ws; _ws="$(pwd -P)"
	if [ -n "$(_ruflo_daemon_list | awk -F'\t' -v w="$_ws" '$2==w{print $1; exit}')" ]; then
		echo "✓ Daemon already running for this workspace (not starting another)"
	else
		ruflo daemon start >/dev/null 2>&1 && echo "✓ Daemon started" || echo "⚠  ruflo daemon start failed (may already be running)"
	fi
```

- [ ] **Step 3: Add the defensive `autoStart` guard after the daemon start**

Immediately after the block from Step 2 (and before the WAL-checkpoint comment `# WAL checkpoint so the sql.js reader...`), insert:

```bash
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
```

- [ ] **Step 4: Syntax + lint check**

Run: `bash -n shell/ruflo-functions.sh && echo OK`
Expected: `OK`

Run (if installed): `command -v shellcheck >/dev/null && shellcheck -S warning shell/ruflo-functions.sh; echo "shellcheck rc=$?"`
Expected: no NEW errors beyond any pre-existing ones (the file already had `# shellcheck disable` directives; do not introduce new warnings).

- [ ] **Step 5: Functional check of the helpers in a real shell**

Run:
```bash
zsh -c 'source shell/ruflo-functions.sh; type _ruflo_daemon_list ruflo-daemon-gc | grep -q "shell function" && echo "funcs load"; ruflo-daemon-gc'
```
Expected: prints `funcs load`, then either lists current orphans or `✓ no orphan daemons ...`. (Do not pass `--kill` here — that is Task 6.)

- [ ] **Step 6: Commit**

```bash
git add shell/ruflo-functions.sh
git commit -m "fix(daemon): reap orphan daemons (ruflo-daemon-gc), idempotent per-workspace start, autoStart guard (#3)"
```

---

## Task 2: Statusline footer — TTL cache + single sqlite3 spawn

**Files:**
- Modify: `shell/ruflo-functions.sh` (the `RUFLO_SEG_EOF` heredoc, currently lines 127–190; and add a `node --check` after the injection node script ~line 207)

- [ ] **Step 1: Replace the QE block inside the injected `rufloActivationSegments`**

Inside the `RUFLO_SEG_EOF` heredoc, replace the entire `// ── agentic-qe ...` block — from the line `    // ── agentic-qe (one guarded sqlite3 read) — branch + icon-tagged metrics ──` down to and including its closing `    } catch(e){}` (the one right before `    // ── assemble:`) — with this:

```javascript
    // ── agentic-qe — TTL-cached; one sqlite3 spawn only on a cache miss (issue #3) ──
    var qe = "";
    try {
      var db = path.join(cwd, ".agentic-qe", "memory.db");
      if (fs.existsSync(db)) {
        var cacheDir = path.join(cwd, ".claude-flow", "cache");
        var cacheFile = path.join(cacheDir, "qe-statusline.json");
        var ttl = Number(process.env.RUFLO_QE_STATUSLINE_TTL_MS || 60000);
        var cached = null;
        try {
          var c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
          if (c && typeof c.line === "string" && ttl > 0 && (Date.now() - c.ts) < ttl) cached = c.line;
        } catch(e){}
        if (cached !== null) {
          qe = cached;                       // hit: zero sqlite3 spawns
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
          qe = Y + "🎓 Agentic QE" + R + "  " + (qp.length ? qp.join(DIM + " · " + R) : "on");
          try { fs.mkdirSync(cacheDir, {recursive:true}); fs.writeFileSync(cacheFile, JSON.stringify({ts: Date.now(), line: qe})); } catch(e){}
        }
      }
    } catch(e){}
```

> Note: the `q(db, sql)` helper defined at the top of the block is still used by no other branch after this change. Leave it in place — it is harmless and keeps the diff minimal — unless `shellcheck`/lint flags it; the injected JS is not linted, so leave it.

- [ ] **Step 2: Add a `node --check` guard after the injection succeeds**

In `ruflo-fix-statusline-version`, the injection node script ends and prints
`✓ Statusline activation footer present (...)` on success (currently ~line 212).
Immediately after that `echo` line (inside the `else` branch), add:

```bash
		if ! node --check "$sl" 2>/dev/null; then
			echo "⚠  Injected statusline failed node --check — review $sl"
		fi
```

- [ ] **Step 3: Syntax check the shell file**

Run: `bash -n shell/ruflo-functions.sh && echo OK`
Expected: `OK`

- [ ] **Step 4: Prove the injected JS is valid and behaves (cache + single spawn)**

Extract the heredoc body to a temp file, wrap it with a fake `generateStatusline`, and check it parses and renders, then that a 2nd render within TTL does not rewrite via sqlite3 (cache hit). Run:

```bash
cd "$(git rev-parse --show-toplevel)"
tmp=$(mktemp -d)
# Pull the BEGIN..END block out of the heredoc in the shell file:
awk '/\/\* ruflo-seg:BEGIN \*\//{f=1} f{print} /\/\* ruflo-seg:END \*\//{f=0}' shell/ruflo-functions.sh > "$tmp/seg.js"
printf '\nfunction generateStatusline(){return "RuFlo V9.9.9";}\nconsole.log(generateStatusline() + rufloActivationSegments(process.cwd()));\n' >> "$tmp/seg.js"
node --check "$tmp/seg.js" && echo "node --check OK"
# Render against THIS repo (has .agentic-qe/memory.db). First render = cache miss (writes cache):
rm -f .claude-flow/cache/qe-statusline.json
node "$tmp/seg.js" | sed -E 's/\x1b\[[0-9;]*m//g'
test -f .claude-flow/cache/qe-statusline.json && echo "cache written ✓"
# Second render within TTL must reuse cache: stamp cache mtime, render, confirm mtime unchanged (no rewrite path on hit):
before=$(stat -f %m .claude-flow/cache/qe-statusline.json 2>/dev/null || stat -c %Y .claude-flow/cache/qe-statusline.json)
node "$tmp/seg.js" >/dev/null
after=$(stat -f %m .claude-flow/cache/qe-statusline.json 2>/dev/null || stat -c %Y .claude-flow/cache/qe-statusline.json)
[ "$before" = "$after" ] && echo "cache HIT on 2nd render (no rewrite) ✓" || echo "⚠ cache not hit"
rm -rf "$tmp"
```
Expected: `node --check OK`, a footer line containing `🎓 Agentic QE` with `patterns`/`traj`/`vec`/the DB size, `cache written ✓`, and `cache HIT on 2nd render (no rewrite) ✓`.

- [ ] **Step 5: Commit**

```bash
git add shell/ruflo-functions.sh
git commit -m "fix(statusline): TTL-cache QE footer + single .bail-off sqlite3 spawn on miss (#3)"
```

---

## Task 3: parity-test stops its own daemon on exit

**Files:**
- Modify: `bin/ruflo-parity-test` (the `cleanup_on_exit` function, currently lines 83–95)

- [ ] **Step 1: Stop the test-workspace daemon in `cleanup_on_exit`**

Replace the `cleanup_on_exit()` function body so the daemon bound to `$TEST_DIR`
is stopped on **every** exit path (success, failure, INT/TERM), regardless of
`--keep`/`--cleanup` (the daemon is an orphan once the test ends either way):

```bash
cleanup_on_exit() {
	local rc=$?
	# Stop the daemon ruflo-setup-project started for this throwaway workspace
	# (issue #3) — orphaned whether or not we keep the dir, since the test is done.
	if [[ -n "${TEST_DIR:-}" ]]; then
		ps axww -o pid=,args= 2>/dev/null | while IFS= read -r line; do
			case "$line" in *"daemon start"*) ;; *) continue ;; esac
			case "$line" in *"--workspace $TEST_DIR"*) ;; *) continue ;; esac
			local pid=${line%% *}
			[[ -n "$pid" ]] && kill "$pid" 2>/dev/null && log "Stopped test daemon pid=$pid ($TEST_DIR)"
		done
	fi
	if (( FAIL == 0 && KEEP == 0 )) && [[ -n "${TEST_DIR:-}" && -d "$TEST_DIR" ]]; then
		rm -rf "$TEST_DIR"
		log ""
		log "Cleaned up $TEST_DIR (--cleanup, all checks passed)"
	elif [[ -n "${TEST_DIR:-}" && -d "$TEST_DIR" ]]; then
		log ""
		log "Test dir kept at: $TEST_DIR"
		[[ -n "$LOG_FILE" ]] && log "Full log:        $LOG_FILE"
	fi
	exit $rc
}
trap cleanup_on_exit EXIT INT TERM
```

- [ ] **Step 2: Syntax + lint check**

Run: `bash -n bin/ruflo-parity-test && echo OK`
Expected: `OK`

Run (if installed): `command -v shellcheck >/dev/null && shellcheck -S warning bin/ruflo-parity-test; echo "rc=$?"`
Expected: no new warnings.

- [ ] **Step 3: Commit**

```bash
git add bin/ruflo-parity-test
git commit -m "fix(parity-test): stop the throwaway-workspace daemon on exit (no orphans) (#3)"
```

---

## Task 4: uninstall.sh daemon teardown

**Files:**
- Modify: `uninstall.sh` (insert a new section between the `--this-project` block ending at line 153 and the npm-removal section starting at line 155)

- [ ] **Step 1: Insert the daemon-teardown section**

After the closing `fi` of the `--this-project` block (line 153) and before the
`# 6. (--remove-ruflo ...` comment (line 155), insert:

```bash
# 6. Daemon teardown (issue #3): always reap stale (workspace-gone) daemons;
#    with --this-project also stop the daemon bound to THIS repo's workspace.
#    Never touches unrelated live-workspace daemons.
echo ""
echo "## Daemon teardown"
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
			kill "$dpid" 2>/dev/null && ok "stopped daemon pid=$dpid ($reason): $dws" || warn "could not stop pid=$dpid"
		fi
	fi
done <<EOF
$(ps axww -o pid=,args= 2>/dev/null | while IFS= read -r line; do
	case "$line" in *"daemon start"*) ;; *) continue ;; esac
	case "$line" in *"--workspace "*) ;; *) continue ;; esac
	ws=${line#*--workspace }; ws=${ws%% --*}
	pid=${line%% *}
	[ -n "$pid" ] && [ -n "$ws" ] && printf '%s\t%s\n' "$pid" "$ws"
done)
EOF
if [ "$DAEMON_HITS" -eq 0 ]; then
	if [ "$THIS_PROJECT" -eq 1 ]; then
		ok "no daemons to stop (none stale; none for this project)"
	else
		ok "no stale daemons to stop"
	fi
fi
```

- [ ] **Step 2: Syntax + lint check**

Run: `bash -n uninstall.sh && echo OK`
Expected: `OK`

Run: `bash uninstall.sh --dry-run 2>&1 | sed -n '/## Daemon teardown/,/^## /p'`
Expected: the "Daemon teardown" section prints, showing `[dry-run] stop daemon ...` for any stale daemons, or `✓ no stale daemons to stop`. **Nothing is killed** (dry-run).

- [ ] **Step 3: Commit**

```bash
git add uninstall.sh
git commit -m "fix(uninstall): stop stale daemons (always) + this-project daemon (--this-project) (#3)"
```

---

## Task 5: Document daemon lifecycle + CLAUDE_CODE_TMPDIR workaround

**Files:**
- Modify: `docs/TROUBLESHOOTING.md` (append a new section)

- [ ] **Step 1: Read the end of the file to match style**

Run: `tail -30 docs/TROUBLESHOOTING.md`
Expected: see the heading style (`## ...`) and tone to match.

- [ ] **Step 2: Append the new section**

Append to `docs/TROUBLESHOOTING.md`:

```markdown
## Claude Code crashes with ENOSPC / orphan `ruflo daemon` processes pile up

**Symptom.** Claude Code dies mid-session with
`the temp filesystem at /private/tmp/claude-501/<project>/<uuid>/tasks is full
(0MB free)`, and/or `ps axww | grep "daemon start"` shows many `ruflo daemon`
processes — some pointed at `--workspace` directories that no longer exist
(e.g. `/tmp/test-*` from `ruflo-parity-test` runs). See issue #3.

**Why.** `ruflo-setup-project` starts a per-workspace `ruflo daemon` (this is what
makes self-learning continuous). Before this fix, nothing stopped them, so each
throwaway/removed workspace left a daemon running forever. Separately, the
statusline footer used to spawn several `sqlite3` subprocesses on every render;
that volume of captured subprocess output is what fills Claude Code's size-limited
sandbox `tasks` tmpfs.

**Fix is built in now.** The statusline footer caches its QE metrics
(`RUFLO_QE_STATUSLINE_TTL_MS`, default 60000ms) and makes at most one `sqlite3`
call per TTL window. The daemon start is idempotent per workspace, and orphans are
reaped.

**Reap existing orphans:**

```bash
ruflo-daemon-gc            # list daemons whose --workspace is gone
ruflo-daemon-gc --kill     # stop exactly those (live-project daemons untouched)
```

`uninstall.sh` also reaps stale daemons; `uninstall.sh --this-project` additionally
stops the current repo's daemon.

**If you run many hooks and still hit the tmpfs limit**, point Claude Code's
subprocess tmpdir at your main filesystem (more space than the sandbox tmpfs) by
adding to `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_TMPDIR": "/Users/<you>/tmp/claude-code" } }
```

Create the directory first (`mkdir -p ~/tmp/claude-code`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/TROUBLESHOOTING.md
git commit -m "docs(troubleshooting): daemon lifecycle, ruflo-daemon-gc, CLAUDE_CODE_TMPDIR (#3)"
```

---

## Task 6: One-time cleanup of the existing orphan daemons on this machine

**Files:** none (operational step on the live machine; gated on user already approving "kill stale orphans now").

- [ ] **Step 1: Show the orphans (workspace gone) without killing**

Run:
```bash
zsh -c 'source shell/ruflo-functions.sh; ruflo-daemon-gc'
```
Expected: a list of `orphan daemon pid=... → /private/tmp/test-* (workspace gone)`
lines (the ~11 leftovers), and live-project daemons NOT listed.

- [ ] **Step 2: Kill exactly the orphans**

Run:
```bash
zsh -c 'source shell/ruflo-functions.sh; ruflo-daemon-gc --kill'
```
Expected: `✓ stopped orphan daemon pid=...` for each; live-project daemons remain.

- [ ] **Step 3: Verify live-project daemons survived**

Run:
```bash
ps axww -o pid=,args= | grep "daemon start" | grep -v grep | grep -c -- "--workspace /Users/"
ps axww -o pid=,args= | grep "daemon start" | grep -v grep | grep -c -- "--workspace /private/tmp/test-"
```
Expected: the first count > 0 (live projects kept), the second `0` (test orphans gone).

---

## Self-Review

**Spec coverage:**
- R1 (parity-test stops its daemon, every exit, regardless of `--keep`) → Task 3.
- R2 (idempotent daemon start) → Task 1 Step 2.
- R3 (`ruflo-daemon-gc` list/`--kill`, no-op when none) → Task 1 Step 1.
- R4 (uninstall stops stale always + this-project) → Task 4.
- R5 (statusline TTL cache + single `.bail off` spawn + `e.stdout` recovery + identical output) → Task 2.
- R6 (defensive `autoStart:false` only if present and true) → Task 1 Step 3.
- R7 (one-time cleanup, workspace-gone only) → Task 6.
- R8 (docs: lifecycle + `CLAUDE_CODE_TMPDIR`) → Task 5.
- R9 (`bash -n`, `shellcheck`, `node --check`) → Tasks 1/2/3/4 verification steps.

**Placeholder scan:** none — every code step contains the literal content.

**Type/name consistency:** `_ruflo_daemon_list` (tab-separated `pid\tworkspace`) is consumed by `ruflo-daemon-gc` and the idempotent-start `awk -F'\t'` identically; `uninstall.sh` and `ruflo-parity-test` inline the same `ps axww` parse (they don't source the functions). Cache file path `.claude-flow/cache/qe-statusline.json` and env var `RUFLO_QE_STATUSLINE_TTL_MS` are used consistently in Task 2 and Task 5.
