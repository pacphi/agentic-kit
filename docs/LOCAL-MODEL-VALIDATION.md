# Validating local-model capture: a two-session protocol

**For:** whoever runs the evidence pass that moves
[ADR-0011](adr/0011-local-model-provenance-zero-cost-and-transcript-fidelity.md) from **Proposed**
to **Accepted**.

**Why this exists.** ADR-0011 decides how the usage scorecard should treat sessions served by a
**local** model (`ollama launch claude`, `ollama launch codex`). Every claim it makes about *what
Claude Code and Codex actually write to disk* in that situation is **derived from vendor
specifications, not observed** — at research time (2026-07-27) the Ollama daemon was down and all 754
indexed transcripts on the reference machine were vendor-metered. This document is the experiment
that replaces derivation with measurement.

**Time:** about 15 minutes of interactive work, plus two paste-backs.

---

## What we are trying to find out

Six questions. The first four decide whether ADR-0011's sections are right; the last two decide
whether two of its stated limitations are real.

| # | Question | ADR-0011 depends on it in | Predicted answer |
|---|---|---|---|
| Q1 | What literal string lands in `message.model` for a local Claude Code session? | F1, §1 | the Ollama tag, verbatim (e.g. `qwen3.6:latest`) |
| Q2 | Does `message.usage` carry `cache_read_input_tokens` / `cache_creation_input_tokens`? | F3, §3 | **no** — absent, so the indexer coerces both to `0` |
| Q3 | Is an `ai-title` event emitted when titling is served locally? | F7a, §7 | uncertain — this is the least-predictable answer |
| Q4 | Does a **mid-stream interruption** produce an `isApiErrorMessage` turn? | F7b, §7 | uncertain — if not, local failures under-report |
| Q5 | Does a *second* turn's `input_tokens` behave like a full prompt count, or a KV-cache delta? | F4, §6 | unstable; may drop sharply on turn 2 |
| Q6 | Does a model id aliased onto a vendor name reach the transcript intact? | **F5, §1 — the load-bearing one** | yes — `claude-opus-5` written verbatim |

Q6 is optional but worth more than the rest combined: ADR-0011's entire out-of-band provenance design
exists **because** the model id is forgeable. Right now that rests on a documentation sentence.

---

## Before you start

Leave the Ollama daemon **running** for the whole exercise, including afterwards — the capture step
reads its catalogue.

```bash
ollama serve &            # or just launch anything; skip if already running
ollama --version
curl -s http://localhost:11434/api/tags | head -c 200   # must return JSON, not exit 7
```

Record the versions you are testing (they belong in the results):

```bash
ollama --version && claude --version && codex --version
```

---

## Session 1 — Claude Code (answers Q1–Q5)

Use a tag whose **quantization is not in the name**, so the run also exercises the F2 metadata gap:

```bash
ollama launch claude --model qwen3.6:latest
```

Then, inside the session, in this order:

1. **Force a tool call.** *"Read package.json and tell me the version field."*
   → confirms `tool_use` blocks survive, which the tool-mix classifier prior depends on.
2. **Two or three more ordinary prompts.** *"What test runner does this project use?"*, *"Summarize
   the scripts section."* One turn cannot answer Q5 — the second turn is the one that shows whether
   a warm prefix changes the reported input count.
3. **Let it sit long enough for a session title to appear** (Q3).
4. **On the final response, press `Ctrl-C` mid-stream** — while tokens are still printing, not after
   it finishes. This is Q4, and it is the only question no amount of reading can answer.

Note the **working directory** you ran in; the capture step needs it.

## Session 2 — Codex (confirms the second host)

```bash
ollama launch codex
```

Two or three prompts, at least one forcing a file read. This confirms `turn_context.model` carries
the local tag, that `token_count` events still appear (Codex meters locally, so they should), and
that `rate_limits` is **absent** rather than zeroed — a zeroed rate limit would render as "0% of plan
used", which would be a fabricated denominator of exactly the kind ADR-0010 forbids.

## Optional — the alias experiment (Q6)

```bash
ollama cp qwen3-coder:30b claude-opus-5
ollama launch claude --model claude-opus-5     # one prompt is plenty
ollama rm claude-opus-5
```

Two things to know before running it:

- It leaves **one session in your corpus that today's code prices as genuine Opus at $5/$25 per 1M**.
  That is the demonstration, not a side effect. Note the session so it can be identified later.
