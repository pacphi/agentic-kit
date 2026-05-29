# Troubleshooting

Symptom → diagnosis → fix for the common ruflo + Claude Code failure modes.

## "store says OK but reads return 0 entries"

This is the headline symptom and has several causes. Disambiguate with native
`sqlite3` (which replays the WAL) against the **resolved absolute** DB path:

```bash
sqlite3 "$(pwd -P)/.swarm/memory.db" "SELECT COUNT(*) FROM memory_entries"
ls -l .swarm/memory.db .swarm/memory.db-wal
```

| Native sqlite3 count | WAL size vs main DB | Cause | Fix |
|---|---|---|---|
| > 0 | WAL **<** main | Data exists; ruflo read hit a different DB → **cwd drift** | Pin `CLAUDE_FLOW_DB_PATH` (absolute) |
| > 0 | WAL **>** main | Data only in WAL; WASM reader can't replay it → **WAL blindness** | `ruflo-memory-checkpoint` |
| 0 | 0 | Write never landed → **broken env var** or **Node-version/WASM** | see below |
| 0 (Node ≥24) | 0 | agentdb on buggy sql.js WASM | `ruflo-patch-native` |

### cwd drift
Each Claude Code Bash call may run in a different cwd. Pin the DB:
`ruflo-setup-project` writes an absolute `CLAUDE_FLOW_DB_PATH` into
`.claude/settings.local.json`. Verify it's absolute (not `${CLAUDE_PROJECT_DIR}`):
```bash
cat .claude/settings.local.json    # must show /abs/path/.swarm/memory.db
```

### `${CLAUDE_PROJECT_DIR}` literal
If `settings.local.json` contains `"${CLAUDE_PROJECT_DIR}/.swarm/memory.db"`,
Claude Code does **not** expand it; ruflo silently fails the write. Re-run
`ruflo-setup-project` (it heals the value) or hand-edit to an absolute path.

### WAL blindness
```bash
ruflo-memory-checkpoint              # PRAGMA wal_checkpoint(TRUNCATE) on cwd DB
ruflo-memory-checkpoint /path/db     # explicit
```

### Node 24/26 WASM fallback (the root cause)
```bash
ruflo-patch-native --check          # is agentdb on WASM?
ruflo-patch-native                  # patch to native better-sqlite3@^12
```
Re-run after every `npm install -g ruflo`.

## "✅ Using sql.js (WASM SQLite, no build tools required)" appears

That banner means a code path took the WASM fallback. Fine on Node ≤22 only if
it's actually native (it won't print then). On Node ≥24 it signals the buggy
path → `ruflo-patch-native`.

## `ruflo memory delete` says deleted but the row remains

Known WASM-backend bug. Delete via native sqlite3:
```bash
sqlite3 "$(pwd -P)/.swarm/memory.db" \
  "DELETE FROM memory_entries WHERE key='ns/key'; PRAGMA wal_checkpoint(TRUNCATE);"
```

## `/mcp` still shows ruflo after `ruflo-remove-mcp`

`ruflo init --start-all` registers ruflo at **local** scope per project. Old
`ruflo-remove-mcp` versions only hit user scope. This kit's version removes all
scopes:
```bash
ruflo-remove-mcp                    # user + local + project
claude mcp list | grep ruflo        # should be empty
```
(Restart Claude Code — MCP tool defs already loaded in a running session stay
until the session restarts.)

## Context feels huge at session start

Likely duplicate/unused MCP servers. `claude-flow` == `ruflo`; `ruv-swarm` is a
subset; `flow-nexus` is auth-gated cloud SaaS.
```bash
claude mcp list
claude mcp remove claude-flow -s <scope>
claude mcp remove ruv-swarm  -s <scope>
claude mcp remove flow-nexus -s <scope>
```
Keep ruflo at **user** scope only (or none, CLI-only).

## `ruflo-patch-native` reports "still not native" after patching

The prebuilt fetch may have failed (network) or your Node ABI has no v12
prebuilt yet. Check:
```bash
node -e 'console.log("ABI", process.versions.modules)'
npm view better-sqlite3 versions --json | tail
```
Fall back to Node 22 LTS (`mise install node@22`) where the native path resolves
without patching.

## Everything looks wired but you want proof

