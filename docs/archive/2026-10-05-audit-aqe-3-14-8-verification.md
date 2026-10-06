# AQE 3.14.8 verification receipt (2026-10-05)

Capture: 2026-10-05 (local), about 01:30Z to 01:50Z on 2026-10-06. Kit checkout `5108035a`. The
runs used `agentic-qe@3.14.8`, installed with `npm install --prefix` into a disposable folder with
lifecycle scripts off, then `better-sqlite3` and `hnswlib-node` rebuilt there. Nothing on the machine
was upgraded. Registry integrity
`sha512-VCqf3p6epkFDHAUtvglYvJpzW8Ls7UjbDGMZKvApGCvOxVNAH/Hyw9rRTIUJxz52aexbuwQXeuCQkNeR0Ryp5A==`
matched the value recorded in the 3.14.7 receipt's addendum. macOS 27.0.1 arm64, Node v26.4.0. This is
a single platform; Linux and Windows were not run.

| Artifact | SHA-256 |
| --- | --- |
| `agentic-qe/package.json` | `54ae130d4ebfb5fa12c881e51514a8e3fd28019c672af0e195e51357fc4837a1` |
| AQE CLI entry | `6dc2ca98707ebec696b4427567fa0b9f018a3af8b04e8bd3ec33467d1fd664a6` |
| AQE MCP bundle | `8f69294b6d1dc56aab4a4a8d9055e20231a5ca051797a5cff77b4e82de9df2ac` |
| Packed kit `4.0.0-alpha.61` | `00d07e0021f21ea62f6bdce78b9daaed614fb2321f6e344e8955f32765b67025` |

Every command ran with a private `HOME`, the `XDG_*` variables unset and `AQE_PROJECT_ROOT` pointing
at a disposable project. The shell had `AQE_EMBEDDER_ENDPOINT` set; the embedding runs replaced it
with the local Ollama endpoint `http://127.0.0.1:11434` (model `Xenova/all-MiniLM-L6-v2`, 384
dimensions), and the others unset it.

## Results

| Thread | Result | Evidence |
| --- | --- | --- |
| [#801](https://github.com/proffesor-for-testing/agentic-qe/issues/801) | Pass | `AK_AQE_MCP_LOCK_LIVE=1 node scripts/run-tests.mjs exec -- --test tests/live/aqe-mcp-lock-conformance.test.mjs` ran 1 test, 0 skipped, and passed: the packed kit saw ordinary busy startup, `patterns.rvf` and its lock were byte-identical while the MCP held them, and the MCP exited 0 on stdin EOF with no watchdog and released its own lock marker. Upstream PRs 802 and 808 are contained in `v3.14.7` and `v3.14.8` and not in `v3.14.6`. |
| [#759](https://github.com/proffesor-for-testing/agentic-qe/issues/759) | Pass, with a correction to the ak premise | Upstream PR 766 is contained in `v3.14.5` and later. Two real AQE stores, built with `aqe brain witness-backfill` (root 3 rows, stray 4 rows, both `aqe audit verify --chain audit` valid), then `aqe brain export --format jsonl` of the stray and `aqe brain import` into the root: the root chain stays valid at 4 entries (its own 3 plus one `BRAIN_IMPORT` row), the stray's witness rows are skipped (import reports `Skipped: 4`), and the stray's patterns arrive. With the stray's witness rows deleted first, as `ak x aqe-store merge` does, the root chain is the same. So 3.14.5 and later never copy the stray's witness rows; they do not import them intact. |
| [#754](https://github.com/proffesor-for-testing/agentic-qe/issues/754) | Pass through the shipped bundle; ak's live check is not written | Upstream PR 768 is contained in `v3.14.5` and later. With the endpoint configured, `aqe hooks learn` then `aqe hooks search` returned the stored pattern first (56.6%, `Match: vector`), `patterns.rvf` was written, and `patterns.rvf.space.json` carries space id `589a68e6…0ee9dd`, the id the embedder probe computed from the same endpoint. With no endpoint, the same search refuses with `VECTOR_SPACE_UNVERIFIED` and falls back to lexical matching. `aqe learning embedding-health` still prints `unverified` with 71 mismatched vectors and "runtime not initialized", so that command cannot serve as the check. |
| [#535](https://github.com/proffesor-for-testing/agentic-qe/issues/535) | Fixed, one limitation | Over the MCP server on stdio, GOAP world status `fleet.activeAgents` reads 0 after `fleet_init` and 1 after `agent_spawn`. `test_generate_enhanced` for `export function add(a: number, b: number): number` returned `generationMode: "scaffolding"` with a skipped test and "0 supported named exports": it no longer emits wrong test code, but it generates no usable test for a plain exported function. The 3.14.7 receipt covered the other items. |

## What this means for open ak pull requests

- [#288](https://github.com/pacphi/agentic-kit/pull/288) probes the pattern index by importing
  AQE's unbundled `dist/learning/pattern-store.js`. In that load path
  `isRvfNativeAvailable()` is false (the adapter calls `require` from an ES module), so
  `createPatternStore()` returns the in-memory `PatternStore` and the probe reports
  `rvf-pattern-index-not-bound` even though the embedder check passes and the shipped bundle binds.
  Run here against 3.14.8 and the local endpoint, the probe printed
  `"patternIndex": {"status": "failed", "reason": "rvf-pattern-index-not-bound"}`. The same
  `@ruvector/rvf-node` loads through `createRequire` from the package folder. A live check has to
  go through the shipped CLI or MCP bundle.
- [#452](https://github.com/pacphi/agentic-kit/pull/452) asserts that stray witness rows reach the
  root on a fixed `aqe`. They do not (see #759), so its new test would fail against a real artifact.
- [#459](https://github.com/pacphi/agentic-kit/pull/459) pins the `activeAgents` wording and the
  `dispatched` status; `activeAgents` is now fixed.

## Limitations

- One platform, one embedder model, one run each. Seed patterns for #759 were inserted by SQL and
  their witness rows made by AQE's own backfill, so the stores are real AQE stores but not
  organically grown ones.
- No negative control on 3.14.4 or 3.14.6 was run for #759 or #754: the claims rest on the
  upstream tag containment and on these runs passing, not on a before-and-after pair here.
- #801 ran on 3.14.8 only. 3.14.7 contains the same fixing commits; it was not run.
- `fleet_init` was asked for `maxAgents: 5` and reported 15. Not investigated.
- The MCP probes for #528 and the Linux and Windows runs from earlier receipts are unchanged.