- `ollama rm` removes only the alias, not the underlying weights. Your model store is untouched.

---

## Capture (run after both sessions)

Substitute the working directory you used. The commands below print **field names, counts, and model
ids only — never message content** — so the output is safe to paste into an issue or a PR.

```bash
# 1. Locate the two most recent Claude transcripts
ls -t ~/.claude/projects/*/*.jsonl | head -3

# 2. Q1 — every model id the session recorded
T=$(ls -t ~/.claude/projects/*/*.jsonl | head -1)
grep -o '"model":"[^"]*"' "$T" | sort | uniq -c

# 3. Q2/Q5 — the usage object, verbatim, per assistant turn
grep -o '"usage":{[^}]*}' "$T"

# 4. Q3 — was a title event written?
grep -c '"type":"ai-title"' "$T"

# 5. Q4 — did the interrupted stream produce an error turn?
grep -c '"isApiErrorMessage":true' "$T"

# 6. Codex side
C=$(ls -t ~/.codex/sessions/**/rollout-*.jsonl 2>/dev/null | head -1)
grep -o '"model":"[^"]*"' "$C" | sort | uniq -c
grep -c '"type":"token_count"' "$C"
grep -c 'rate_limits' "$C"

# 7. The catalogue, for the §5 identity claims (digest + quantization)
curl -s http://localhost:11434/api/tags \
  | python3 -c 'import json,sys; [print(m["name"], m["digest"][:12], m["details"].get("parameter_size"), m["details"].get("quantization_level"), m["details"].get("format")) for m in json.load(sys.stdin)["models"]]'

# 8. Full metadata for the one tag you tested
curl -s http://localhost:11434/api/show -d '{"model":"qwen3.6:latest"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("capabilities")); print({k:v for k,v in d.get("model_info",{}).items() if "context_length" in k or k.startswith("general.")})'
```

---

## Results

Fill this in and it becomes the record. An answer that **contradicts** the prediction is the valuable
outcome — it means ADR-0011 gets corrected before any code is written against it.

| # | Predicted | Observed | ADR action if it differs |
|---|---|---|---|
| Q1 | tag verbatim | | F1 and §1's catalogue-membership check need rework |
| Q2 | no cache fields | | if present, §3's premise weakens and §7's fidelity note narrows |
| Q3 | uncertain | | if titles are emitted, §7 drops the titling caveat |
| Q4 | uncertain | | if no error turn, §7 must state that local failures under-report |
| Q5 | unstable | | if stable, §6's token-KPI split may be unnecessary |
| Q6 | id verbatim | | **if the id is rewritten, §1 can be simplified drastically** |

| Environment | Value |
|---|---|
| `ollama --version` | |
| `claude --version` | |
| `codex --version` | |
| date run | |
| tag tested | |

**Where the results go:**

1. Observations and any corrected findings → [`USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md),
   which ADR-0011 names as the home for verifiable per-figure detail.
2. Corrections to the findings themselves → edit ADR-0011's F1–F7 in place, since it is still
   **Proposed** and has not yet been built against.
3. Status flip → ADR-0011 `Proposed` → `Accepted`, and the row in
   [`adr/README.md`](adr/README.md) updated to match.
4. This document → `docs/archive/2026-07-27-local-model-validation-protocol.md` with an index row
   stating what it proved, per [`archive/README.md`](archive/README.md)'s naming convention. It is a
   worklist; when the work is closed it is history, not a living doc.

---

## Two decisions that are not the experiment's to make

Both are recorded here so they are not silently assumed while the evidence is being gathered:

1. **Whether `ak` may read `127.0.0.1:11434` at all.** ADR-0009 §2 promised "zero network calls";
   ADR-0011 §2 argues a loopback read is not egress and sits inside ADR-0010's provider-mediated
   precedent. That reasoning is sound but it modifies a promise made in writing, so it wants a
   deliberate yes rather than an inference.
2. **Whether to call `/api/show` per tag.** `/api/tags` alone yields family, parameter size,
   quantization, and digest — enough for the display string in §5. `/api/show` adds architecture and
   context length at one extra call per distinct tag. Recommendation: ship `/api/tags` only, and add
   `/api/show` if context length proves to matter. Step 8 of the capture collects it either way, so
   the decision can be made on real output.
