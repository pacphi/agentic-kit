# Project metadata adapters

- **Status:** Proposed; no project-description adapters implemented yet
- **Date:** 2026-09-08
- **Governing decisions:** ADR-0025 (Implemented) and ADR-0048 (Accepted; evaluation gates pending)

## Decision direction

Reuse `stack-registry.mjs` and the bounded project walk in `stack-detect.mjs`.
Language, build ecosystem, and project purpose are different facts. Multiple adapters
may match one repository. Java does not imply Maven; a root Node manifest does not
describe every service in a polyglot monorepo.

An ecosystem adapter declares filename signatures, supported schema versions, bounded
parsing, and explicit description fields. Its output is a list of evidence candidates:

```typescript
interface ProjectDescriptionCandidate {
  ecosystem: string;
  moduleId: string; // exact discovered root/module identity
  text: string;
  sourceKind: 'manifest' | 'readme-excerpt';
  sourceLabel: string; // e.g. "pom.xml · project.description"
  evidenceGrade: 'declared' | 'excerpt';
  measuredAt: string;
}
```

Private source locators stay separate from public labels. Each adapter also reports
`found`, `absent`, `unsupported`, or `unreadable`; absence is not a scan failure.
Adapters never execute build files, resolve dependencies, fetch parent manifests, or
launch application code. Parse declarative fields; recognize dynamic expressions as
unsupported rather than evaluating them. XML parsing must disable external entities.

## Initial metadata-adapter coverage target

Language detection now has a separate [top-50 baseline](LANGUAGE-COVERAGE.md).
The following grouped ecosystem targets are a proposal, not a measured adapter count, a current
popularity ranking, or a claim of completed adapters. Shared ecosystems use shared adapters. Filename recognition is
not a promise that every file contains a description.

| Languages | Ecosystems / candidate surfaces |
| --- | --- |
| JavaScript, TypeScript | npm-compatible `package.json` (Node, Bun, Deno npm projects); Deno config separately |
| Python | `pyproject.toml`, declarative packaging metadata; never execute `setup.py` |
| Java, Kotlin | Maven `pom.xml`, Gradle build files, Ant `build.xml` |
| Scala | sbt, Maven, Gradle |
| Go | `go.mod` identifies module; description usually needs a documented fallback |
| Rust | Cargo package metadata and explicit workspace inheritance |
| PHP | Composer metadata |
| Ruby | Gemspec metadata; static literal extraction only, never Ruby evaluation |
| C, C++ | CMake, Meson, Autotools; package metadata where available |
| C#, F#, Visual Basic | MSBuild project/package metadata, with literal values only |
| Swift, Objective-C | SwiftPM, Xcode, CocoaPods; static metadata where available |
| Dart | Pub metadata |
| Elixir, Erlang | Mix and Rebar/Hex; static metadata only |
| Clojure | Leiningen and tools.deps; no Clojure evaluation |
| Haskell | Cabal and Stack package metadata |
| R | DESCRIPTION metadata |
| Julia | Project.toml identity plus supported descriptive metadata/fallback |
| Lua | LuaRocks metadata; no Lua evaluation |

Adapter implementation must verify the ecosystem's official schema and add positive,
missing-field, dynamic-value, malformed-input, boundary, and polyglot fixtures. Runtime
build evaluation is outside this abstraction, even if it would find more descriptions.

## Selection and presentation

1. Prefer an explicit declaration at the selected project/module root.
2. Keep conflicting declarations as candidates with their source labels. Do not choose
   the first scanned child package as the description of its parent repository.
3. A README excerpt is a separately labelled fallback, not a manifest declaration or
   generated summary. This fallback remains optional and unimplemented.
4. Show at most two lines beneath the project name; reveal full text and provenance in
   details. Omit an empty description area.
5. Keep proposed ecosystem/description selection separate from the shipped language presentation.
   Maintenance currently shows all observed language icons inline with wrapping; additional
   build-system presentation remains part of this proposal.

Example (illustrative):

```text
billing-service
Processes subscriptions and invoices.
Java · Maven                  description from pom.xml

Details → Description sources
  Project declaration     pom.xml · project.description
  Module declaration      web/package.json · description
```

For a polyglot root with no root-level declaration, show its name and measured ecosystem
summary; preserve module descriptions after drilling into modules.

## Delivery sequence

Implement common declarative JSON/TOML/XML/YAML/package formats first, then bounded
literal readers for executable build ecosystems. Broaden the adapter registry to all
target ecosystems with explicit coverage receipts. Keep project descriptions separate
from resource frontmatter/plugin metadata already implemented in this work.
