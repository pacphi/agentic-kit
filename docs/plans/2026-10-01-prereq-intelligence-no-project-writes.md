# Prerequisite B: stop the Intelligence view writing into projects

## Status

**Active**, not started. This is a prerequisite of
[Project-scoped management only](2026-10-01-project-scope-only-design.md#prerequisites). It lands
on `main` before P0, so it also ships in the exit release.

## Problem

Opening **Overview → Intelligence** in the dashboard writes a file into another repository's
working tree. About three seconds after the view opens, the live watcher appends a sample to
`<project>/.claude-flow/health-history.json`. The project is whichever learning project the view
has selected. With no explicit selection, that is the most recently used project on the machine.

The project can be any repository the user has opened with an agent, including ones agentic-kit
never set up. It can also be the home folder itself, when Ruflo's user-level state in
`~/.claude-flow` counts as a learning project.

The file is purely agentic-kit's own derived data: no upstream tool writes or reads it. Keeping it
in projects:

- makes "viewing" a mutation;
- leaves a `.bak` beside it;
- shows up as an untracked file in a repository that doesn't ignore `.claude-flow/`.

## Evidence

### Write path

| Step | Where |
| --- | --- |
| The dashboard builds a watcher for the selected project, passing only `cwd` and `onUpdate`, with no `onError`, so write failures are silently swallowed | `src/lib/dashboard-server.mjs:1335-1341`, `src/lib/live/intelligence-watch.mjs:116` |
| The SSE route selects the project: an explicit `?project=` match, otherwise `projects[0]`, the most recently active | `dashboard-server.mjs:1601-1668`, `:231-238` |
| Projects come from the census `learning` scope (`.claude-flow`, `.agentic-qe` or `.swarm` present), cached for 60 s | `dashboard-server.mjs:280-294`, `src/lib/project-census.mjs:53-57,204-207` |
| User learning roots are `$HOME`, `~/.claude`, `~/.codex`, the OpenCode and agentic-kit config folders. A row at one of these gets `learningScope: 'user'`, and its path is that root | `project-census.mjs:100,133-145` |
| The watcher polls every 1 s, debounces 2.5 s, then flushes. The first flush appends whenever `.claude-flow/neural/stats.json` parses | `intelligence-watch.mjs:140-146,167-171,187-211` |
| The flush calls `appendHealthSnapshot(this.#cwd, {ts, ...globalStats})` | `intelligence-watch.mjs:204-207` |
| `appendHealthSnapshot` writes `<cwd>/.claude-flow/health-history.json` through `writeJsonWithBackup`, which uses `mkdir -p`, keeps a one-time `.bak`, and does an atomic replace | `src/lib/dashboard/intel-history.mjs:134-143`, `src/lib/settings.mjs:15-20`, `src/lib/file-write.mjs:28-52` |

### The data

- Each sample is `{ ts, patternsLearned, trajectoriesRecorded, signalsProcessed, lastAdaptation }`.
- The ring keeps up to 500 samples (`HEALTH_RING_CAP`) and is deduplicated on every field except
  `ts` (`intel-history.mjs:20,117-121`).
- **Only reader:** `readIntelHistory` (`intel-history.mjs:96-101,149-156`), which feeds the
  **patterns learned** sparkline. The sparkline needs at least two samples
  (`src/lib/dashboard/client/overview.mjs:137,186,222-254`).
- **Not a reader:** the statusline footer never reads this file.
- **Unrelated:** `src/lib/health-history.mjs`, which is `kit.json`'s `ak sync` health ring.

### Documentation that records the behaviour

- ADR-0024:113-114, 125-128, 184-186 and 232-234.
- `docs/ddd/project-intelligence.md:123,187-192,207-209,253`.
- `docs/ddd/context-map.md:192-195`.
- The header of `intel-history.mjs:4-6` says this module "only reads (and, for the health ring,
  appends to)" files "this project's own ruflo/agentic-qe tooling already writes". That is
  inaccurate: only agentic-kit writes the ring.

## Fix

Move the ring into agentic-kit's own cache. A view then reads project files but never writes
them.

1. **Add a cache base to `src/lib/paths.mjs`.**
   - `cacheBase()` resolves to `$XDG_CACHE_HOME` or `~/.cache` on macOS and Linux, and to
     `%LOCALAPPDATA%` on Windows, reusing `xdgBase` (`paths.mjs:14-17`).
   - `cacheDir()` is `cacheBase()/agentic-kit` on macOS and Linux, and
     `%LOCALAPPDATA%\agentic-kit\cache` on Windows, so it doesn't collide with `stateBase()`.
   - Three modules carry private copies of this logic: `footprint/consumers.mjs:170-173`,
     `footprint/storage-reclaim-detectors.mjs:26-29` and `footprint/install.mjs:579-583`. They
     measure *other* tools' caches and keep their own platform rules, so they are left alone.
   - The [project-scope design](2026-10-01-project-scope-only-design.md) makes this same folder the
     kit's cache, so the helper is not throwaway work.
