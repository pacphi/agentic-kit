# ADR-0062 — AQE project store integrity

- **Status:** Accepted
- **Date:** 2026-09-27
- **Updated:** 2026-10-03 — AQE 3.14.5 fixed [agentic-qe#735](https://github.com/proffesor-for-testing/agentic-qe/issues/735) (`findProjectRoot()` now walks up to a `.git` or `package.json` boundary), so ak no longer writes the root pin described in §1: `ak sync` and `ak setup` write nothing new and release a pin an older ak wrote, the write and release mechanics stay so receipted pins keep releasing, and the `aqe-pin` status rows are retired. §1 and the rows that follow describe ak before this change.
- **Updated:** 2026-09-30 — [private released 3.14.6 real-MCP lock proof](../archive/2026-09-30-aqe-m1-mcp-lock-proof.md) preserves patterns.rvf/sidecar bytes and confirms packed-kit busy startup on macOS. Full shutdown conformance fails on omitted shared-adapter cleanup; store merge, installed-target convergence and Windows remain unproved by this receipt
- **Updated:** 2026-09-27 — adversarial review fixes: no pin in files git tracks (B5-M5), AQE's
  re-init value taken back, clean release; holder checks that time out refuse; nested repositories
  are not strays; stores fingerprinted at copy time; root checked before backup; applying receipt;
  starter patterns the root holds keep their usage
- **Updated:** 2026-09-29 — released AQE 3.14.4 passed native macOS and Linux live-owner conformance with `LockHeld` and no `FsyncFailed`; ak retired only the old exact `FsyncFailed`-as-busy exception in AQE startup classification. This is a verified baseline for that rule, not a universal AQE minimum. The 3.14.4 minimum below applies only to store merge. Native Windows AQE conformance remains unverified
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md) (project memory status and
  stray stores), [ADR-0055](0055-aqe-embedding-lifecycle.md) (the AQE embedding projections this
  pin sits beside), the
  [issues 237–239 audit record](../archive/2026-09-26-plan-issues-237-238-239-verification-and-decisions.md)
  (Addendum 3 items 2 and 3; decisions B5-D1 to B5-D5), upstream
  [agentic-qe#735](https://github.com/proffesor-for-testing/agentic-qe/issues/735),
  [#736](https://github.com/proffesor-for-testing/agentic-qe/issues/736) and
  [#753](https://github.com/proffesor-for-testing/agentic-qe/issues/753)

## Context

Agentic QE (AQE) keeps its learning in `<project>/.agentic-qe/memory.db`. A command, hook or MCP
server started in a subfolder made its own `.agentic-qe` there and kept writing to it
(agentic-qe#735). The project's hosts never read such a store. This repository held nine of them,
each carrying AQE's 70 starter patterns and 0 to 66 captured experiences (99 in total).

AQE 3.14.4 finds its store three ways, and each falls back to the working directory:

- the project root: `AQE_PROJECT_ROOT`, read only by `dist/kernel/project-root.js:43-44`;
- the memory database: `dist/learning/embedder-identity-store.js:26-30` uses `AQE_MEMORY_PATH` or
  `<cwd>/.agentic-qe/memory.db` and creates the folder (`:52-57`); it never reads the root. `aqe
  init` writes a relative `AQE_MEMORY_PATH=.agentic-qe/memory.db`;
- the storage folder: `dist/init/token-bootstrap.js:18` uses `AQE_STORAGE_PATH ?? '.agentic-qe'`.

In a disposable project, pinning the root alone still left a store in the subfolder, and pinning
the root and an absolute memory path still left an empty `.agentic-qe` there. With all three keys
pinned, no command, hook or MCP server created anything in the subfolder.

AQE's own tools can move the data: `aqe brain export --format jsonl` reads a store and
`aqe brain import` writes it in one transaction. On 3.14.4 the import skips patterns the target
already holds by `(name, qe_domain, pattern_type)` without aborting (agentic-qe#736 was filed
against 3.14.3). Two problems remain. AQE's writers take no lock a merge could wait on
(agentic-qe#753), and imported `witness_chain` rows are appended unlinked, which breaks the
target's audit chain at the first one.

## Decision

### 1. Pin AQE to the project root (B5-D1, B5-D1a, B5-D1b)

`ak sync` and `ak setup` write three keys as absolute paths:

- `AQE_PROJECT_ROOT`: the repository root, resolved with `realpath`;
- `AQE_MEMORY_PATH`: `<root>/.agentic-qe/memory.db`;
- `AQE_STORAGE_PATH`: `<root>/.agentic-qe`.

They go into four targets:

1. `.claude/settings.local.json` `env`;
2. the `.mcp.json` `mcpServers.agentic-qe.env`, only for AQE's own start commands;
3. the project `.codex/config.toml` `[mcp_servers.agentic-qe.env]`;
4. the same file's `[shell_environment_policy.set]`, which Codex applies to the commands and hooks
   it runs. It is pinned when the table exists or AQE is registered in the file.

The pin applies only inside a repository whose root has a `.agentic-qe` folder. The user-level
`~/.codex/config.toml` is never pinned, because it serves every project. A target file git tracks
(`.mcp.json`, the project `.codex/config.toml`; `git ls-files --error-unmatch`) is not pinned
either (maintainer decision B5-M5): a committed absolute path would point teammates' AQE at a path
that does not exist on their machines. A pin ak wrote before the file was tracked is released under
its receipt, and the `aqe-pin` status row is a hand fix naming the file.
`.claude/settings.local.json` is always pinned. Outside git, and for untracked files, the pin
applies as described.

Each target has a receipt (`<file>.agentic-kit-aqe-pin.json`; the shell table has its own,
`.codex/config.toml.agentic-kit-aqe-shell-pin.json`, because one receipt holds one table's keys).
`ak uninstall` restores what the receipts recorded; a table or a `settings.local.json` that ak
created and that the release leaves empty is removed, and ak keeps only its newest pin backup per
file. AQE's own relative `AQE_MEMORY_PATH` is replaced under the receipt, also when AQE writes it
back over ak's value (`aqe init --auto` after an AQE upgrade rewrites its Codex tables). AQE writes
no `AQE_STORAGE_PATH` into a config file, so that key has no AQE default to take back. Any other
value ak did not write is kept, and the `aqe-pin` status row reports it as a hand fix naming the
file. A pin naming another checkout's root (a copied
`.claude/settings.local.json`) warns the same way. `ak setup` releases the pin around its own
`aqe init` and writes it again afterwards.

AQE's database-free mode (`aqe init --no-database`, agentic-qe#533) sets
`AQE_MEMORY_BACKEND=memory` and still creates `.agentic-qe/config.yaml`, so the pin applies there
too. That is safe: the unified memory ignores `AQE_MEMORY_PATH` in that mode
(`dist/kernel/unified-memory.js:140-143`). In a disposable 3.14.4 project, `aqe health`,
`aqe learning stats` and the MCP server's `tools/list`, from the root and from a subfolder with the
pin, created no `memory.db` anywhere; without the pin the subfolder run created
`sub/.agentic-qe`. The one reader that ignores the backend, the endpoint embedder's identity store
(`dist/learning/embedder-identity-store.js`), opens `<cwd>/.agentic-qe/memory.db` without the pin,
so the pin moves that file to the root rather than creating it.

### 2. Check providers from the root without writing

`ak x verify providers` runs from `repoRoot(cwd)`: the AQE router file is the root's, and every
`aqe` and `ruflo` call runs in the root with the pin. `aqe health` runs with
`AQE_MEMORY_BACKEND=memory`, so the project's `memory.db` is not opened (3.14.4 still creates
`witness-keys/` in the root store folder when it is missing). Outside a repository the project
checks are skipped, and the command says so.

### 3. Merge stray stores with their own command (B5-D2)

`ak x aqe-store status` previews. `ak x aqe-store merge` is the same preview (a dry run) unless
`--yes`; `--dry-run` wins over `--yes`, and `--json` prints one object. The command is not a sync
step. The stray-store status row is a hand fix naming `ak x aqe-store merge --dry-run`.

The stray search stops at a folder that holds `.git` (a nested repository, a submodule, or a
worktree inside the checkout): that folder's `.agentic-qe` is its own repository's store, and the
preview reports it as skipped.

The merge runs these steps in order:

1. **Preview.** It copies the root and each stray store (`memory.db`, `-wal`, `-shm`) into
   `<run>/scratch` and counts there; no real store is opened, not even read-only. It records a
   fingerprint of each store as it copies it: the size and mtime of every file in a stray folder,
   and of the root's `memory.db` and a non-empty `-wal` (the backup's own read-only open creates an
   empty `-wal` and a `-shm` there). It runs `integrity_check` and `foreign_key_check` on the
   root's copy; a root that already fails refuses the merge before anything is written, naming the
   check. For each stray it reports patterns, experiences, audit-trail rows, patterns and
   experiences already in the root, AQE starter patterns left out and those the root holds, and the
   root's counts after a merge. A folder without `memory.db` is skipped and reported, and so is an
   earlier run whose receipt still says `applying`.
2. **Writers.** Refuse while any process holds the root or a stray store (§4).
3. **Backup.** `VACUUM INTO <run>/backup/root-memory.db`.
4. **Rehearsal.** On a copy of that backup, for each stray copy:
   - delete its `witness_chain` rows;
   - delete its AQE starter patterns (§6);
   - `aqe brain export --format jsonl`;
   - `aqe brain import --dry-run`, then the import.

   The counts must equal the preview's, `PRAGMA integrity_check` must be `ok` and
   `foreign_key_check` empty. AQE runs with its working directory and `AQE_PROJECT_ROOT` in the
   scratch folder. No duplicate-pruning step runs, because 3.14.4 skips shared patterns
   (agentic-qe#736).
5. **Apply.** Check writers again, and compare every fingerprint: a store that changed since its
   copy stops the merge here (the holder checks only see files open at that instant, and the
   exports come from the copies). Write the receipt with status `applying`, then run the same
   imports into the real root store, and check the counts against the rehearsal. On a mismatch it
   stops, leaves the strays and prints the backup and how to restore it. It never overwrites the
   live root automatically.
6. **Archive.** Check writers again, then move each whole stray folder (§5). A stray whose
   fingerprint changed during the import stays in place and is reported: its data may be newer
   than the copy.
7. **Receipt.** Write `<run>/receipt.json`: AQE version, holder method, before and after counts,
   the backup, the starter set, per stray the audit-trail rows, starter patterns left out and held
   by the root, experiences the root already held, and what was archived or left in place. An
   `applying` receipt left by an interrupted run is reported by `status` until a later merge of the
   same root completes and marks it `interrupted`.

The merge needs AQE 3.14.4 or later, read from the `aqe --version` it runs. A preview removes its
scratch folder; a successful merge removes `scratch/` and keeps the backup, archive and receipt; a
failure keeps everything.

### 4. Live writers: refuse, with no force (B5-D3)

The merge finds holders by open file: `lsof -Fpcn` on macOS, `/proc/*/fd` on Linux (lsof as a
fallback), for the current user's processes. It checks before the backup, before the real import
and before the archive. It refuses while any process holds a store, or when the check could not
complete (lsof missing, failed, or ended by a timeout or a signal; a `/proc` fd link that cannot
be read falls back to lsof), and lists each holder by PID and command. On Windows it runs only when the host-session
census finds no Claude Code, Codex or OpenCode session in the project, and a failed folder rename
(`EBUSY`, `EPERM`) leaves that stray in place and reports it. There is no `--force`: AQE's writers
take no lock the merge could wait on (agentic-qe#753).

### 5. Archive whole folders in ak's state and keep them (B5-D4)

Each stray `.agentic-qe` folder moves whole to
`<state>/agentic-kit/aqe-store-merge/<ISO time>/archive/<slug>/.agentic-qe`, beside the root backup
and the receipt. A slug never names a folder `.agentic-qe`: `docs/research/v5` becomes
`docs--research--v5`, and `.claude` becomes `dot-claude`. Across filesystems it copies, compares
every file's name and size, then removes the source; a removal that fails part-way is reported as
partially moved, naming the complete archive copy and the files left behind.

Audit-trail (`witness_chain`) rows are not imported; they stay in the archive with the store's
`witness-keys/`. ak keeps the archive until the user deletes it.
[TROUBLESHOOTING](../troubleshooting.md#restore-an-aqe-store-from-the-merge-archive) gives the
restore steps. Nothing ak writes lies inside any `.agentic-qe` folder, because AQE restores any
`memory*.db` over 1 MB it finds there when `memory.db` is missing (`dist/kernel/unified-memory.js`).

### 6. Leave AQE's starter patterns out (B5-D5)

Every AQE store carries the starter patterns AQE seeds on its first start. The root store no
longer holds most of them, so a merge would have put 56 back. The merge imports only experiences
and patterns that are not in AQE's starter set.

AQE does not expose that set without a store:

- 22 patterns are static (`dist/learning/pretrained-patterns.js:15`);
- the rest are cross-domain copies named `<name> (from <domain>)`
  (`dist/learning/pattern-promotion.js:198`), kept only when their embedding is not too close to a
  pattern already in the target domain (`:183-190`). So the set depends on the embedder;
- `aqe init --minimal` alone seeds nothing (`dist/init/phases/05-learning.js:76-97`); the
  reasoning bank seeds on its first start (`dist/learning/qe-reasoning-bank.js:147-160`).

So at merge time ak builds a fresh store in `<run>/scratch/seed`:

- `aqe init --auto --minimal`, then `aqe learning stats --json`;
- the working directory, `AQE_PROJECT_ROOT`, the memory path, and npm's prefix and cache all lie
  inside the scratch folder;
- the project's `AQE_EMBEDDER_*` keys come from `.claude/settings.local.json`, then
  `.claude/settings.json`, then the `.mcp.json` AQE entry.

That store's patterns are the starter set, matched by `(name, qe_domain, pattern_type)`. Each
stray's scratch copy loses the starter patterns the root does not hold before export, together
with the rows that must reference them (a `*pattern_id` column that is `NOT NULL` or a foreign key
to `qe_patterns`, `pattern_relationships.target_pattern_id` included); nullable references such as
`concept_nodes.pattern_id` are cleared. A starter pattern the root already holds stays in the
export: AQE's import keeps the root's pattern and remaps the stray's usage and lineage rows onto it
(`dist/integrations/ruvector/brain-shared.js` `mergeGenericRow`, `remapPatternReferences`). When the fresh store cannot be built or holds no patterns (AQE stores none
without a working embedder), the merge refuses before the backup. There is no opt-in flag. The
archived strays keep their starter patterns.

## Consequences

- One AQE store per project. A subfolder run writes to the root store.
- The nine strays can be merged: on read-only copies on 2026-09-27, the root would go from 363 to
  363 patterns and from 5,333 to 5,432 experiences, with 70 starter patterns left out per stray.
  The merge refuses today, because the maintainer's two AQE MCP servers hold the root store.
- After the pin, `aqe status` and `aqe health` print "not initialized" from a subfolder, because
  AQE checks the working directory (`dist/cli/index.js:140-152`). Run them from the root.
- `ak x aqe-store status` is not free: it copies the whole root store and every stray store into
  ak's state folder, runs `aqe init --auto --minimal` and `aqe learning stats --json` there (the
  init runs `npm exec ruflo --version`, which may reach the npm registry; without an endpoint
  embedder AQE's in-process embedder may download its model, not verified), and removes the copies
  when it finishes.

## Removal conditions

- **Pin:** a released AQE resolves its root, memory database and storage folder from a subfolder
  (agentic-qe#735).
- **Writer refusal:** a released AQE appends to the witness chain atomically (agentic-qe#753). The
  refusal stays as long as the witness-row deletion does.
- **Duplicate pruning:** none is carried. If a later AQE aborts on shared patterns again
  (agentic-qe#736), the rehearsal fails before the real import.

## Implementation

Branch `fix/aqe-store-integrity`:

- pin: `0296c6c9`, `abe3d75e`, `4ab63ed5`, `f0da2f6c` (`.gitignore` for receipts and backups);
- verify from the root: `2f13f043`;
- holders: `38ef6b44`, `f770c1f9`, `f84e97e8`;
- merge: `60618326`, `55848973`, `9442e831`;
- starter patterns: `a69f2729`;
- adversarial review fixes: `482b1ea5` (holder timeout), `3fbcc97c` (nested repositories),
  `a37edf2a` (AQE re-init), `88e76e71` (release leftovers), `70d7b070` (tracked files, B5-M5),
  `77c795e5` (root checks first), `a4980a7d` (fingerprints), `0d1e6075` (applying receipt),
  `e11de134` (starter usage, relationships), `cb2ec3c8` (experiences in the root), `9e6e36e9`
  (partial move), `cf99937d` (restore steps), `742021e0` (`ak setup` Codex message).
