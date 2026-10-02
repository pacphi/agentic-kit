# GPT-6.1 Sol capability and price audit — 2026-09-29

Scope: whether GPT-6.1 Sol should replace GPT-6 Sol (and earlier Sol generations) in agentic-kit's
model registry, price table, routing defaults and docs. Prices are API list-price equivalents, not
subscription bills or evidence of account access. Evidence is dated 2026-09-29 and covers only that day.

## Findings

| Item | GPT-6.1 Sol | GPT-6 Sol | Source |
|---|---|---|---|
| Model id | `gpt-6.1-sol` | `gpt-6-sol` | [1], [2] |
| Input / output per 1M tokens | $2 / $10 | $2 / $10 | [1], [2], [3] |
| Cached input | **$0.10 (5% of input)** | $0.20 (10%) | [1], [2], [3] |
| Cache writes | $2.50 (1.25×) | $2.50 (1.25×) | [1], [2] |
| Prompts over 272K input tokens | 2× input and cache, 1.5× output | same | [1], [2] |
| Batch / Flex | 50% of Standard | 50% | [1], [2], [3] |
| Fast | 2× Standard (not with EU residency) | 2× | [1], [2], [3] |
| Context / max input / max output | 1,050,000 / 922,000 / 128,000 | same | [1], [2] |
| Knowledge cutoff | 2026-04-30 | 2026-04-20 | [1], [2] |
| Reasoning effort | `low`, `medium` (default), `high`, `xhigh`, `max` | adds `none` | [1], [2] |
| Modalities | text and image in, text out | — | [1] |
| Endpoints | Chat Completions, Responses, Batch | — | [1] |
| Successor status | GPT-6 Sol's page names GPT-6.1 Sol as its newer version | — | [2] |

Positioning. OpenAI describes GPT-6.1 Sol as "near-Astra performance for complex work at a lower
cost" and recommends it "for repeated, long-running work across code, apps, and documents" [1], [4].
It is available in Codex CLI, the IDE extension, ChatGPT Work and the desktop app on Plus, Pro,
Business, Enterprise and Edu plans; Enterprise and Edu keep it off until an administrator enables it,
and Free and Go plans are excluded at launch [4]. Codex config uses the id `gpt-6.1-sol` [4].

Vendor-reported results (not measured by agentic-kit): search summaries of OpenAI's announcement [5]
and secondary press [6], [7] report that on DeepSWE v1.1 GPT-6.1 Sol matches GPT-6 Astra at roughly
one-fifth of the cost, beats GPT-6 Sol's best score by 6.4 points at a lower effort, comes within 2.1
points of Astra on OSWorld 2.0 at about one-seventh of the cost, more than doubles GPT-6 Sol on
Terminal-Bench Science 0.1 at max effort, and cuts the factual-error rate at low effort from 11.4% to
7.7%. Astra lists $10/$50, so "one-fifth" is consistent with the price table above [3].

## Decisions this supports

1. **Own price key, with 0.05× cache reads.** `gpt-6.1-sol` normalises to `gpt-6-1-sol`, which is not
   a token-boundary prefix of `gpt-6-sol`, so without a key it prices at the fallback ($3/$15,
   unmatched). Reusing Sol's entry would overstate cache-read cost by 2×. Cache reads are the bulk of
   agentic tokens, so this is the number that matters for usage monitoring.
2. **Balanced-tier default.** Same per-token price as GPT-6 Sol plus half-price cache reads and
   OpenAI-reported gains makes it the natural Codex balanced preset. The claim is vendor-reported;
   per-token price is not per-task cost, so catalog notes keep that framing.
3. **GPT-6 Sol stays as `prior`, not retired.** OpenAI's deprecations page lists no entry for
   `gpt-6-sol`, `gpt-6.1-sol`, `gpt-5.6-sol` or `gpt-5.6-terra` [8]. `RETIRED_MODELS` requires a
   first-party withdrawal notice, so nothing was added there and user pins keep working.
4. **qe-court and Ruflo need no separate edit.** Both take model ids from the routing catalog and
   `DEFAULT_ROUTES`; seats follow the activity routes. Machines seeded earlier keep `gpt-6-sol` until
   `ak host reset-routes`; `ak status` reports the difference.
5. **Effort.** ak's Codex worker passes `model_reasoning_effort="medium"`, which 6.1 Sol supports.
   A user pin of effort `none` would not be valid for 6.1 Sol.

## Not modelled (unchanged)

The >272K surcharge, Batch/Flex/Fast multipliers and regional +10% uplift remain unmodelled for the
reasons recorded in `src/lib/pricing.mjs` (`UNMODELLED_PRICING_FACTORS`).

## Limits of this evidence

