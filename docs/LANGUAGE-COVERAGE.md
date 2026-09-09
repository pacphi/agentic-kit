# Programming language detection coverage

- **Baseline:** TIOBE September 2026; retrieved 2026-09-08
- **Source:** [TIOBE Index](https://www.tiobe.com/tiobe-index/)
- **Registry:** 2026.09.1

This is a dated popularity baseline, not a claim of universal popularity or a limit
on supported languages. Existing additional languages remain supported.

| Rank | Language | Registry abbreviation |
| --- | --- | --- |
| 1 | Python | Py |
| 2 | C | C |
| 3 | C++ | C++ |
| 4 | Java | Jv |
| 5 | C# | C# |
| 6 | JavaScript | JS |
| 7 | Visual Basic | VB |
| 8 | SQL | SQL |
| 9 | R | R |
| 10 | Rust | Rs |
| 11 | Fortran | F |
| 12 | Go | Go |
| 13 | Delphi/Object Pascal | Pas |
| 14 | PHP | PHP |
| 15 | Scratch | Scr |
| 16 | Assembly language | Asm |
| 17 | Ada | Ada |
| 18 | Swift | Sw |
| 19 | Objective-C | Obj |
| 20 | COBOL | Cob |
| 21 | Julia | Jl |
| 22 | Ruby | Rb |
| 23 | Perl | Pl |
| 24 | SAS | SAS |
| 25 | Classic Visual Basic | VB6 |
| 26 | Kotlin | Kt |
| 27 | MATLAB | Mat |
| 28 | Caml | ML |
| 29 | Prolog | Pro |
| 30 | GML | GML |
| 31 | Lua | Lua |
| 32 | PowerShell | PS |
| 33 | D | D |
| 34 | PL/SQL | PLS |
| 35 | ABAP | AB |
| 36 | Transact-SQL | TSQL |
| 37 | VBScript | VBS |
| 38 | OCaml | ML |
| 39 | TypeScript | TS |
| 40 | Zig | Zig |
| 41 | Dart | Dt |
| 42 | X++ | X++ |
| 43 | Lisp | Lsp |
| 44 | Scala | Sc |
| 45 | LabVIEW | LV |
| 46 | Ladder Logic | LD |
| 47 | VHDL | VHD |
| 48 | XSLT | XSL |
| 49 | Haskell | Hs |
| 50 | (Visual) FoxPro | Fox |

## Evidence and display

Textual source uses registered suffixes and bounded disambiguation for shared `.m`,
`.pl`, and `.d` files. Unresolved files remain in the unrecognized evidence list.
Generic SQL stays generic; no dialect is inferred from a database dependency.
Caml and OCaml share a family rather than counting the same file twice.

Scratch, LabVIEW, classic VB project files, FoxPro project files, MATLAB live scripts,
Dynamics X++ metadata, and PLCopen Ladder bodies can supply artifact-only language
presence. Their container or XML bytes never become language source-line counts.
Ladder identification requires PLCopen metadata plus an LD body; `.ld` linker scripts
are not Ladder Logic. X++ requires AxClass source metadata, not arbitrary XML.

Maintenance project cards show all detected language SVG icons inline, wrapping as needed.
The table above records registry abbreviations, not the current icon artwork. Local assets have
language names in tooltips and accessible image labels; no remote image request is made.
Source and artifact evidence remain distinct. No badges means no language evidence
was available; it does not assert that the project contains no code.

Detection coverage does not imply project-description extraction for every ecosystem.
See [project metadata adapters](PROJECT-METADATA-ADAPTERS.md) for that separate plan.
