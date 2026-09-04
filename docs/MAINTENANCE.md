# Maintenance

Maintenance turns local inventory evidence into a small set of human-reviewed actions. It can
apply only an operation advertised by the current resource owner, and it verifies the result before
calling the transaction complete.

Use **System > Maintenance** for guided, one-finding-at-a-time work. Use the CLI for JSON output,
explicit batches, or interrupted-receipt recovery.

## Start with a scan

The ordinary scan uses current System evidence:

    ak maintain scan

Ask for a fresh deep System measurement when source state may have changed:

    ak maintain scan --deep

Deep scanning measures. It does not apply maintenance. Catalog and Advisory remain read-only.

The view and CLI group findings as:

- **Updates ready** — a provider exposed one exact update candidate;
- **Safe cleanup** — an exact owned and verifiable cleanup candidate;
- **Needs review** — an action exists but its impact needs human judgment;
- **Unsupported or blocked** — missing authority, incomplete evidence, or no native operation; and
- **Recent changes / Undo** — durable receipt history and currently eligible undo.

These groups do not form a hygiene score. Reclaimable amounts from unlike safety classes are not
added, and there is no “Clean all”.

## Act on the recommendation

Every ledger row leads with an imperative such as **Upgrade**, **Uninstall**, **Clear**, **Remove**,
**Choose**, or **Rescan**. Selecting the row shows the potential effect and a collapsed **How to
resolve** procedure. When the dashboard cannot perform the action, **Not available here** gives the
resource-specific reason instead of repeating generic safety policy.

Project/shared relationships currently remain report-only:

| Finding | Direct action |
|---------|------------------|
| Identical project copy | Confirm the shared source is available to the project, back up or commit the project copy, remove only that project copy, and deep-rescan. |
| Different definitions | Compare the complete definitions, choose the intended source of truth, then remove the unintended copy or rename the project copy when both behaviors are required. |
| Tracked project copy | Make the removal through the repository's normal branch, test, review, and pull-request workflow, then deep-rescan before merging. |
| Equivalent legacy transport | Prove the canonical registration is healthy at an equal or broader scope, use the host-native MCP workflow to remove only the legacy registration, restart if required, and deep-rescan. |

These are procedures, not generic delete commands. Definition equality does not prove which source
a host loads, Git tracking does not confer mutation authority, and equivalent configuration does
not prove transport health. A live provider exposes an operation-specific control such as
**Preview update**, **Preview uninstall**, or **Preview cleanup** only after it proves ownership,
exact targeting, verification, and recovery behavior.

An old npx environment is not automatically stale. Maintenance distinguishes:

- **version-stale** — a managed cached package is older than the installed managed version; an exact
  live provider match can offer **Preview cleanup**; and
- **idle-only** — no activity was observed for the reported number of days. The row tells you to
  clear it only if you accept a later redownload, remains under **Needs review**, and offers no
  dashboard action because age does not prove disuse.

## Preview before applying

An ordinary plan is read-only:

    ak maintain plan --findings FINDING_ID

To ask the live provider registry for executable actions and persist a five-minute plan:

    ak maintain plan --findings FINDING_ID --executable

You can narrow planning:

    ak maintain plan --project /absolute/project/path --executable
    ak maintain plan --safety-class approval-required --executable
    ak maintain plan --findings ID_1,ID_2 --executable --json

A CLI batch must share provider, operation, safety class, and rollback class. Split unlike work into
separate plans. The browser intentionally handles one finding at a time.

Keep the returned plan ID, SHA-256 digest, and exact action IDs together. The plan ID identifies
evidence; it does not authorize mutation.

## Apply an exact plan

Apply requires every binding and explicit confirmation:

    ak maintain apply \
      --plan PLAN_ID \
      --digest PLAN_SHA256 \
      --actions ACTION_ID_1,ACTION_ID_2 \
      --yes

Before the first effect, Maintenance reloads the provider, replans, compares source state, and
preflights every action. Evidence drift, expiry, provider changes, mixed safety classes, or an
unfinished earlier receipt stop the transaction.

