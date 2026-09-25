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
