# RuvNet Brain 4.5.9 verification receipt (2026-10-05)

Capture: 2026-10-05. Documentation basis: `a0932481a61004571926cfd5606a621f893a8c30`. The
installed Brain on the machine was 4.5.2 and was only read. Every run happened in a disposable
folder outside any repository, with `HOME`, the four `XDG_*` folders, `TMPDIR`, the npm cache and
prefix and `RUVNET_BRAIN_KB` all inside it, and the releases were acquired as npm tarballs
(4.3.28, 6 MB; 4.5.9, 11.7 MB unpacked), never through the installer against the real cache. The
multi-gigabyte knowledge base was not downloaded. Each issue was reproduced on an older baseline
and then rerun with the same fixture on 4.5.9. macOS only.

## Results

| Issue | Verdict | Observation |
| --- | --- | --- |
| [#329](https://github.com/stuinfla/ruvnet-brain/issues/329) nested `.swarm/.swarm` | Fixed in 4.5.2 or earlier (not bisected) | The progression store driver run three times in a git project, with Ruflo 3.51.1. On 4.3.28 it created `.swarm/.swarm/agentdb-memory.db`, `.swarm/.claude-flow/policy/state.json` and `.swarm/ruvector.db`. On 4.5.2 and 4.5.9 only the canonical `.swarm/memory.db` appears. Each Ruflo call gets a throwaway working folder and an explicit `--path` (`plugin/scripts/project-progression-store.mjs`, about lines 337, 412 and 435). The migration that cleans up artifacts older versions left was not tested. |
| [#330](https://github.com/stuinfla/ruvnet-brain/issues/330) capacity advisory while the Brain is off | Fixed in 4.5.9 (4.5.2 still fails) | With the `brain-off` sentinel, `capacity-aware-parallel-work` printed 762 bytes on 4.3.28, 968 bytes on 4.5.2 and 0 bytes on 4.5.9. `scripts/hook-shim.mjs` declares `offBehavior: 'run'` in 4.5.2 (line 89) and `'silence'` in 4.5.9 (line 90), and exits at line 199. Versions 4.5.3 to 4.5.8 were not tested; the upstream maintainer says 4.5.7. |
| [#331](https://github.com/stuinfla/ruvnet-brain/issues/331) `--update` keeps the stale updater | Fixed in 4.5.2 or earlier (not bisected) | With a 4.3.22 private-overlay fixture and a local mock release manifest, 4.3.28 `bin/install.mjs --update` exited 1 on "private overlay preflight failed: symbolic link is not a governed regular file". On 4.5.2 and 4.5.9 the updater is replaced from the package copy (`placeUpdater()`, `bin/install.mjs` about lines 609 to 621) and the preflight passes. A full successful update was not run (the bundle is 683 MB). |
| [#335](https://github.com/stuinfla/ruvnet-brain/issues/335) `forge-update` stuck | Open, partly addressed | 4.5.9 fixes the unsafe cleanup classifier, including the `.big` sidecar naming defect. Cross-snapshot reclamation and unresolved-backup handling remain, and there is no reclaim or prune command (`--clean` exists). |
