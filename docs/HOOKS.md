# Hook assurance and healing

Agentic Kit audits lifecycle hooks for Codex, Claude Code, OpenCode, and admitted
external adapters without running hook code. The default audit remains read-only:

```bash
ak audit hooks --host all
ak hooks doctor --host all
```

`ak hooks doctor --json` is intentionally the same report as
`ak audit hooks --json`, so existing automation can adopt the new command without
changing its parser.

## Preview before healing

```bash
ak hooks heal --dry-run --json
```

The plan is deterministic and content-bound. It contains an exact action ID,
plan digest, canonical target and ownership evidence, expected preimage and
postimage digests, mode, focused diff, behavior/trust impact, activation notes,
verification, and rollback conditions. Planning creates no transaction directory
and changes no target mtime.

The first executable recipe is deliberately narrow:

- Codex CLI must be exactly `0.151.0`;
- the target must be the user's direct global `hooks.json`;
- the source must still be a regular non-symlink file inside its expected root;
- only `SessionEnd` timeout values already clamped by that exact runtime profile
  are normalized to three seconds;
- trust, command text, matcher, ordering, environment, and side effects are not
  changed.

Claude Code, OpenCode, project files, generated projections, plugin caches,
external adapters, unknown host versions, and unproven owners remain
non-executable proposals.

## Apply an exact plan

Review the dry-run, then copy the exact action ID and plan digest:

```bash
ak hooks heal \
  --action hook-heal-EXACT_ID \
  --expect-plan EXACT_SHA256 \
  --yes
```

`--yes` confirms only the named actions. It does not select additional actions
or convert review-only proposals into executable ones. Before creating any
transaction, Agentic Kit recomputes the plan digest and rechecks every target
digest, mode, candidate digest, and file identity. It rechecks identity again
after backup and immediately before replacement. It then writes private verified
backups, a durable integrity-sealed receipt, and atomic replacements. A second
audit must clear the targeted finding, and a third audit/plan cycle must leave
bytes and mtimes unchanged.

Receipts live under the platform-specific Agentic Kit config directory at
`hook-heal/transactions/`. They contain digests and paths, not hook command text.

## Undo

Preview an exact receipt or the newest valid receipt:

```bash
ak hooks undo --receipt tx-EXACT_ID --dry-run
ak hooks undo --last --dry-run
```

Then confirm it:

```bash
ak hooks undo --receipt tx-EXACT_ID --yes
```

Undo restores the exact backup bytes and mode only while the current file digest
still equals the receipt's postimage. If a user, host, plugin, or generator has
changed the file since healing, Agentic Kit preserves that newer state and
refuses rollback. Tampered receipts and backups also fail closed.

## Trust and activation

Healing never sets a trust hash, changes project trust, bypasses a host prompt,
imports an OpenCode plugin, executes a hook, or writes a plugin cache. Codex may
require a new session and a fresh exact-definition trust review after a user-owned
definition changes. Restart the affected host only after reviewing that prompt.

Hook healing is intentionally separate from `ak sync`. No current action is both
agentic-kit-owned and automatic-eligible, so normal convergence cannot mutate
these files.

## Recovery after interruption

`ak hooks doctor` reports unfinished transactions in human output. Inspect the
receipt and current target before using guarded undo. Never copy a backup over a
target manually: doing so discards the postimage drift guard and receipt integrity
check.

Design details: [ADR-0041](adr/0041-host-neutral-hook-configuration-assurance.md),
[ADR-0042](adr/0042-transactional-hook-healing.md), and the
[DDD boundary](ddd/hook-configuration-assurance.md).
