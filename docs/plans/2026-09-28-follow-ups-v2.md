# Follow ups v2: V4 branch plan

**Status:** Active. **Branch:** `fix/follow-ups-v2`. **Exact base:** `e2f9dcae0554ff63921df618a819fd5e6afe80d2` (develop bootstrap #272).

Source contract: [remediation program V4](2026-09-28-remediation-program-v2.md#v4-fixfollow-ups-v2-every-small-product-cli-and-upstream-item) and the archived Branch 9 plan. Each row is a separate test-first unit commit. This dispatch implements B1 only; later rows require controller review and assignment. File and test mappings below are intended scope, subject to source inspection when a row starts.

| Row | Likely files | Proof and prerequisite |
| --- | --- | --- |
| A1 | `bin/agentic-kit.mjs`, `src/commands/{usage,models,host,audit,heal,telemetry,x}*` | CLI `--json` error tests; 6b parked item 2 |
| A2 | `src/commands/host*` | host dry-run JSON refusal/off/reset tests; m-4 |
| A3 | self-drift module, `docs/adr/ADR-0063*` | offline TTL edge tests; reconcile ADR path |
| A4 | refresh service/collector module | injected `refreshStages` and `service` test proves no collector |
| B1 | `src/lib/paths.mjs`, XDG readers listed in B1 brief, `tests/kit/xdg-relative.test.mjs` | relative XDG path, child process and source guard RED/GREEN; exact-head CI gate |
| B2 | `src/commands/x/{daemon-gc,host}.mjs`, `src/commands/setup.mjs` | repaired evidence re-record tests; Branch 9 Task 8 |
| B3 | Ruflo memory path module, `src/lib/paths.mjs` | dual-reason and equality boundary tests |
| B4 | N4 target per D-4 | D-4 decision first; corresponding focused test |
| B5 | AQE stray scan and Codex MCP hint modules | dot-folder, home-store and hint tests; upstream #757 |
| B6 | Ruflo component status module | applied row test; hooks row only after #3419 answer |
| B7 | daemon settings sync/config modules | dry-run/live parity and hidden YAML tests; F6/F7 |
| B8 | maintenance pause module | restart while paused test |
| B9 | process tree termination module | abort tree test; Windows CI required |
| B10 | persisted file-ID comparison modules | large ID serialization tests; identify all sites first |
| B11 | deja-vu module and temp-folder checks | skipped verdict and cleanup tests |
| B12 | setup probe module | disposable real Ruflo reproduction first; fix only if confirmed |
| B13 | sync AQE pin module | §2 step 2 evidence first; fix only if sync missed pin |
| C1 | temporary CI workflow, upstream registry | disposable Linux/Windows busy-rule and memory-routing live tests; remove temporary job |
| C2 | `docs/HOST-SUPPORT.md` | verify AQE 3.14.4 and live upstream #2356/#420 evidence |
| C3 | nightly workflow, `trace-ort.mjs` | artifact test; user approves exact log text before external post |
| C4 | upstream watch scripts, registry | N-5 M7/M8/minors tests; inspect deferred-minors report; M10 declined |
| C5 | upstream issue draft | D-6 A decision; user approves exact text before post; B0-16 only if D-16 B |
| C6 | support evidence/report | newest supported Ruflo, Codex, AQE releases at pre-PR check |

For B1: preserve OpenCode's nullable fallback; use `xdgBase` for all source readers except the documented statusline template and manifest name list. Keep scratch homes disposable, unset `FORCE_COLOR`, use guarded focused tests, regression tests, typecheck and changed-file lint. Record RED/GREEN and self-review in the ignored task report. No shared manifests, ADR index or decision log changes.
