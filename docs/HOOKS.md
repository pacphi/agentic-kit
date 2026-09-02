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

The initial executable recipes cover only canonical user-owned JSON for exact Codex CLI
`0.151.0` and Claude Code `2.1.258` `SessionEnd` timeout normalization. OpenCode,
external adapters, JSONC, plugin caches, generated copies, unknown versions, and remote
sources remain observable but non-executable. Windows receives the full plan but no
mutation until atomic replace-existing behavior has a proven platform port.

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

The audit reports registry validity, evidence freshness, and installed-version
applicability separately. Notification payloads are drafts only. Opening or updating an
upstream issue always requires explicit user approval, and a workaround is retired only
after a released artifact passes the relevant conformance suite.
