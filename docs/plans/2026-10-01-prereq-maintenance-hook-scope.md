# Prerequisite C: give hooks their real scope in the Maintenance inventory

## Status

**Active**, not started. Prerequisite of
[Project-scoped management only](2026-10-01-project-scope-only-design.md#prerequisites). It lands
on `main` before P0, and it must be done before P6 gates Maintenance writes to opted-in projects.

## Problem

There are two connected defects.

1. **Every hook is labelled user-level.** The Maintenance projection hard-codes each hook placement
   to user scope, even hooks read from a project's own settings:
   - Claude's `.claude/settings.json` or `.claude/settings.local.json`;
   - Codex's `.codex/hooks.json` or `.codex/config.toml`;
   - OpenCode's project config or project plugins.

   Claude's administrator-managed hooks are also labelled user, although they live in an OS-wide
   path.
2. **Hooks never reach the real inventory.** The projection runs only when a hook read model is
   passed in, and no production caller passes one. The ADR-0048 Inventory therefore shows no hooks,
   although `docs/ddd/maintenance.md:37-39` says Maintenance "joins its sanitized read model into
   `hook`-kind placements". Only tests exercise the path.

Wiring hooks in without fixing their scope would show every project hook under **User**, with no
repository. Fixing the scope without wiring changes nothing a user can see. Both must ship
together.

The [project-scope design](2026-10-01-project-scope-only-design.md#maintenance) depends on correct
scope. Maintenance may only change placements inside opted-in project roots, and it labels
user-level placements "Yours: ak reads, never changes". A project hook mislabelled as user, or a
user hook mislabelled as project, would break both rules.

## Evidence

### The hard-coded scope

`mapHooks` in `src/lib/maintenance/management/projection.mjs:396-462`:

- `administrativeScope: 'user'` in `placementIdentity` (`:418`);
- `effectiveScope: 'user'` on the consumer binding (`:427`);
- `administrativeScope: 'user'` in `finalizePlacement` (`:444`);
- no `projectId`, no `projectPresentation` extra, no `builder.locate`, and the breadcrumb is only
  `[host, 'Hooks']` (`:445`).

### Where scope could come from

**Each read-model placement already carries its source kind.** Every placement has
`source: { ref, label, kind }`, where `kind` is the audit record's `sourceKind`
(`src/lib/hook-read-model.mjs:231-237`).

**The read model holds no paths, on purpose.** It has no file or project path at all, and
`tests/kit/hook-read-model.test.mjs:57-58` asserts this. The raw audit records do hold the root:

| Host | Field on the raw record |
| --- | --- |
| Claude | `source.baseDir` (`src/lib/hook-audit/providers/claude.mjs:233,286`) |
| Codex | `scope.projectPath` and `source.baseDir` (`src/lib/hook-audit/index.mjs:410-415,432`) |
| OpenCode | `source.baseDir` (`src/lib/hook-audit/providers/opencode.mjs:53,66,84,113`) |

The dashboard already keeps a server-private locator map from each record's `occurrenceId` to its
file (`src/lib/dashboard-server.mjs:725-761`).

**Source kinds and the scope each should get:**

| Host | `kind` | Source | Scope |
| --- | --- | --- | --- |
| Claude | `global` | `~/.claude/settings.json` | user |
| Claude | `managed` | managed-settings in an OS path (`claude.mjs:18-22,277-281`) | **system** |
| Claude | `project` | `.claude/settings.json` and `settings.local.json` (`claude.mjs:283-289`) | project |
| Claude | `plugin-cache`, `plugin-cache-inline` | the user's plugin cache | user |
| Codex | `global`, `global-inline` | `~/.codex/hooks.json`, `~/.codex/config.toml` | user |
| Codex | `project`, `project-inline` | `.codex/hooks.json`, `.codex/config.toml` | project |
| Codex | `plugin-cache`, `plugin-cache-inline` | the user's plugin cache | user |
| OpenCode | `global`, `global-plugin` | user OpenCode config and plugins | user |
| OpenCode | `project`, `project-plugin` | project config and plugins | project |
| External adapter | `external-adapter-manifest` | adapter manifest | user |
| Any | missing or unknown | — | user (the current behaviour, kept as the fallback) |

### Production callers that pass no read model

- `src/lib/dashboard-server.mjs:1049`;
- `src/lib/refresh.mjs:197`;
- `src/commands/maintain.mjs:242` and `:288`.

The input is plumbed through `service.mjs:64,81`, then `service-context.mjs:47,62`, then
`service-inventory.mjs:218`.

## What depends on the scope value

| Consumer | Effect once hooks carry real scope |
| --- | --- |
| Scope lens and facets (`query.mjs:158-159,282-285,414-427,534-546`) | Project hooks appear under **Projects**, with project and project-type facets |
| Scope → repository → type navigation (`focus-navigation.mjs:5-12,22-24,48-51`, client `maintenance-focus.mjs:51-57`, `maintenance-cards.mjs:37-45`) | Project hooks gain the repository level |
| Shadow conflicts (`conflicts.mjs:106-121,216-218`) | `hook` is shadow-eligible. Because `displayName` embeds the source label, user and project copies don't group today. Hosts merge hooks additively, and `docs/maintenance.md` warns that a project scope alone does not prove an override, so **remove `hook` from `SHADOW_ELIGIBLE_KINDS`** rather than rely on that accident |
| Duplicate placements (`conflicts.mjs:68-85`) | Keyed on digest. The hook digest includes `cwd`/`baseDir` (`hook-audit/common.mjs:151`), so copies under different roots never match. No change |
| Guidance (`guidance.mjs`) | No hook matchers exist, so hooks keep `guidanceLane: null`. The inspector's "where is it" shows the new scope |
| `effectiveScope` | Written but never read or validated (`model.mjs:547-553`). Set it to the same value for consistency |
| Placement identity (`identity.mjs:58-66`) | The scope and `projectId` are part of the placement ID, so **hook placement IDs change**. Hooks were never in production inventory, so there are no stored dispositions or receipts to migrate |

Valid scopes are `system`, `machine`, `user` and `project` (`model.mjs:21-25`, ADR-0048 §2). A
`system` placement has never been produced before. The validator, the focus roots and the
`SCOPE_RANK` ordering already support it.

## Fix

1. **Add a server-private placement context.** The public read model stays path-free. Alongside
   it, callers pass a private `hookPlacementContext(occurrenceId) → { projectRoot } | null`, built
   from the raw audit records using the fields in the table above. The dashboard builds it next to
   its existing locator map. The CLI builds it from the same audit run.
2. **Map scope in `mapHooks`.**
   - Derive the scope from `placement.source.kind`, using the table above.
   - For `project` kinds, resolve the project entry through `ctx.projects`.
   - Register hook project roots through `registerFallbackProjectPaths`
     (`projection.mjs:1081-1082`) before mapping, the same way catalog and host-alignment paths
     are registered.
   - Set `projectId`, a breadcrumb of `[...projectEntry.breadcrumb, host, 'Hooks']`, and
     `extra: projectPresentation(projectEntry)`. This follows `mapCatalogGroup`
     (`projection.mjs:318-349`) and `mapHostAlignment` (`host-alignment.mjs:11-37`).
   - If a project kind has no resolvable root, fall back to user scope and add a condition
     "project root unavailable", so nothing is silently placed in the wrong repository.
3. **Wire the read model into production.** The dashboard (`dashboard-server.mjs:1049`), refresh
   (`refresh.mjs:197`) and `ak maintain` (`maintain.mjs:242,288`) pass `hookReadModel` and
   `hookPlacementContext`. Read them from the dashboard's per-host hook cache where it exists;
   otherwise run the hook audit once per inventory refresh.
4. **Exclude hooks from shadow conflicts.** Remove `hook` from `SHADOW_ELIGIBLE_KINDS` and note
   why in the code.
5. **Update the docs.**
   - `docs/maintenance.md`: hooks appear in Inventory under System (Claude managed policy), User and
     Projects.
   - ADR-0048: an update note covering hook placements and the first `system` placement.
   - `docs/ddd/maintenance.md:37-39`: describe the private placement context.

## Not in scope

- **Hook healing.** `ak heal hooks` and its transaction engine are unchanged.
- **Read-model contents.** Paths stay out of the public read model.
- **Project-enabled plugins.** Claude's audit ignores the per-install scope in
  `installed_plugins.json` (`claude.mjs:61-100`), so their hooks still show as user.
- **Write gating.** Limiting Maintenance writes to opted-in projects belongs to the design's P6.

## Tests

- **`tests/kit/maintenance-management-projection.test.mjs:276-374`**: extend the hook fixtures
  with `kind` values and a placement context.
  - Assert user, project with `projectId` and breadcrumb, system for Claude `managed`, user for
    plugin caches, and the user fallback (with its condition) for a project kind whose root is
    missing.
  - The existing assertions (conditions, `guidanceLane: null`, the conflict kinds) keep passing.
- **Shadow conflict.** The same behaviour at user and project scope produces no
  `shadowed-override`.
- **`tests/kit/maintenance-management-parity.test.mjs:547`** (every project placement has a
  `projectId`) now covers hooks.
- **Path-free read model.** `tests/kit/hook-read-model.test.mjs:57-58` still passes: the read model
  stays path-free, and the context is never serialized to the client. Add a test that
  `/api/maintenance` payloads contain no absolute paths taken from hook records.
- **Wiring.** One dashboard and one `ak maintain inventory` test assert that a project hook fixture
  appears under Projects → that repository → Hooks.
- **Commands.** `node scripts/run-tests.mjs focus tests/kit/maintenance-management-projection.test.mjs`
  and the same for the parity test, then `pnpm test` and `pnpm run test:ui`.

## Acceptance criteria

- **Inventory shows hooks in the right place:**
  - a project's `.claude/settings.json` hook appears under Projects, inside that repository;
  - `~/.claude/settings.json` hooks appear under User;
  - Claude managed-policy hooks appear under System.
- No hook placement claims a scope its source contradicts.
- No path from the hook audit reaches the browser beyond what the Hooks view already exposes.

## Relation to the project-scope design

The design's Maintenance changes depend on this:

- the write precondition, which refuses unless the target lies inside an opted-in root;
- the "Yours: ak reads, never changes" labelling of user placements;
- moving project hook-heal actions into `maintain`.

Each of these assumes every placement's scope and project are true.
