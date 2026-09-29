# Upstream watch ledger

This branch is written only by agentic-kit's upstream watch workflow
(`.github/workflows/upstream-watch.yml` on `main`). It shares no history with `main`.

- `events.ndjson` holds one record per line, oldest first.
- Each commit adds the records of one run. Its `Checked-At` trailer is where the next run starts.

Query it from a clone of agentic-kit:

```bash
node scripts/upstream-watch.mjs ledger --since 2026-09-01
git fetch origin upstream-watch-ledger && git show origin/upstream-watch-ledger:events.ndjson
```

How it works: `docs/upstream-watch.md` on `main`.
