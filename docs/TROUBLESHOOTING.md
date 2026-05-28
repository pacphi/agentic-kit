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

## Reset a project's ruflo state entirely

```bash
ruflo cleanup --force               # remove ruflo artifacts (dry-run by default)
rm -rf .swarm .claude-flow .mcp.json
ruflo-setup-project                 # re-create cleanly
```
