# Troubleshooting

Symptom → diagnosis → fix for the common ruflo + Claude Code failure modes.

> **Baseline: ruflo 3.28.0 / agentic-qe 3.12.2 / Node 20–26 (2026-07-14).** The
> `≥3.10.6` version boundaries below still explain *why* each guard exists, but the
> current expectation is that you are on a recent ruflo where the historical
> data-loss / route / encoder / SONA / neural-status bugs are all fixed upstream.
> The kit's patchers are re-asserters against upgrade churn (see the npm
> `allow-scripts` entry), not the primary fix.

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
| 0 (Node ≥24, ruflo <3.10.6) | 0 | agentdb on buggy sql.js WASM | upgrade ruflo (≥3.10.6) or `ruflo-patch-native` |

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

### Node 24/26 WASM fallback (historically the root cause — fixed upstream in 3.10.6)

On **ruflo ≥3.10.6** this is handled by an upstream `better-sqlite3 ≥12.8.0` override
([#2219](https://github.com/ruvnet/ruflo/issues/2219)) — the agentdb copies resolve to
native v12 by default, and the override survives upgrades. So the first move is simply to
be on a current ruflo. The patch remains for **ruflo <3.10.6** (or as a re-assert):
```bash
ruflo --version                     # ≥3.10.6 means the override already applies
ruflo-patch-native --check          # reports "already native" when the override did its job
ruflo-patch-native                  # only needed on <3.10.6 (or to re-assert a stale binary)
```

## "✅ Using sql.js (WASM SQLite, no build tools required)" appears

That banner means a code path took the WASM fallback. On ruflo ≥3.10.6 you shouldn't see
it for memory/agentdb (the override forces native v12); if you do, you're likely on
ruflo <3.10.6, on **npm ≥ 11.17** (see next entry), or a stale binary → upgrade ruflo or
run `ruflo-patch-native`. (agentic-qe is separate — `ruflo-setup-aqe` repairs its native init.)

## After a global upgrade on npm ≥ 11.17, native addons fall back to WASM

**Symptom.** Right after `npm update -g` / `npm i -g ruflo@latest` (or `agentic-qe@latest`),
memory/learning act broken even though ruflo is ≥3.10.6. The upgrade printed
`npm warn allow-scripts   better-sqlite3@… (install: prebuild-install || node-gyp rebuild)`,
and `ruflo-patch-native --check` now reports **"needs patch"**. **Re-confirmed on the
2026-07-14 upgrade to ruflo 3.28.0:** `npm i -g ruflo@3.28.0` blocked the
better-sqlite3 / agentdb build scripts until re-run with `--allow-scripts=…`, so this
is still live on the current baseline — the `#2219` override alone does not defeat it.

**Why.** npm **11.17** introduced **`allow-scripts`**, which blocks packages' install /
postinstall lifecycle scripts by default. `better-sqlite3` builds (or downloads) its native
`.node` binary in an `install` script (`prebuild-install`), so the upgrade **skips it
silently** — even though ruflo's `#2219` override resolves `better-sqlite3` to a
prebuild-capable v12, the prebuilt is never fetched. ruflo then drops to buggy WASM. This
makes the kit's native patch **more** necessary after an upgrade, not less.

**Fix.**
```bash
ruflo-resync                        # runs ruflo-patch-native; installs the native binary
                                    # even under allow-scripts (verified on npm 11.17)
ruflo-patch-native --check          # expect "already native" afterward
```
Alternatively, allow the blocked builds globally before re-resolving:
`npm approve-scripts --allow-scripts-pending` (npm's own remedy), then `ruflo-resync`. The
kit's resync handles it without that step.

## `ruflo memory delete` says deleted but the row remains

Known WASM-backend bug. Delete via native sqlite3:
```bash
sqlite3 "$(pwd -P)/.swarm/memory.db" \
  "DELETE FROM memory_entries WHERE key='ns/key'; PRAGMA wal_checkpoint(TRUNCATE);"
```

## Choosing MCP tool families / opting out of the ruflo MCP

The ruflo MCP server is now **registered by default at user scope** under the key
`claude-flow` ([#2206](https://github.com/ruvnet/ruflo/issues/2206)) by
`ruflo-setup-machine`. This is a deliberate posture change: Claude Code now **defers
MCP tool schemas** (loads them on demand), so the old "keep MCP off to save ~84k
tokens/session" argument no longer applies — registration is nearly free at session
start.

`ruflo-setup-machine` shows a **tool-family inventory** (~276 tools across 35
families on 3.28) and lets you exclude families you don't want. Exclusions are
enforced as exact `mcp__claude-flow__<tool>` entries in `permissions.deny` in
`~/.claude/settings.json` — so the family is registered but those tools are denied.
Re-run `ruflo-setup-machine` to change the selection.

To opt out of the MCP server entirely:
```bash
ruflo-remove-mcp                    # removes the claude-flow key (and legacy `ruflo` key),
                                    # cleans up the permissions.deny rules it added
claude mcp list | grep -E 'claude-flow|ruflo'   # should be empty
```
(Restart Claude Code — MCP tool defs already loaded in a running session stay until
the session restarts.)

### A committed project `.mcp.json` with `ruv-swarm` / `flow-nexus` is still cruft
Independent of the user-scope registration, a per-project `.mcp.json` that `ruflo
init` would commit is unwanted: `ruv-swarm` is a subset of ruflo and `flow-nexus` is
auth-gated cloud SaaS. `ruflo-setup-project` **strips** these committed ruflo/ruv-swarm/
flow-nexus entries (upstream dedup [#1779](https://github.com/ruvnet/ruflo/issues/1779)
/ [#2612](https://github.com/ruvnet/ruflo/issues/2612) also skips writing one when the
user-scope registration already exists). If you find them committed, re-run
`ruflo-setup-project` or remove them by scope:
```bash
claude mcp list
claude mcp remove ruv-swarm  -s project
claude mcp remove flow-nexus -s project
```

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
> **Fixed on agentic-qe ≥3.12.1.** `aqe init` now **merges** `.claude/settings.json`
> non-destructively (one-time `settings.json.backup`; preserves a custom `statusLine`,
> preserves ruflo hooks — 3.11.5 used to strip them — and preserves user `AQE_*` env).
> So on the current 3.12.2 baseline it no longer clobbers your `statusLine.command` or
> your hooks. The fix below is retained only as **legacy healing** for projects that
> were initialized under aqe <3.12.1.

On aqe <3.12.1, `aqe init` repointed `.claude/settings.json` `statusLine.command` at
its own minimal `statusline-v3.cjs`, so Claude Code stopped rendering the rich
`statusline.cjs` (your footer was still patched in — just not the file being run).
Heal it:
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

### agentic-qe RVF FsyncFailed (silently OFF ruvector)
Symptom — every `aqe` start prints:
```
[RVF] Shared adapter init failed: RVF error 0x0303: FsyncFailed
```
agentic-qe looks fine (`aqe upgrade` shows `@ruvector/rvf-node ✓`, flags on) and
`.rvf` files exist, but the **live** shared RVF adapter never initializes — so aqe
silently runs on the SQLite/hnswlib fallback and is **not benefiting from ruvector**.

Root cause: a corrupt/oversized pattern store. A healthy per-repo `.agentic-qe/*.rvf`
is KB–MB; after a hard exit mid-write it can balloon to an absurd size (we found a
`patterns.rvf` at ~277 GB of real disk) that the next start cannot fsync. The store is
a *derived cache* rebuilt from `.agentic-qe/memory.db`, so deleting it is safe.

```bash
ruflo-verify-aqe            # assert AQE is on ruvector (rvf-node loaded + live init OK)
ruflo-verify-aqe --repair   # delete a corrupt/oversized .rvf first, then assert
```
`ruflo-setup-aqe` and `ruflo-resync` now run this repair automatically
(`_ruflo_aqe_repair_rvf`): any `.agentic-qe/*.rvf` over 2 GiB is deleted with its
`.idmap.json`/`.manifest.json`/`.lock` sidecars, and aqe rebuilds a fresh store on
next run. Tune or disable the cap with `RUFLO_AQE_RVF_MAX_BYTES` (bytes; `0` disables).

**Second FsyncFailed mode — a corrupt `.rvf.lock` (seen 2026-07-14).** A `.rvf.lock`
that contains the RVF magic bytes **`FLVR`** — store bytes written into the *lock* file
by an interrupted write (we found this with a 162-byte `brain.rvf`) — also triggers RVF
`0x0303: FsyncFailed`, and **aqe does not self-heal this one** (its "Removed stale lock
file … Retrying open" path only handles ordinary stale locks, not a lock whose contents
are RVF data). `_ruflo_aqe_repair_rvf` now **quarantines** such a lock together with the
truncated sibling `.rvf`, so `ruflo-verify-aqe --repair` (and the automatic repair in
`ruflo-setup-aqe` / `ruflo-resync`) clears it and aqe rebuilds the store on next run.
Genuinely stale locks with no RVF magic are still left alone for aqe to self-heal.

**Optional native:** `aqe upgrade` may flag `@ruvector/solver-node` as missing
(sublinear PageRank falls back to TypeScript power iteration, fine for <50K nodes).
`install.sh --with-aqe`, `ruflo-resync`, and `ruflo-setup-aqe` best-effort install it.

## Security: `defend` prints only a banner on 3.28.0 / `cve --list` is empty

```bash
ruflo-security-verify               # verifies scan/defend/secrets; diagnoses the defend failure
ruflo-resync                        # heals it (reinstalls the dropped aidefence package)
```
- **`ruflo security defend` is silently non-functional on a bare ruflo 3.28.0
  install** ([ruvnet/ruflo#2670](https://github.com/ruvnet/ruflo/issues/2670)): it
  prints only its AIDefence banner, completes in ~0ms, and emits **no verdict** with
  an inconsistent exit code. Root cause: 3.28 **dropped `@claude-flow/aidefence`
  from the dependency tree while defend still `import`s it** — and the "package not
  installed" error message is swallowed, so nothing tells you. (This is NOT an
  absorption: `@claude-flow/security` has no detection API.)
- **Fix:** `ruflo-resync` installs `@claude-flow/aidefence --no-save` into the
  global ruflo tree (`_ruflo_ensure_aidefence`), verified to restore correct
  behavior — exit 1=threat / 0=clean, threat report rendered. The long-standing
  *cosmetic* `'color'` render crash after the verdict returns with it; the
  verdict/exit code are correct. Re-run resync after every `npm i -g ruflo` (the
  `--no-save` install is wiped by upgrades).
- The statusline `🛡 aidefence on` segment probes this package specifically — no
  shield showing on 3.28 means defend is broken; resync brings both back.
- `ruflo security cve --list` has **no CVE database** configured. Use `npm audit`
  for dependency CVEs.

## Billing-aware QE (agentic-qe 3.12.2)

agentic-qe can run its QE work on your Claude subscription instead of a metered API
key, and cap spend fleet-wide:
```bash
export AQE_LLM_PROVIDER=claude-code   # run QE via `claude -p` on a Claude subscription
                                      # (alternative: cognitum)
export AQE_MAX_BUDGET_USD=5           # or pass --max-budget-usd; a fleet-wide spend cap
aqe health                            # has an "LLM Billing" section showing provider + spend
```
These are **runtime knobs** — `aqe init` never writes them, so set them in your shell
or environment. (aqe 3.12.0 also added an `aqe quality-gate` CLI and the
`qe/quality/gate` MCP tool.)

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
(e.g. `/tmp/test-*` from `ruflo-parity-test` runs). Tracked in issue #3 (resolved).

**Why.** Historically `ruflo-setup-project` auto-started a per-workspace `ruflo
daemon` and nothing ever stopped it, so each onboarded (or throwaway) workspace left
a daemon running forever — and, more importantly, that daemon kept spawning
**token-spending AI worker sessions** (see the
[token-consumption incident](archive/2026-06-token-consumption-incident.md) and
[recurrence](archive/2026-06-11-token-consumption-recurrence.md)).
Separately, the statusline footer used to spawn several `sqlite3` subprocesses on
every render; that volume of captured subprocess output is what fills Claude Code's
size-limited sandbox `tasks` tmpfs.

**Current posture (daemons default-on, local-only, $0).** The runaway *cost* problem
was decoupled from the daemon's *existence*. Daemons are now **default-on with
local-only workers that spend no tokens** — `ruflo-setup-project` starts one, and
that's expected (one daemon per active project). **Token-spending AI workers are
opt-in** (`RUFLO_DAEMON_AI_WORKERS=1`, or `ruflo daemon start --headless`), and even
then they run under ruflo 3.27/3.28's **machine-wide launch budget**
([#2661](https://github.com/ruvnet/ruflo/issues/2661)) — defaults **1 concurrent /
2 per hour / 12 per day** (`RUFLO_AI_MAX_CONCURRENT` / `RUFLO_AI_MAX_PER_HOUR` /
`RUFLO_AI_MAX_PER_DAY`):
```bash
ruflo daemon budget show            # current AI-worker launch budget + usage
ruflo daemon budget pause           # stop launching AI workers
ruflo daemon budget resume
ruflo daemon stop --all             # stop every daemon on the machine
```
Native daemons are also TTL-reaped (`RUFLO_DAEMON_TTL_SECS`, default 12h,
[#2356](https://github.com/ruvnet/ruflo/issues/2356)). The statusline footer caches
its QE metrics (`RUFLO_QE_STATUSLINE_TTL_MS`, default 60000ms) — at most one
`sqlite3` call per TTL window — which is what fixed the tmpfs pressure.

**The kit's reapers remain as an independent safety net** on top of the upstream
controls: `ruflo-daemon-gc` + an auto-reaper on interactive shell start clean up
daemons that are orphaned (workspace gone) or past the TTL, and a running count shows
as `⚙ N ruflo daemons` in the statusline (**now yellow at ≥4**, since one daemon per
active project is normal).

**Inspect / reap daemons:**

```bash
ruflo-daemon-gc            # list STALE daemons (orphaned OR older than the TTL)
ruflo-daemon-gc --kill     # stop exactly those (live-project daemons within TTL untouched)
ruflo-token-audit          # see whether daemons are inflating your token usage
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
