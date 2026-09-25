# Repository capture

## Contents and authority

The user requested capturing the research documents and mockups in a branch,
committing and pushing them. This package records that research snapshot under
`docs/research/v5/`; it does not change application behavior or release status.

The capture includes all 19 final deliverables, the two supporting research
memos, and the prior management mockup before settings grouping. Four standalone
previews make the complete mockup evolution usable outside the conversation.
The README identifies the latest design and marks earlier alternatives.

## Portability and publication adjustments

- Converted 11 workstation-specific citations in the host memo to GitHub links
  pinned to the inspected repository commit, preserving source line anchors.
- Added document shells and bundled display helpers to standalone previews;
  original fragment files remain separately editable.
- Generalized a participant's personal billing amount and subscription-count
  detail in the meeting appendix and rendered report. Product requirements,
  uncertainty and source citations are retained.
- Added supersession notes to earlier design memos so their navigation
  alternatives are not confused with the latest shared workbench.
- Kept raw transcripts and temporary generation/debugging files outside this
  public documentation package. Private-source links retain existing access
  requirements and do not grant access.

## Validation boundary

Packaging checks cover Markdown formatting, local document links, JSON parsing
and catalogue identities, JavaScript syntax in mockups and the rendered report,
absence of workstation-specific links, and snapshot digests. Prior interactive
checks are recorded in [verification.md](verification.md).

These checks do not certify a production v5 release, native host adapters,
real configuration writes or fleet update operations. The source application
is unchanged by this documentation capture.

The capture validation checked 28 content files, 75 local links, 29 inline
scripts and four standalone frames. JSON comparisons preserved all catalogue
data; 330 unique settings entries and 101 unique panel entries were retained.
Repository Markdown lint checked 175 documents with zero issues. The manifest
records content digests and excludes itself from its file list.

## Navigation memory update · September 25

This update adds [navigation-memory.md](navigation-memory.md), revises the
management workbench fragment, and regenerates the two documents that embed it.
The preview wrappers, their display helpers and the other mockups are unchanged.

- **Standalone preview.** The iframe `data-srcdoc` of
  `previews/management-workbench.html` was decoded, the previous fragment was
  found verbatim and replaced, and the document was re-encoded with the original
  entity set (`&lt;`, `&gt;`, `&quot;`, `&#x27;`, `&amp;`, `&#10;`). Rebuilding
  with the previous fragment reproduced the committed preview byte for byte.
- **Report.** `report.html` embeds the workbench inline. That copy matched the
  previous fragment except for 48 line breaks rendered as spaces, so it was
  located by comparing against the previous fragment and replaced with the new
  fragment verbatim. The report's appendices were not regenerated and do not
  include the navigation-memory memo.
- **Validation.** The manifest's validation counts were recomputed with rules
  that reproduce the capture's recorded counts exactly on the previous snapshot:
  Markdown and static HTML local links, inline scripts including standalone
  frames, and JSON parsing. The manifest digests were recomputed for every file.
- **Excluded.** The regeneration and browser-check scripts ran from a temporary
  workspace and are not part of this package, consistent with the capture policy
  above.