After dispatch, the provider verifies its postcondition and Maintenance refreshes the full deep
System/Footprint snapshot. This is not a claim that several external operations were atomic. The
receipt records each outcome.

## Understand the action label

| Label | What it promises |
|-------|------------------|
| <code>safe-automatic</code> | Exact authority and verification support the proposal; you must still confirm it |
| <code>approval-required</code> | The action is exact, but you must accept impact or preservation risk |
| <code>upstream-required</code> | No safe local operation exists; use the displayed upstream workflow |
| <code>never-automatic</code> | Authority or recovery is insufficient; preserve the resource |

Rollback is separate:

- **reversible** — the provider can restore and verify the recorded preimage;
- **compensating** — a new provider operation can move toward the prior state; and
- **irreversible** — automated recovery is unavailable.

Read the restart and rollback labels before confirming.

## Undo a verified reversible change

Only an eligible committed receipt can be undone:

    ak maintain undo --receipt RECEIPT_ID --yes

Maintenance requires the recorded provider and version, a reversible or compensating operation, and
an exact current postimage. If anything changed after apply, undo refuses instead of overwriting the
new state. The provider verifies restoration and a deep Catalog refresh completes before the undo
is reported as rolled back.

## Recover an interrupted receipt

If dispatch may have happened but verification did not finish, the receipt becomes recovery
required. New Maintenance mutations remain blocked until the uncertainty is reconciled:

    ak maintain recover --receipt RECEIPT_ID --yes

Recovery is observation-only. It never retries, reapplies, undoes, or compensates an action. Each
recorded provider/version inspects current state:

- all recorded preimages can prove no change;
- all verified postimages can prove the apply committed;
- restored preimages can prove an interrupted undo rolled back; and
- a prepared journal with no dispatch evidence can prove an aborted no-change result.

Mixed state, current drift, a missing or changed provider, incomplete inspection, or a failed
Catalog refresh leaves the receipt recovery-required. Resolve the named evidence problem and run
the same recovery command again. Do not delete the journal or guess which operation occurred.

The dashboard displays recovery-required receipts but deliberately has no recovery action.

## What can act today

| Resource owner | Actions | Important limits |
|----------------|---------|------------------|
| Claude plugin CLI | Disable, update, and remove with data preserved; disable can be undone with native enable | Update needs one exact reported candidate. Prune is unsupported. Update/remove are irreversible. Restart required. |
| Codex plugin CLI | Remove an exact removal candidate | No per-plugin update or disable. Ambiguous version candidates stay report-only. Restart required. |
| Codex MCP CLI | Remove an exact user-scope registration | Project-scope findings remain report-only. No claim about server health or authorization. Irreversible; restart required. |
| Claude MCP | None | No provider is registered; findings remain report-only. |
| OpenCode plugin/MCP | None | No verified native Maintenance adapter; findings remain report-only. |
| Agentic-kit-owned skill | Conditional adapter: archive/prune; its own projected finding offers archive only | The stock CLI/dashboard does not yet supply a production receipt/root resolver, so it does not register this adapter. Explicit compositions require a complete current tree receipt and exact root; plugin caches, changed trees, symlinks, special files, and unreceipted trees are preserved. |
| Agentic-kit-owned stale npx environment | Clean the one exact collector candidate | Other caches and transcripts are excluded. Irreversible. |
| Ruflo MCP orphan | Terminate an exact same-user, PPID-1 orphan after identity recheck | Requires numeric UID and is unavailable on Windows. It is not a generic daemon kill. |

The service registers only providers it can execute. Npx actions are conditional on current
collector evidence. The owned-skill adapter additionally needs a composition root to supply exact
receipts and roots; the stock CLI/dashboard does not do that yet. The absence of a button can be the
correct result.

## Skill ownership is stricter than Catalog identity

Catalog can relate a standalone skill and a plugin-contributed skill by exact name, bounded
entrypoint digest, or bounded full-definition digest. Full-definition equality includes the
observed regular files in the bounded skill tree; it still does not prove which copy the host uses,
that either tree is owned, unused, or safely removable.

