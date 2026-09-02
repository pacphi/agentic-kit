# Hook configuration assurance

`ak audit hooks` inventories hook definitions without executing them. `ak heal hooks`
turns the same evidence into a deterministic repair plan. Both commands keep host
compatibility separate from trust, consent, grants, reachability, and organization policy.

## Operator journey

1. Discover and explain ownership:

   ```bash
   ak audit hooks --host all
   ak heal hooks --host all --json
   ```

   The plan names each source, canonical owner evidence, authority class, behavior and
   trust impact, exact host profile, proposed diff, verification method, and rollback.
   Dry-run is the default and creates no transaction directory.

2. Apply only the actions you reviewed:

   ```bash
   ak heal hooks \
     --action <ACTION_ID> \
     --plan-digest <PLAN_SHA256> \
     --apply --yes
   ```

   Every action ID and the plan digest must come from the current preview. The command
   performs a fresh audit and refuses version, profile, source, owner, parent, mode, or
   content drift before it writes a target.

   One Codex recipe handles the exact `codex@openai-codex` placement error. That
   package is the Codex companion for Claude Code, so the recipe changes only its
   user-scoped Codex `config.toml` entry from `enabled = true` to `enabled = false`.
   It does not uninstall the package, edit Codex's plugin cache, or change Claude
   Code's plugin enablement.

   For an estate-wide preview, include only projects from agentic-kit's bounded census:

   ```bash
   ak heal hooks --host codex --all-projects --json
   ```

   Legacy Ruflo retirement remains one explicit action per project. Pass every reviewed
   action with a repeated `--action`; the engine commits all selected files in one
   transaction or conditionally restores the files it changed.

3. Verify and retain the receipt. A successful apply already performs an exact-profile
   re-audit, confirms the targeted finding cleared, rebuilds a no-action plan, and proves
   a repeat audit/plan did not change bytes, mode, or modification time.

4. Preview and perform rollback when needed:

   ```bash
   ak heal hooks --undo <RECEIPT_ID>
   ak heal hooks --undo <RECEIPT_ID> --apply --yes
   ```

5. If a process or machine stopped mid-transaction, normal apply is blocked. Preview and
   explicitly recover the named unfinished receipt:

   ```bash
   ak heal hooks --recover <RECEIPT_ID>
   ak heal hooks --recover <RECEIPT_ID> --apply --yes
   ```

   Recovery validates all target and backup digests before restoring anything. It
   refuses user drift instead of guessing.

## Authority classes

- `safe-automatic`: exact, semantics-preserving and canonically owned. Selection is still
  explicit at this CLI boundary.
- `approval-required`: a user/project source or a change requiring explicit review.
- `upstream-required`: the authoritative repair belongs in the producing dependency.
- `never-automatic`: generated/cache targets, opaque modules, trust bypasses, unsupported
  schemas, unsafe files, or unproven ownership.

Executable recipes cover canonical user-owned JSON for exact Codex CLI `0.151.0` and
`0.152.1`, plus Claude Code `2.1.258`, `SessionEnd` timeout normalization. Under the exact
Codex `0.152.1` profile, the planner can also retire the frozen legacy Ruflo
Claude-helper projection from a project when a selected, valid `ruflo-core@ruflo` plugin
is proven. It removes only exact event/matcher/command/timeout/key-set matches, preserves
unrelated and AutoMemory hooks, and refuses ambiguous or noncanonical inputs.

The exact Codex profiles can also disable `codex@openai-codex` 1.0.6 in user-owned
`config.toml`. Detection is identity-based rather than a heuristic over all Claude
manifests. The byte-preserving recipe requires conservative whole-document TOML
validation, one unambiguous live table, and one canonical true scalar. Table-shaped text
inside multiline strings is ignored; malformed TOML, duplicate tables or assignments,
symlink-managed or otherwise unsafe targets, unverified plugin/host versions, and Windows
remain visible but non-executable.

That retirement stops legacy session-start, prompt-routing, and subagent side effects
that the selected plugin does not necessarily replace. Retained handler indexes may
shift and require Codex review. The preview discloses both facts. A fresh Codex session
is required after apply because hook definitions are loaded at session start.

OpenCode, external adapters, JSONC, plugin caches, generated copies, unknown versions,
and remote sources remain observable but non-executable. Windows receives the full plan
but no mutation until atomic replace-existing behavior has a proven platform port.

## Transactions and receipts

The default transaction store is private user state. A custom `--transactions-root` must
already be a current-user private directory; the command never changes its permissions.
Backups and receipts are transaction-specific. Writes use bounded regular files,
real-path containment, exclusive temporary files, file and directory synchronization,
same-directory replacement, and immediate verification.

The receipt digest detects accidental corruption or editing without resealing. It is not
a signature and does not authenticate against the same operating-system user. Trust,
consent, capability grants, and host permission state are never inferred or mutated.

## Upstream work

The audit reports registry validity, evidence freshness, and installed-version applicability
separately. Opening or updating an upstream issue always requires explicit user approval. The
constraint registry may retain either a draft or the published URL/time receipt after that
approval. Agentic-QE's 3.14.0 Stop generator is tracked in
[AQE #654](https://github.com/proffesor-for-testing/agentic-qe/issues/654); historical ETIMEDOUT is
detected and attributed, but generated copies are not patched and no released fix is claimed. A
workaround is retired only after a released artifact passes the relevant conformance suite.