2. **Store each project's ring at `cacheDir()/intel-history/<id>.json`.**
   - `<id>` is the first 16 hex characters of the SHA-256 of the project's canonical real path.
     The path is not the dashboard's `keyForProject`, because that key falls back to a label hash
     for non-git folders and two same-named folders could share a ring.
   - The file holds `{ project: <canonical path>, samples: [...] }`. A file whose `project` does
     not match is ignored and replaced.
   - Write it with `writePrivateFileAtomic` (`file-write.mjs:82`): mode 0600, atomic, no `.bak`.
     The cache is disposable.
3. **Read old history without writing it.** `readHealthRing` reads the cache ring first. If there
   is none, it reads the old `<project>/.claude-flow/health-history.json` read-only, so existing
   sparklines keep their history. The first append seeds the cache ring from those old samples. The
   old file is never written, moved or deleted, because it is in the user's project. The dashboard
   guide says it can be deleted by hand.
4. **Keep the interfaces.** `appendHealthSnapshot(cwd, snapshot)` and `readIntelHistory(cwd)` keep
   their signatures and resolve the cache path internally, so `IntelligenceWatch` and its
   injection points do not change.
5. **Stop swallowing errors.** The dashboard passes an `onError` that records watcher failures in
   the runtime debug log, so a failed write is no longer invisible.
6. **Correct the docs.**
   - The `intel-history.mjs` header comment.
   - ADR-0024: add an update note recording the move.
   - `docs/ddd/project-intelligence.md` and `docs/ddd/context-map.md`: the ring is agentic-kit's
     cached projection.
   - `docs/dashboard.md`: say where the ring lives, under "Local state and security", and that
     viewing reads project files only.

## Not in scope

These belong to the [project-scope design](2026-10-01-project-scope-only-design.md#dashboard-and-metrics):

- the default project selection;
- the census and project picker;
- the other writes the dashboard makes on reads: `kit.json` version checks, evidence records and
  the daemon-sweep evidence.

## Tests

- **`tests/kit/intel-history.test.mjs`**
  - `appendHealthSnapshot` at :183-223 asserts the cache path, the `{project, samples}` shape, the
    dedup, the 500 cap and the 0600 mode (skip the mode check on Windows).
  - It also asserts that the project folder is byte-identical afterwards, and that no
    `.claude-flow/` is created in an empty folder.
- **`tests/kit/intelligence-watch.test.mjs:335-367`** (end-to-end with the real readers): assert
  that the sample lands in the cache ring and that `<dir>/.claude-flow/health-history.json` does
  not exist.
- **Old-history fallback:** with only an old project ring present, reads return its samples, the
  first append seeds the cache with them plus the new sample, and the old file's bytes and mtime
  are unchanged.
- **Home as project:** under `sandboxHome()`, select a `learningScope: 'user'` row whose path is
  the sandbox home and has `~/.claude-flow/neural/stats.json`. Run a flush and assert that nothing
  under the sandbox home changed except the cache.
- **Mismatch:** a cache file whose `project` differs is ignored and replaced.
- **Isolation:** load `paths.mjs` with dynamic `import()` after `sandboxHome()`, because it reads
  `os.homedir()` when the module loads. Use `tempDir()` for project folders.
- **Unchanged and still passing:** `tests/kit/dashboard-intel-integration.test.mjs` and
  `tests/dashboard.test.cjs:355-400`.
- **Commands:** `node scripts/run-tests.mjs focus tests/kit/intel-history.test.mjs`, the same for
  `intelligence-watch.test.mjs`, then `pnpm test` and `pnpm run test:ui`.

## Acceptance criteria

- With the dashboard open on Intelligence for any project, including the home folder, no file
  under that project changes.
- The patterns-learned sparkline still shows existing history after upgrading, and grows from the
  cache afterwards.
- Watcher write failures appear in the runtime debug log.

## Relation to the project-scope design

This change establishes the design's second dashboard principle for the Intelligence view: viewing
never writes outside the cache. It is also the first user of the cache directory that the design
standardizes on. The design keeps this ring in the cache for every census project, because it is
derived observation data. `ak sync`'s own health history is a separate thing and moves to the
project's `.agentic-kit/state/`.