```bash
ruflo-parity-test                   # 20 checks in an isolated /tmp dir; keeps it on failure
ruflo-parity-test --cleanup         # remove the dir on success
ruflo-parity-test --verbose         # print every CLI call
```

## Self-learning dormant (`ruflo neural status` shows "Using sql.js" / HNSW "Not loaded")

The dominant cause is the same missing native better-sqlite3 binary as the memory
bug. Enable and verify:
```bash
ruflo-enable-learning               # patch native bsq3 + assert real capability (5 probes)
ruflo-learning-verify               # train in a temp dir; assert patterns 0 -> N persist
```
`ruflo-enable-learning` re-runs `ruflo-patch-native`, so re-run it after every
`npm install -g ruflo`. **Simplest after any upgrade:** `ruflo-resync` (one command
that does enable-learning + agentic-qe native repair + statusline footer; `--aqe`
also refreshes QE skills).

### Status-line activation footer missing after an upgrade
`ruflo init` (run by upgrades/`ruflo-setup-project`) regenerates `statusline.cjs`
without the footer. Re-apply: `ruflo-resync` (or `ruflo-fix-statusline-version`
directly). The footer is append-only and the patcher is upgrade-safe — it strips any
stale block and re-injects.

### Status line shows a bare "▊ Agentic QE v3" line (footer hidden after `aqe init`)
`aqe init` repoints `.claude/settings.json` `statusLine.command` at its own minimal
`statusline-v3.cjs`, so Claude Code stops rendering the rich `statusline.cjs` (your
footer is still patched in — just not the file being run). Fix:
```bash
ruflo-resync            # or: ruflo-fix-statusline-version
```
This re-points `settings.json` so `statusline.cjs` is primary (falling back to
`statusline-v3.cjs`, then a literal). The status line refreshes within ~5s, or restart
Claude Code.

### "@ruvector/core not available" persists even after the patch
This line in `ruflo neural status` is usually **cosmetic**, not real dormancy.
`getHNSWStatus()` (`memory-initializer.js`) reports "available" only if a lazy
`_bridge`/`hnswIndex` singleton was initialized *in that process*; the status
command never triggers it. `@ruvector/core` actually loads and exposes `VectorDb`.
`ruflo-enable-learning` proves the real capability (it loads core/sona/gnn directly);
trust its 5/5 over the status display. To confirm the loop end-to-end, run
`ruflo-learning-verify` (it asserts `.claude-flow/neural/patterns.json` grows).

If `ruflo-enable-learning` itself shows a ruvector probe red (not just the status
line), it auto-runs a guarded repair (`npm install @ruvector/<pkg>` into
`@claude-flow/neural`). If a probe is *still* red after that, the native `.node` for
your arch/ABI may be genuinely missing — fall back to Node 22 LTS.

## `aqe init` fails at "Initialize persistence database" (Node ≥24)

agentic-qe depends on `better-sqlite3@^12` directly and ships without the prebuilt
`.node` on Node 24/26 (same class of bug as ruflo). `ruflo-setup-aqe` installs the
native binary into the global `agentic-qe` before initializing:
```bash
ruflo-setup-aqe                     # native-bsq3 repair + aqe init --auto + half-init repair
```

### agentic-qe half-init (SDK db present, skills missing)
If `.agentic-qe/memory.db` exists but `.claude/skills/agentic-quality-engineering`
does not, init only half-completed. `ruflo-setup-aqe` detects this and re-runs with
`--upgrade`. Force a full reinit with `ruflo-setup-aqe --force`.

## Security: `defend` prints a "color" crash / `cve --list` is empty

```bash
ruflo-security-verify               # verifies scan/defend/secrets + aidefence load
```
- `ruflo security defend` **detects** injection correctly (exit 1=threat, 0=clean)
  but has an upstream cosmetic render crash (`Cannot read properties of undefined
  (reading 'color')`) *after* the verdict — the exit code is still right, so
  `ruflo-security-verify` keys off it.
- `ruflo security cve --list` has **no CVE database** configured. Use `npm audit`
  for dependency CVEs.

## Reset a project's ruflo state entirely

```bash
ruflo cleanup --force               # remove ruflo artifacts (dry-run by default)
rm -rf .swarm .claude-flow .mcp.json
ruflo-setup-project                 # re-create cleanly
```

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
