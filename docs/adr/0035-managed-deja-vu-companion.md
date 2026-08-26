# ADR-0035 — Manage deja-vu as an opt-in session-history companion

- **Status:** Accepted; implementation tracked by
  [issue #114](https://github.com/pacphi/agentic-kit/issues/114)
- **Date:** 2026-08-26
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0026](0026-about-component-directory.md), and
  [issue #114](https://github.com/pacphi/agentic-kit/issues/114)

## Context

Agentic-kit manages curated operational memory through Ruflo and AgentDB. That memory records
decisions, outcomes, reusable patterns, and project continuity; it is not a verbatim archive of
every host transcript. Machines consequently retain useful historical evidence—exact errors,
commands, tool output, and edit spans—that never belongs in curated project memory.

[Issue #114](https://github.com/pacphi/agentic-kit/issues/114) proposes deja-vu as the local
session-history companion for this gap. deja-vu indexes histories already written by coding
harnesses and exposes recall through MCP and optional automatic injection. It is an evidence
archive beside curated memory, not a replacement for it.

The issue was filed against deja-vu 0.16.7. The
[upstream author's comment](https://github.com/pacphi/agentic-kit/issues/114#issuecomment-5259487049)
confirmed the npm/package-manager boundary, target names, `--no-guidance --no-index`, and
`doctor --json --offline`; it also corrected the issue's session-start-only description because
0.17.0 added point-of-action recall through `PreToolUse`.

The accepted baseline is now deja-vu
[v0.19.0](https://github.com/vshulcz/deja-vu/releases/tag/v0.19.0). Its
[changelog](https://github.com/vshulcz/deja-vu/blob/v0.19.0/CHANGELOG.md#0190---2026-08-26)
adds host-native packages/plugins, Codex plugin hooks, sync health in `doctor --json`, stricter
install refusal, and more accurate unreadable/corrupt reporting. Its
[JSON contract](https://github.com/vshulcz/deja-vu/blob/v0.19.0/docs/json-output.md#deja-doctor---json)
now pins `schema_version: 2` and permits additive fields within that version. These changes remove
the author's earlier unversioned-schema concern, but they make plugin coexistence and per-host hook
semantics part of the integration boundary.

Transcript history is sensitive. Building the index reads existing local stores and writes an
unencrypted derived index. Automatic recall can place historical content immediately before a
command or file edit. Presence of a deja binary, plugin, index, or upstream wiring record proves
neither user consent nor agentic-kit ownership.

## Decision

### 1. Model a managed companion, not another host or memory authority

deja-vu is the first **managed companion tool**: an opt-in tool that consumes the enabled-host set
and projects a bounded service into those hosts without becoming an execution host, inference
provider, provider binding, routing target, observability source, or AgentDB authority.

The boundary is:

```text
Ruflo / AgentDB                deja-vu
curated operational memory     local historical evidence archive
accepted decisions/patterns    transcripts, commands, tool output, edit spans
promotion authority            recall source only
project-scoped continuity      cross-host retrospective search
```

Recalled history remains untrusted input. It may inform reasoning; it cannot grant permission,
override current policy, or silently promote itself into curated memory.

### 2. Make installation and every read of history opt-in

Existing and migrated configurations default to disabled and unowned. Enabling the companion
requires explicit interactive consent or an explicit batch option. Before mutation, the plan must
name:

- the local transcript stores deja-vu may read;
- the unencrypted derived index it will write;
- each enabled host it will wire and the exact upstream target;
- whether wiring is MCP-only or which automatic events may inject context;
- that redaction is best-effort rather than a secrecy guarantee;
- that embeddings and cross-machine sync remain disabled unless the user configures them outside
  this decision; and
- which data uninstall preserves and which separate purge would delete.

MCP-only recall is the default after opt-in. Automatic recall is a second consent, recorded per
host. A single global `auto` label is insufficient for disclosure because v0.19.0 host
capabilities differ:

| Agentic-kit host | MCP target | Auto target | v0.19.0 automatic events relevant to consent |
|---|---|---|---|
| Claude | `claude-code` | `claude-auto` | session start, prompt submit, pre-compaction, pre-tool command/edit, failed-command follow-up |
| Codex | `codex` | `codex-auto` | session start, pre-tool `Bash`/`apply_patch`, failed-command follow-up |
| OpenCode | `opencode` | `opencode-auto` | session context, per-prompt recall, pre-compaction; no `PreToolUse` |

The target map is version-bounded data. Agentic-kit invokes only explicit targets for enabled
hosts; it never uses upstream `install --all`, `install --auto`, or `uninstall --all`, because those
commands discover and mutate unrelated harnesses on the machine.

### 3. Use the shared lifecycle with bounded subprocesses

The companion implements ADR-0016's lifecycle:

```text
detect -> plan -> apply -> verify -> undo
```

- `detect` reads desired intent, package/install facts, ownership receipts, bounded binary output,
  offline doctor output, host wiring, plugin presence, and index metadata. It never warms,
  refreshes, installs, or repairs.
- `plan` deterministically selects package, explicit target transition, one optional index run,
  verification, and undo operations. It separates ordinary removal from destructive data purge.
- `apply` installs the released npm artifact, invokes each target with
  `--no-guidance --no-index`, performs one bounded `deja index` when required, and records
  ownership only after independent success evidence.
- `verify` recollects disk/package, doctor, host-wiring, plugin, trust, and index facts. An apply
  result is never its own proof.
- `undo` removes exact receipt-owned targets in reverse dependency order and removes the npm
  package only when agentic-kit owns it. Partial undo keeps its receipt and returns failure.

Every subprocess has a timeout, bounded output, process-tree cleanup, and redacted diagnostics.
Status, logs, receipts, and Dashboard projections never include transcript text, queries, recalled
content, or raw project paths.

The managed path does not call `deja warmup`: v0.19.0's warmup command also writes deja's CLI
skill, which would cross agentic-kit's `--no-guidance` ownership boundary. Initial and stale-index
refresh uses one bounded `deja index` after all targets converge. `deja index --rebuild` is reserved
for a diagnosed corruption repair, is disclosed separately, and is never routine sync work.

### 4. Pin the upstream machine contract at the boundary

The managed npm coordinate is `@vshulcz/deja-vu`; the executable is `deja`. Agentic-kit owns
updates only for an npm installation it installed and receipted. It uses the package manager for
install, update, and removal and never calls `deja update` for that installation.

Normal health collection invokes:

```text
deja doctor --json --offline
```

The parser accepts only supported schema versions, initially exactly `2`, while ignoring unknown
additive fields. It classifies timeout, non-JSON output, missing/unsupported schema, and unknown
enum values as degraded or unknown. Doctor's ordinary exit status does not establish health; the
body does. `sync` is an expected additive v0.19.0 top-level object.

Doctor JSON supplies store, index, MCP, sqlite, version, policy, ingest, embedding, sync, and
optional deep facts. It does not fully prove auto-hook state, Codex hook trust, or every index
integrity condition that the human doctor checks. Agentic-kit therefore combines doctor with
bounded, content-free observation of the configured host surfaces. Missing evidence stays
unknown. An existing empty upstream store and a missing store both report `missing`; agentic-kit
does not invent a distinction unless an independent bounded filesystem observation proves it.

### 5. Keep package, wiring, plugin, and data ownership separate

Agentic-kit records separate value-precise receipts for:

1. the npm package installation;
2. each host's exact upstream target;
3. any agentic-kit-written intent; and
4. no user data—the index, notes, exclusions, tombstones, policies, imported history, and source
   transcripts remain user-owned.

Upstream `$XDG_CONFIG_HOME/deja/wiring.json` contains target/version/home/executable repair intent.
It is useful evidence but is not an agentic-kit ownership receipt: it does not record prior values
or package ownership and can change after partially successful upstream operations. Binary or
plugin presence is likewise not ownership.

Externally installed npm, Homebrew, Go, native binary, and host-plugin integrations remain visible
and unowned. Agentic-kit may report and use a compatible external package after opt-in, but never
adopts, updates, or removes that package. Any new target wiring it creates receives its own receipt;
pre-existing external wiring remains external.

v0.19.0 plugin coexistence must be observed rather than assumed. In particular, the Codex plugin
provides session-start, per-prompt, and pre-compaction hooks, while `codex-auto` supplies
session-start, pre-tool, and failed-command hooks; the plugin stands down when local deja hooks
exist. Agentic-kit must disclose or refuse a transition that would silently remove the plugin's
per-prompt/pre-compaction behavior. A wired but untrusted or disabled Codex hook is not healthy.

### 6. Preserve data by default and bound destructive purge

Ordinary uninstall removes receipt-owned wiring only. Package removal is a separate explicit scope.
Data purge is a third, destructive scope with a preview and confirmation.

Agentic-kit resolves the index from validated observed configuration—preferably
`doctor.index.path`—rather than assuming XDG cache behavior. v0.19.0 defaults to
`~/.cache/deja/index.db` unless `DEJA_INDEX_DIR` is set; `XDG_CACHE_HOME` does not relocate it.
Notes resolve independently through `DEJA_NOTES_FILE` or XDG/platform data paths.

A purge may delete only canonical, absolute, known companion artifacts under an exact allowlist.
It rejects empty, relative, root, home, host-store, or unexpectedly broad targets; follows no
unresolved glob; and never deletes source transcripts. Deleting the index can also delete
imported-only indexed material and the index's tombstone mirror, so the preview states that loss.
Primary notes, exclusions, tombstones, policy, peers, and imported history are preserved unless a
more specific future decision defines and consents to their deletion.

### 7. Keep drift and status content-free

Normalized companion facts distinguish:

- disabled, absent, externally present, and agentic-kit-owned;
- install method, installed version, latest version, and package drift;
- desired and observed target per enabled host;
- MCP wiring, auto event coverage, plugin coexistence, and trust state;
- doctor schema/availability, source qualifiers, and index missing/stale/healthy/unknown; and
- usable-but-degraded versus failed operations.

`ak sync` repairs only receipt-owned state or new wiring explicitly requested by managed intent,
then recollects facts to prove convergence. Repeated sync is a no-op. No drift surface prints
content or converts doctor exit zero into a healthy verdict.

## Consequences

- Users gain cross-host historical recall without diluting curated project memory.
- Setup and first indexing cost time and local disk; both remain opt-in and visible. The managed
  index command does not install deja-authored guidance.
- MCP-first adoption minimizes ambient context injection.
- Auto mode needs more disclosure and testing because its event surface differs by host and can
  change through plugin coexistence.
- Agentic-kit must maintain a small versioned anti-corruption layer for doctor schema and target
  capabilities rather than parsing human output as an open-ended API.
- Default uninstall leaves user history intact. Purge is deliberately harder because a broad cache
  deletion can destroy imported evidence or privacy state.
- Compatible external packages remain useful after opt-in, but their package drift stays outside
  Agentic Kit ownership; only newly requested, receipted target wiring can converge through
  `ak sync`.

## Rejected alternatives

- **Treat deja-vu as a host, provider, or AgentDB replacement:** collapses distinct authority and
  routing boundaries.
- **Enable it by default:** scans sensitive history without consent.
- **Default to auto-recall:** injects untrusted historical content at host-specific action points.
- **Use upstream aggregate install/uninstall flags:** mutates detected harnesses outside
  agentic-kit's enabled-host intent and receipts.
- **Trust doctor exit status or upstream wiring records as proof:** loses degraded and partial
  states.
- **Call `deja update` for npm installs:** creates competing update owners.
- **Delete the deja directory on uninstall:** conflates wiring, package, derived index, and
  user-owned primary data.

## References

- [Agentic-kit issue #114](https://github.com/pacphi/agentic-kit/issues/114)
- [Upstream author clarification](https://github.com/pacphi/agentic-kit/issues/114#issuecomment-5259487049)
- [deja-vu v0.19.0 release](https://github.com/vshulcz/deja-vu/releases/tag/v0.19.0)
- [deja-vu v0.19.0 changelog](https://github.com/vshulcz/deja-vu/blob/v0.19.0/CHANGELOG.md#0190---2026-08-26)
- [deja-vu JSON output contract](https://github.com/vshulcz/deja-vu/blob/v0.19.0/docs/json-output.md)
- [deja-vu security model](https://github.com/vshulcz/deja-vu/blob/v0.19.0/docs/SECURITY-MODEL.md)