- No first-party release date was retrievable. `openai.com` and the help-center release notes
  returned HTTP 403 to the fetch tool, and the API changelog page had no 6.1 entry. The model page and
  pricing page already list the model, so the table records `asOf: 2026-09-29` and no launch date.
- Benchmark figures come from search-engine summaries of the announcement and from press, not from a
  fetched copy of the announcement or a system card. Treat them as vendor claims.
- The pricing-page and model-page figures were read through a summarising fetch tool; the two agree
  on every price above.

## Re-verification, 2026-10-01

The open items in "Limits of this evidence" were checked again against first-party sources.

| Question | Finding | Source |
|---|---|---|
| Release date | GPT-6.1 Sol was released on 2026-09-29. GPT-6 Sol and GPT-6 Luna were released on 2026-09-22, and GPT-6 Astra on 2026-09-03 | [9] |
| Codex default | Codex CLI 0.159.1 "Added GPT-6.1 Sol as the default model in the bundled catalog and Amazon Bedrock Mantle and Runtime catalogs" on 2026-09-29. The Models page says to use it "when available to your account and client" | [10], [4] |
| Prices, limits, cutoff, efforts | Unchanged from the table above. The model page still says `none` and `minimal` efforts are not supported | [1], [3] |
| Retirement | Still no deprecation entry for GPT-6 Sol, GPT-6.1 Sol, GPT-6 Astra, GPT-5.6 Sol or GPT-5.6 Terra | [8] |
| API notes | Tool calling requires the Responses API, and Multi-agent is in beta. ak's Codex worker runs through Codex CLI, so neither changes ak | [9] |
| Capability | The system card addendum says GPT-6.1 Sol "delivers capabilities comparable to those of our most powerful model, GPT-6 Astra". It is rated Critical for cybersecurity and High for biological and chemical capability, with the same safeguards as GPT-6 Astra | [11] |
| Hallucination | "GPT-6.1 Sol and GPT-6 Sol achieve similarly low hallucination rates" | [11] |

**What this changes:**

- **The release date is first-party now.** `src/lib/pricing.mjs` cites it.
- **The routing default moves with the price entry.** Codex itself made GPT-6.1 Sol its default [10], so the two are no longer separate decisions.
- **The capability claim ak repeats is the system card's.** That is "comparable to GPT-6 Astra", and it remains OpenAI's claim, not ak-measured. The `gpt-6.1-sol` catalog note in `src/lib/routing.mjs` uses that wording, replacing "near-Astra on OpenAI-reported agentic coding".
- **The benchmark figures in "Positioning" are still unverified.**
  - The DeepSWE, OSWorld 2.0 and Terminal-Bench Science figures are not in the system card. The announcement [5] still returns HTTP 403.
  - They remain press reports of a vendor announcement.
  - The factual-error figures (11.4% to 7.7%) are not supported by the system card, which reports similar hallucination rates for the two Sol models.
  - ak's code and living docs cite none of these figures.

## Sources ([1]–[8] accessed 2026-09-29, [1], [3], [4], [8]–[11] on 2026-10-01)

1. OpenAI API docs, *GPT-6.1 Sol Model*. <https://developers.openai.com/api/docs/models/gpt-6.1-sol>
2. OpenAI API docs, *GPT-6 Sol Model*. <https://developers.openai.com/api/docs/models/gpt-6-sol>
3. OpenAI API docs, *Pricing*. <https://developers.openai.com/api/docs/pricing>
4. OpenAI, *Models* (Codex and ChatGPT). <https://learn.chatgpt.com/docs/models>
5. OpenAI, *Introducing GPT-6.1 Sol* (seen only as a search result summary; page returned 403). <https://openai.com/index/introducing-gpt-6-1-sol/>
6. AlphaSignal, *OpenAI's GPT-6.1 Sol Matches Flagship Performance at One-Fifth the Cost*. <https://alphasignal.ai/news/openai-s-gpt-6-1-sol-matches-flagship-performance-at-one-fifth-the-cost>
7. Investing.com, *OpenAI launches GPT-6.1 Sol with near-Astra performance*. <https://www.investing.com/news/stock-market-news/openai-launches-gpt61-sol-with-nearastra-performance-93CH-4923227>
8. OpenAI API docs, *Deprecations*. <https://developers.openai.com/api/docs/deprecations>
9. OpenAI API docs, *Changelog* (entries of 2026-09-03, 2026-09-22 and 2026-09-29). <https://developers.openai.com/api/docs/changelog>
10. OpenAI, *Codex changelog* (Codex CLI 0.159.1, 2026-09-29). <https://learn.chatgpt.com/docs/changelog>
11. OpenAI, *Addendum: GPT-6.1 Sol System Card*, 2026-09-29. <https://cdn.openai.com/pdf/38e3efcf-545e-44cd-99ec-2b7eb395f4cc/oai_GPT_6_1_Sol.pdf>