An owned skill action requires an <code>agentic-kit.skill-tree-ownership/v1</code> receipt that
binds the complete recursive regular-file manifest, including <code>SKILL.md</code>, and matches
the current shape and digest. The target must be a non-symlink direct child of the exact allowed
root under the current owner. Plugin-cache children are never direct skill targets.

Legacy, partial, modified, unreadable, ambiguous, or unreceipted trees stay report-only.

## Mutation lock recovery

Maintenance serializes effects with an owner-private, integrity-sealed lock. It reclaims an
abandoned lock only when all of these are proven:

1. the lock and owner record are private, regular, non-symlinked files;
2. the seal is valid;
3. the recorded machine is this machine;
4. the recorded UID is numeric and equals the current UID;
5. the recorded PID is provably dead; and
6. a second identity check under an exclusive reclaim marker agrees.

A live, remote, tampered, malformed, wrong-owner, unknown-UID, or liveness-unknown lock stays busy.
Lock recovery permits a new coordinator to start; it does not reconcile an interrupted receipt.
Use <code>ak maintain recover</code> for the receipt.

## State and privacy

Plans and receipts are stored under the current user's agentic-kit state directory:

- POSIX: <code>$XDG_STATE_HOME/agentic-kit/maintenance</code>, or
  <code>~/.local/state/agentic-kit/maintenance</code>; and
- Windows: <code>%LOCALAPPDATA%\agentic-kit\maintenance</code>.

Directories use owner-only mode 0700 and files use 0600 where the platform supports POSIX modes.
Records are bounded and integrity-sealed. Dashboard projections omit filesystem paths, commands,
rollback material, and raw provider diagnostics.

## Dashboard security boundary

Maintenance is the only dashboard mutation surface. Its exact routes are:

    GET  /api/maintenance
    POST /api/maintenance/plans
    POST /api/maintenance/apply
    POST /api/maintenance/undo

POST requires the per-session token in its header form, same-origin Host/Origin/Sec-Fetch-Site
evidence, <code>application/json</code>, an exact schema, and at most 64 KiB. Apply and undo consume
a short-lived one-use capability before provider work starts. The browser never sends a command,
path, provider ID, or action definition.

The accepted request bodies are exact—surplus keys are rejected:

| Route | JSON body |
|-------|-----------|
| Create plan | <code>{"findingIds":["ID"]}</code>, with 1–100 unique public IDs |
| Apply | <code>{"capability":"TOKEN","confirm":true,"typedPhrase":"SERVER_PHRASE"}</code>; omit <code>typedPhrase</code> only when the preview did not require one |
| Preview undo | <code>{"receiptId":"ID","preview":true}</code> |
| Confirm undo | <code>{"capability":"TOKEN","confirm":true,"typedPhrase":"UNDO"}</code> |

The plan and undo-preview responses mint different verb-bound capabilities. They cannot be moved
between sessions, verbs, plans, or receipts, and consumption occurs before asynchronous provider
work.

If a Maintenance read fails, the panel keeps the failure visible and offers **Retry report** rather
than rendering an empty workbench. The fragment token is also retained in page memory when browser
storage is blocked, so authenticated panels can still finish bootstrap.

## What Maintenance does not claim

- “Available” is not “latest” or “recommended”.
- Installed is not enabled, effective, or loaded into model context.
- Registered is not configured, reachable, healthy, authenticated, or authorized.
- Missing usage does not prove unused.
- Age or cache location does not prove stale or reproducible.
- A full-definition digest proves only equality of the bounded observed files. It does not prove
  host selection, ownership, usage, or safe deletion.
- A receipt makes non-atomic provider effects visible; it does not make them atomic.
- Recovery reconciles provable current state; it does not finish an interrupted operation.

For architecture and invariants, see
[the Maintenance domain](ddd/maintenance.md) and
[ADR-0044](adr/0044-receipt-aware-maintenance-control-plane.md).
