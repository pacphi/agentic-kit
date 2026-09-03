# Maintenance Capability

Maintenance is the proposed control-plane bounded context tracked by
[GitHub issue #200](https://github.com/pacphi/agentic-kit/issues/200). It helps a human understand
upgrade pressure and remove stale, unsupported, duplicated, or superseded resources without
confusing observation with authority.

## Boundary

**System measures; Maintenance acts.** Machine Footprint owns observed local inventory, project
pressure, source relationships, digest evidence, freshness, and read-only plans. Maintenance may
consume those facts, but it may not reinterpret a filesystem observation as ownership or a safe
delete decision.

Maintenance will own explicit intent, policy, lifecycle checks, remediation transactions,
verification, rollback, and durable receipts. Plugin or host-native lifecycle commands remain the
preferred executor when they exist. Direct file removal is never the default substitute for a
provider-owned uninstall or cache-prune operation.

The first delivered seam is deliberately read-only:

```text
ak system --deep
        |
        v
CatalogInventory v2
  occurrences: host + source scope + project + provider/version + entrypoint digest
  relationships: exact logical name + exact entrypoint digest
  pressure: project / user / plugin contributions, with incomplete evidence explicit
        |
        v
ak x skills plan --project <path>
  classifies; reports git state; projects a possible result; writes nothing
```

Issue #198 owns that measurement-and-plan foundation. Issue #200 owns any future apply, upgrade,
disable, uninstall, prune, rollback, or receipt-writing path.

## Safety model

A future action is eligible only when its authority and recovery path are explicit:

- **receipt-owned and unchanged** — may become an automatically actionable candidate;
- **exact known upstream revision** — useful evidence, but digest equality alone is not ownership;
- **modified, ambiguous, unreceipted, unreadable, symlinked, or oversized** — preserve and ask for
  review;
- **provider-owned plugin or MCP resource** — use the provider lifecycle and verify the result;
- **untracked project artifact** — require transaction backup before mutation;
- **tracked project artifact** — record source state and require source-control recovery evidence.

Every mutating operation must bind intent, exact inputs, affected paths, preconditions, executor,
result, verification, rollback material, and a policy decision receipt. A plan identifier is not
an authorization token.

## Human workflow

The dashboard should lead with explanation and evidence, then offer bounded actions only when the
control plane exists:

1. report upgrades, stale/unsupported resources, overlap, variants, and source drift;
2. explain why each item is classified and what evidence is missing;
3. preview the exact projected result and affected paths;
4. require explicit confirmation for a mutation;
5. verify the postcondition and retain a receipt/rollback path;
6. show unresolved and preserved items rather than converting uncertainty into success.

The proposed action vocabulary is `review`, `upgrade`, `disable`, `uninstall`, `prune`, `verify`,
and `undo`. Bulk action is a later policy decision, not implied by the reporting UI.

## Non-claims

- Installed does not mean enabled; enabled does not mean loaded into a model context.
- A source timestamp is not proof that nested content is unchanged.
- Equal `SKILL.md` digests do not prove supporting scripts or references are equal.
- Age alone does not prove that a cache, skill, MCP server, or plugin is stale or unsupported.
- A machine-wide count is not a project-specific context budget.
