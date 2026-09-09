# Schema documents

These JSON Schema documents describe versioned interchange shapes. Passing a schema does not
establish ownership, authentic provenance, an unchanged preimage, valid plan/receipt digests,
platform durability, consent, or permission to execute an action.

| Schema | Runtime authority and additional checks |
| --- | --- |
| [Dependency constraints](agentic-dependency-constraints.schema.json) | `src/lib/hook-audit/upstream.mjs` additionally checks duplicate IDs, dependency references, dated evidence, notification state and recheck policy. A recorded upstream issue is not an automatic local repair. |
| [Hook healing plan](hook-healing-plan.schema.json) | `src/lib/hook-remediation/planner.mjs` recomputes content identity; the engine verifies exact action selection, runtime profiles, preimages and authorization before effects. |
| [Hook healing receipt](hook-healing-receipt.schema.json) | `src/lib/hook-remediation/store.mjs` validates action/authorization correspondence, statuses, images, backup references and digest integrity; recovery independently checks current state. |

The plan and receipt schemas intentionally describe some nested fields more broadly than the
runtime validator. Treat them as structural documentation, not a replacement for the executable
validation and transaction protocol. Exact schema-version matching remains required. The issue 211
audit parsed all three JSON files and resolved their internal JSON pointers, compared their core
fields with source validators, and did not change the schemas or execute a repair.
