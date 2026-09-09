# Issue 211: historical records and documentation artifacts

Baseline: `67fb5c0`. The [per-file CSV](211-history-files.csv) accounts for **all 88 baseline
files** in this scope, with original and reviewed SHA-256, review level, date/scope, structural
check, active-document references, link findings, disposition and limitations. Files added by
issue 211 are not silently mixed into that baseline denominator.

## Coverage and what was actually checked

| Area | Files | Review performed | What this does not prove |
| --- | ---: | --- | --- |
| `docs/archive` | 39 | Historical index, titles/status/date/authority metadata, all local links, and living-document successors; frozen bodies retained | Past incident findings, test totals, proposed plans, upstream issue status or commands were not rerun/revalidated |
| `docs/audits` | 11 | Nine dated Markdown reports and two JSON inventories: declared scope/baseline, temporal wording, successor relationships, syntax and links | Not a new operational audit, signature, receipt authorization or current host-health measurement |
| `docs/evidence` | 26 | Three Markdown records, two JSON receipts/reports, and 21 PNGs: exact-artifact/fixture boundaries, date/source attribution and format integrity | Historical conformance sessions and benchmarks were not rerun; screenshots are not a new WCAG or current-machine audit |
| `docs/assets` | 9 | Two HTML design mocks reviewed as prototypes; seven active SVG text/semantic descriptions compared with transcript/accounting/classifier source | Prototype counters/layouts do not establish current UI state; diagrams do not establish runtime observations |
| `docs/schemas` | 3 | All JSON parsed, internal JSON pointers resolved, version/required fields compared with hook planner/store/upstream validators | Structural schemas do not replace runtime authorization, digest, ownership, durability or preflight checks |

Every PNG passed signature, chunk-boundary/CRC, IHDR dimensions, IEND and compressed-data validation.
This was **image-metadata/format review only**: the 21 historical PNGs were not recaptured or given
new per-image visual signoff. Their set README identifies the September 9 PR #210 synthetic
fixtures. Their original bytes are preserved and individually bound in the CSV.

## Findings and dispositions

| ID | Finding | Disposition |
| --- | --- | --- |
| HIST-01 | Archived plans and prompts can look executable when opened without their index; status words reflect their original dates | Strengthened archive-index non-authority/current-successor guidance; original historical bodies unchanged |
| HIST-02 | Twelve original-location link occurrences in three frozen documents do not resolve after relocation | Preserved frozen bodies and added working successor mappings in the archive index; recorded each affected file/count in CSV |
| HIST-03 | Audit reports include date-local claims such as “uncommitted” that can be mistaken for current checkout state | Added audit index defining temporal scope, cumulative September 9 reports, and non-authority of proposed repairs |
| HIST-04 | Screenshot-set README did not state a capture-series date or distinguish audit baseline from capture commit | Added September 9 / PR #210 fixture attribution and explicit baseline-versus-capture distinction; no screenshots changed |
| HIST-05 | Active pipeline SVG omitted nested Claude IDs/OpenCode and could imply its JSONL size cap covered SQLite | Corrected bounded labels and separate SQLite branch; retained detailed guards in Transcripts prose |
| HIST-06 | Active attribution SVG said all Codex user turns were real prompts and generalized one historical sample | Corrected provenance-gated classification and authorship non-claim; historical counts unchanged and labelled as one sample |
| HIST-07 | Asset/schema directories lacked a consolidated statement of their evidentiary scope | Added indices distinguishing illustrative designs, current explanatory diagrams, structural schemas and executable validators |

The two corrected SVGs passed XML parsing and were rendered in Chromium at their native diagram
geometry. Text bounding checks found no text outside the 880-pixel viewBox; visual inspection
confirmed readable labels and routing arrows. Render previews were temporary files outside the
repository, not replacement historical evidence screenshots. Other SVGs were checked against
`usage-index.mjs`, `usage-parsers.mjs`, `usage-aggregate.mjs`, and `usage-classify.mjs`: shared masking
before truncation, JSONL scan/reader split, per-turn versus cumulative accounting, and confidence
constants remain represented. The asset index records the simplified/host-specific scope.

### Frozen relocation findings

The twelve errors are confined to:

- `2026-07-14-shell-kit-readme.md`: eight original `docs/…` link occurrences;
- `2026-07-14-shell-kit-troubleshooting.md`: two original `archive/…` references;
- `2026-08-16-artifact-host-extensibility-explainer.html`: two adapter-authoring references.

The [archive index](../archive/README.md#original-location-links-retained-in-frozen-files) maps
these to preserved historical or current destinations. They are consciously retained historical
link limitations, not a claim that an all-archive link check is green. The normal repository link
job excludes the archive; the separate audit sweep deliberately included it.

## Validation and limits

- All 88 baseline files have one CSV row; no duplicate paths.
- Historical JSON parsed and SVG/XML parsed; all 21 PNGs passed the format checks above.
- Offline link review covered the archive rather than inheriting its normal CI exclusion. External
  links, upstream issue/release status and DOI endpoints were not requested.
- New/updated index and active-diagram links: 114 total / 100 unique, 107 accepted, seven
  external/excluded, zero errors. The retained archival relocation errors remain separate.
- Focused Markdown lint covered all seven new/updated Markdown files, including the archive index,
  without inheriting the normal archive exclusion: zero issues. `git diff --check` passed.
- No native host probe, package installation, paid inference, mutating procedure, receipt
  reconciliation, or release action was executed for this historical/artifact audit.

The 88-file inventory is deliberately **not** labelled complete semantic verification of every
historical claim. Current domain semantics were audited separately in the
[DDD matrix](211-ddd-matrix.md); current operator guides and ADRs have their own issue 211 owners.
