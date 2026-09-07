// ADR-0048 management projection. Builds a privacy-projected ManagementInventory
// from already-collected evidence — Catalog v4, the install/storage/runtime
// footprint sections, a model-inventory snapshot, the hook read model,
// provider/credential detections, and discovery/source-coverage facts. This
// module never touches the filesystem, spawns a process, or reads the clock
// except through the injected `now`; every fact it renders was handed to it.
//
// Accepted input shapes (fields not covered by an existing collector are
// documented inline as explicit extensions a caller may supply):
//
//   footprint.catalog            CatalogInventory v4 (footprint/catalog.mjs):
//                                 { items[], sourceStamps? } where each item is
//                                 { key, canonicalId, kind, name, capabilityName,
//                                   pluginRef, presence[] } and each presence is
//                                 { host, scope, project, itemPath, digest,
//                                   definition, artifactId, provider, plugin,
//                                   consumer: { host, mechanism, configuredBy,
//                                   enabled } }.
//   footprint.install             CollectInstall result (footprint/install.mjs):
//                                 { tools[] } where each tool is
//                                 { tool, label, present, version, installMethod,
//                                   managed, bytes }.
//   footprint.storage.reclaimables ReclaimableCandidate[] (storage-reclaim.mjs):
//                                 { id, kind, label, safety, rationale, bytes,
//                                   cleanupHint }.
//   footprint.runtime.daemons     RuntimeCensus daemon census (footprint/runtime.mjs):
//                                 { entries: [{ pid, workspace, workspaceExists,
//                                   ageSecs }] }.
//   footprint.projects.projects   ProjectFootprint rows (footprint/projects.mjs):
//                                 { path, label, hosts, remote }. Two fields are
//                                 EXTENSIONS this projection accepts but the
//                                 current collector does not yet populate —
//                                 `repositoryRoot` (a verified shared root that
//                                 groups linked worktrees) and `submoduleParentPath`
//                                 (accepted, currently unused — see `discovery.projects`
//                                 below for the real submodule-of derivation path).
//                                 Used as a fallback lexical registry whenever
//                                 `discovery.projects` does not cover a path.
//   footprint.consumers            collectConsumers() result (footprint/consumers.mjs):
//                                 { rows: [{ id, label, group, kind: 'root'|'breakdown',
//                                 containedBy, presence, bytes, accountingNote }] }.
//                                 Mapped to `related-storage` resources for the
//                                 groups ADR-0048 §4 covers (agent hosts, models,
//                                 runtimes, providers, developer tooling) — the
//                                 generic `system` and the already-covered
//                                 `project-trees` groups are skipped.
//   modelSnapshot                  a model-inventory/contracts.mjs normalizeSnapshot()
//                                 result: { models[], bindings[] }.
//   hookReadModel                  buildHookDashboardReadModel() result:
//                                 { definitionGroups[], findings[] }.
//   providerDetections              adapters/facts.mjs normalizeIntegrationFacts()
//                                 shape: { providers: { [id]: { configured,
//                                 reachable, billing, credentialPresent } } }.
//                                 `credentialMechanism` (one of model.mjs's
//                                 CREDENTIAL_MECHANISMS) is an EXTENSION field
//                                 this projection reads when present, because the
//                                 upstream shape does not carry a mechanism name.
//   discovery.dependencyProbes     Verified command/runtime-availability facts —
//                                 produced by this package's own
//                                 dependency-probes.mjs (collectMcpRegistrationFacts
//                                 + probeDependencies), or any caller supplying
//                                 the same shape: [{ subjectKind, subjectSelector,
//                                 host?, requirement, requirementKind?, satisfied,
//                                 authority }].
//   discovery.instructionFiles      Flat instruction/context file evidence, matched
//                                 by project PATH against the lexical registry:
//                                 [{ projectPath, host, name, digest?, scope }].
//   discovery.projects              The AUTHORITATIVE project registry agent D's
//                                 discovery scan emits; wins over the lexical
//                                 footprint.projects registry for any path or
//                                 projectId it names:
//                                 [{ projectId, path?, breadcrumb?, worktree?,
//                                 repositoryKey?, nested?, submoduleOfProjectId?,
//                                 instructionFiles?: [{ name, host, digest? }] }].
//                                 Each entry's own `instructionFiles` closes the
//                                 instruction-context-file coverage gap directly
//                                 (no `discovery.instructionFiles` path lookup
//                                 needed for these); `submoduleOfProjectId` derives
//                                 a verified `submodule-of` edge between the two
//                                 projects' representative (first instruction-file)
//                                 placements — omitted, never guessed, when either
//                                 side has none.
//   discovery.installResourceKinds  EXTENSION: overrides the RESOURCE_KINDS bucket
//                                 (executable | runtime | host-adapter) a given
//                                 install.tools[].tool id maps to.
//   discovery.modelStorage          EXTENSION: per-model storage evidence keyed by
//                                 model identity: { logicalBytes, physicalBytes,
//                                 sharedBlobs }.
//   sourceCoverage                  SourceCoverage[] rows, already carrying opaque
//                                 `src_`/`env_` ids (produced by the discovery
//                                 slice) — passed straight into the inventory.
//   environment                    { platform, release?, arch?, wsl? } — `wsl` is
//                                 the array `environments.mjs.detectEnvironments`
//                                 accepts as `wslDistributions`.
//
// Project and instruction-file mapping (identity, breadcrumb, worktree/
// repository grouping, submodule-of derivation) lives in
// projection-projects.mjs, split out to keep this file under the repo's
// max-lines budget; it is not a separate public contract.
import { createHash } from 'node:crypto';
import {
  MANAGEMENT_INVENTORY_SCHEMA, MANAGEMENT_SCHEMA_VERSION, assertManagementInventory, canonicalJson, sourceComplete,
} from './model.mjs';
import {
  artifactIdentity, bindingIdentity, inventoryIdentity, placementIdentity, resourceIdentity,
} from './identity.mjs';
import { assertion, scorecardFor } from './evidence.mjs';
import { detectEnvironments, currentEnvironmentId } from './environments.mjs';
import { deriveDependencyEdges } from './dependencies.mjs';
import { classifyConflicts } from './conflicts.mjs';
import { createBuilder, finalizePlacement, hostLabel } from './projection-builder.mjs';
import {
  deriveSubmoduleEdges, mapDiscoveryProjectInstructionFiles, mapInstructionFiles, mapProjects,
  registerFallbackProjectPaths,
} from './projection-projects.mjs';

// ── small pure helpers ──────────────────────────────────────────────────────

function digestValue(digest) {
  if (digest == null) return null;
  if (typeof digest === 'string') return digest || null;
  if (typeof digest === 'object' && typeof digest.value === 'string') return digest.value || null;
  return null;
}

/** Every distinct project path a catalog presence names, regardless of
 *  whether the project registry already covers it — the set
 *  `registerFallbackProjectPaths` needs to guarantee no project-scoped
 *  placement is ever left with a null projectId. */
function projectPathsIn(catalog) {
  const paths = new Set();
  for (const item of catalog?.items ?? []) {
    for (const presence of item.presence ?? []) {
      if (presence.project) paths.add(presence.project);
    }
  }
  return [...paths];
}

// ── catalog (skill, agent, command-prompt, plugin, mcp-registration) ───────

const CATALOG_KIND_MAP = Object.freeze({
  skill: 'skill', agent: 'agent', command: 'command-prompt', plugin: 'plugin', mcpServer: 'mcp-registration',
});
const CARRIER_BY_CATALOG_KIND = Object.freeze({
  skill: 'directory-tree', agent: 'file', command: 'file', plugin: 'package-record', mcpServer: 'config-selector',
});

function scopeOfPresence(presence) {
  return presence.project ? 'project' : 'user';
}

/** Presence entries that are the SAME exact placement: one physical carrier
 *  (equal artifactId) at the same administrative scope and project. Distinct
 *  hosts reading that one carrier become bindings on the one placement
 *  (MNT-INV-004), never separate placements. */
function groupCatalogPresence(item) {
  const groups = new Map();
  for (const presence of item.presence ?? []) {
    if (presence.consumer?.enabled === false) continue;
    const scope = scopeOfPresence(presence);
    const key = `${scope} ${presence.project ?? ''} ${presence.artifactId}`;
    if (!groups.has(key)) groups.set(key, { scope, project: presence.project ?? null, entries: [] });
    groups.get(key).entries.push(presence);
  }
  return [...groups.values()];
}

function catalogTransportKey(item, presence) {
  if (item.kind !== 'mcpServer') return null;
  const definition = digestValue(presence.definition) ?? digestValue(presence.digest);
  return definition ? `mcp:${definition}` : null;
}

function catalogConditionsFor(item, group, probes) {
  if (item.kind !== 'mcpServer') return { conditions: ['healthy'], technicalDetails: [] };
  const first = group.entries[0];
  const host = first?.host ?? null;
  const matches = probes.filter((probe) => (
    probe.subjectKind === 'mcp-registration'
    && probe.subjectSelector?.toLowerCase() === item.capabilityName?.toLowerCase()
    && (probe.host == null || probe.host === host)
  ));
  const unsatisfied = matches.filter((probe) => probe.satisfied === false);
  if (unsatisfied.length === 0) return { conditions: ['healthy'], technicalDetails: [] };
  return {
    conditions: ['missing-verified-dependency'],
    technicalDetails: unsatisfied.map((probe) => `Command dependency: ${probe.requirement}`),
  };
}

/** Logical identity is kind + capability name + producer + a bounded
 *  definition digest WHERE VERIFIED — never the administrative scope or
 *  project (domain-model.md "ManagedResource"; "Several physical placements
 *  of one logical resource appear as separate selectable rows under one
 *  group"). Two placements sharing this material ARE one logical resource
 *  with several placements, even across different projects. Without a
 *  verified digest, equal names still group (there is no evidence to split
 *  them on); a verified digest MISMATCH is what actually proves two copies
 *  differ — that produces two resources and a same-name-different-definition
 *  conflict, never a project boundary alone. */
function catalogResourceId(item, kind, definitionDigest, installationKey) {
  return resourceIdentity({
    kind, hostNamespace: item.pluginRef ?? null, producer: item.pluginRef ?? null,
    sourceSelector: item.canonicalId, definitionDigest,
  }, installationKey);
}

function catalogArtifact(builder, item, first, installationKey) {
  const carrier = CARRIER_BY_CATALOG_KIND[item.kind];
  const artifactId = artifactIdentity({ carrier, locator: first.artifactId }, installationKey);
  builder.upsertArtifact(artifactId, {
    carrier, label: `${hostLabel(first.host)} configuration`,
    ...(digestValue(first.digest) ? { digest: digestValue(first.digest) } : {}),
  });
  return artifactId;
}

function addCatalogBindings(builder, group, placementId, artifactId, installationKey) {
  const bindingIds = [];
  const consumerHosts = [];
  for (const presence of group.entries) {
    if (!consumerHosts.includes(presence.host)) consumerHosts.push(presence.host);
    const mechanism = presence.consumer?.mechanism ?? null;
    const bindingId = bindingIdentity({
      placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(presence.host), mechanism,
    }, installationKey);
    bindingIds.push(bindingId);
    builder.addBinding({
      bindingId, placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(presence.host),
      mechanism, enabled: presence.consumer?.enabled ?? null,
      effectiveScope: presence.consumer?.configScope ?? group.scope, grade: 'verified',
      affectedByProposedAction: false,
    });
  }
  return { bindingIds, consumerHosts };
}

function addCatalogEvidence(builder, { item, first, group, placementId, digest, now }) {
  if (digest) {
    builder.addVersion({
      ...assertion({
        subjectId: placementId, field: 'installedVersion', value: digest, grade: 'verified',
        authority: 'catalog scan', sourceRef: `catalog:${first.host}:${item.kind}`,
        capturedAt: new Date(now()).toISOString(), scope: group.scope,
      }), axis: 'contentDigest',
    });
  }
  if (item.pluginRef && first.provider) {
    builder.addProvenance(assertion({
      subjectId: placementId, field: 'provenance',
      value: { kind: 'plugin-marketplace', label: item.pluginRef },
      grade: 'verified', authority: `${first.host} plugin registry`, sourceRef: `catalog:${first.host}:plugins`,
      capturedAt: new Date(now()).toISOString(), scope: group.scope,
    }));
  }
}

const CATALOG_KIND_FOLDER = Object.freeze({
  skill: 'Skills', agent: 'Agents', 'command-prompt': 'Commands', plugin: 'Plugins', 'mcp-registration': 'MCP servers',
});

function catalogBreadcrumb(kind, first, projectEntry) {
  if (projectEntry) return [...projectEntry.breadcrumb, hostLabel(first.host)];
  return [hostLabel(first.host), CATALOG_KIND_FOLDER[kind] ?? 'Resources'];
}

function catalogScorecard(placementId, consumerHosts, now) {
  return scorecardFor([
    assertion({
      subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'catalog scan',
      sourceRef: 'catalog', capturedAt: new Date(now()).toISOString(),
    }),
    assertion({
      subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'catalog scan',
      sourceRef: 'catalog', capturedAt: new Date(now()).toISOString(),
    }),
    assertion({
      subjectId: placementId, field: 'consumers', value: consumerHosts, grade: 'verified',
      authority: 'catalog scan', sourceRef: 'catalog', capturedAt: new Date(now()).toISOString(),
    }),
  ]);
}

function catalogDependencyProbeMatches(item, probes, consumerHosts) {
  if (item.kind !== 'mcpServer') return [];
  return probes.filter((probe) => (
    probe.subjectKind === 'mcp-registration'
    && probe.subjectSelector?.toLowerCase() === item.capabilityName?.toLowerCase()
    && (probe.host == null || consumerHosts.includes(probe.host))
  ));
}

function addCatalogDependencyEdges(builder, matches, placementId, installationKey) {
  for (const probe of matches) {
    const requirementKind = probe.requirementKind ?? 'executable';
    const dependencyResourceId = resourceIdentity({ kind: requirementKind, sourceSelector: probe.requirement }, installationKey);
    builder.upsertResource(dependencyResourceId, { kind: requirementKind, displayName: probe.requirement });
    builder.addEdge({
      fromPlacementId: placementId, toId: dependencyResourceId,
      kind: requirementKind === 'runtime' ? 'requires-runtime' : 'requires-executable',
      requirement: probe.requirement, grade: 'verified', authority: probe.authority ?? 'PATH probe',
      satisfied: probe.satisfied,
    });
  }
}

function mapCatalogGroup(builder, item, group, ctx) {
  const { installationKey, now, projects, dependencyProbes, environmentId } = ctx;
  const kind = CATALOG_KIND_MAP[item.kind];
  if (!kind) return;
  const projectEntry = group.project ? projects.get(group.project) ?? null : null;
  const first = group.entries[0];
  const digest = digestValue(first.digest);
  const resourceId = catalogResourceId(item, kind, digest, installationKey);
  builder.upsertResource(resourceId, {
    kind, displayName: item.name, namespace: item.pluginRef ?? null, publisher: item.pluginRef ?? null,
  });
  const placementId = placementIdentity({
    resourceId, environmentId, administrativeScope: group.scope,
    projectId: projectEntry?.projectId ?? null, locationSelector: first.artifactId,
  }, installationKey);
  const artifactId = catalogArtifact(builder, item, first, installationKey);
  const { bindingIds, consumerHosts } = addCatalogBindings(builder, group, placementId, artifactId, installationKey);
  const { conditions, technicalDetails } = catalogConditionsFor(item, group, dependencyProbes);
  addCatalogEvidence(builder, { item, first, group, placementId, digest, now });
  const transportKey = catalogTransportKey(item, first);
  finalizePlacement(builder, {
    placementId, resourceId, environmentId, administrativeScope: group.scope,
    projectId: projectEntry?.projectId ?? null, locationBreadcrumb: catalogBreadcrumb(kind, first, projectEntry),
    artifactIds: [artifactId], consumerBindingIds: bindingIds, conditions,
    evidenceScorecard: catalogScorecard(placementId, consumerHosts, now),
    displayName: item.name, kind, hostNamespace: item.pluginRef ?? undefined, consumerHosts,
    versions: digest ? { contentDigest: digest } : {},
    technicalDetails, extra: { ...(projectEntry ? { projectKind: projectEntry.projectKind ?? 'unknown' } : {}), ...(transportKey ? { transportKey } : {}) },
  });
  if (first.itemPath || first.path) builder.locate(placementId, { path: first.itemPath ?? first.path });
  const probeMatches = catalogDependencyProbeMatches(item, dependencyProbes, consumerHosts);
  addCatalogDependencyEdges(builder, probeMatches, placementId, installationKey);
}

function mapCatalog(builder, catalog, ctx) {
  for (const item of catalog?.items ?? []) {
    for (const group of groupCatalogPresence(item)) mapCatalogGroup(builder, item, group, ctx);
  }
}

// ── hooks ────────────────────────────────────────────────────────────────

/** Groups hook occurrences by the exact (host, lifecyclePoint) slot a host
 *  resolves, mapping each slot to the set of distinct behaviorFingerprints
 *  (`definitionGroups[].behaviorId`, computed by the static audit from real
 *  configuration content — see hook-read-model.mjs's `staticFacts`) that slot
 *  produced. A slot resolving to more than one distinct fingerprint is a
 *  REAL, field-based definitions-differ signal — never a title/prose match. */
function hookDefinitionKeyGroups(definitionGroups) {
  const byKey = new Map();
  for (const group of definitionGroups) {
    const key = `${group.host} :: ${group.lifecyclePoint}`;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(group.behaviorId);
  }
  return byKey;
}

/** Explanations (already allowlisted presentation prose from
 *  hook-presentation.mjs, carried on each finding by the read model) plus a
 *  closed-vocabulary diagnostic-code summary line for one occurrence. */
function hookDiagnosticsFor(findings, occurrenceId) {
  const relevant = findings.filter((finding) => finding.affectedOccurrenceIds?.includes(occurrenceId));
  const explanations = relevant.map((finding) => finding.explanation).filter(Boolean);
  const codes = [...new Set(relevant.map((finding) => finding.code).filter(Boolean))];
  return codes.length ? [...explanations, `Diagnostic codes: ${codes.join(', ')}.`] : explanations;
}

function hookConditionFor({ group, placement, findings, keyGroups }) {
  const technicalDetails = hookDiagnosticsFor(findings, placement.occurrenceId);
  if (placement.selectionState === 'not-selected') return { conditions: ['disabled'], technicalDetails };
  const key = `${group.host} :: ${group.lifecyclePoint}`;
  const differs = (keyGroups.get(key)?.size ?? 0) > 1;
  return { conditions: [differs ? 'definitions-differ' : 'healthy'], technicalDetails };
}

function mapHooks(builder, hookReadModel, ctx) {
  const { installationKey, now, environmentId } = ctx;
  const findings = [...(hookReadModel?.findings ?? []), ...(hookReadModel?.observations ?? [])];
  const definitionGroups = hookReadModel?.definitionGroups ?? [];
  const keyGroups = hookDefinitionKeyGroups(definitionGroups);
  for (const group of definitionGroups) {
    for (const placement of group.placements ?? []) {
      const displayName = `${group.lifecyclePoint} ${placement.source?.label ?? group.handlerKind}`.trim();
      // Logical identity is kind + lifecycle slot + host + a bounded
      // definition digest WHERE VERIFIED (the behaviorFingerprint) — never
      // the occurrence. Two occurrences carrying the SAME verified
      // fingerprint are one logical hook definition placed twice, not two
      // resources (mirrors catalogResourceId's rule above); two competing
      // DIFFERENT fingerprints for one slot still separate correctly, since
      // the digest itself differs.
      const verifiedBehaviorId = group.behaviorId && group.behaviorId !== 'unknown' ? group.behaviorId : null;
      const resourceId = resourceIdentity({
        kind: 'hook', hostNamespace: group.host, sourceSelector: `${group.lifecyclePoint}:${group.handlerKind}`,
        definitionDigest: verifiedBehaviorId,
      }, installationKey);
      builder.upsertResource(resourceId, { kind: 'hook', displayName, namespace: group.host });
      const placementId = placementIdentity({
        resourceId, environmentId, administrativeScope: 'user', locationSelector: placement.occurrenceId,
      }, installationKey);
      const artifactId = artifactIdentity({ carrier: 'config-selector', locator: placement.occurrenceId }, installationKey);
      builder.upsertArtifact(artifactId, { carrier: 'config-selector', label: `${hostLabel(group.host)} hooks configuration` });
      const bindingId = bindingIdentity({
        placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(group.host), mechanism: 'host-hooks',
      }, installationKey);
      builder.addBinding({
        bindingId, placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(group.host),
        mechanism: 'host-hooks', enabled: placement.selectionState !== 'not-selected', effectiveScope: 'user',
        grade: 'verified', affectedByProposedAction: false,
      });
      const { conditions, technicalDetails } = hookConditionFor({ group, placement, findings, keyGroups });
      // A verified behaviorFingerprint is real content-equivalence evidence:
      // two occurrences carrying the same one are byte-identical definitions
      // (feeding conflicts.mjs's shared-artifact/duplicate-placement pair
      // exactly as any other kind's contentDigest does).
      if (verifiedBehaviorId) {
        builder.addVersion({
          ...assertion({
            subjectId: placementId, field: 'installedVersion', value: verifiedBehaviorId, grade: 'verified',
            authority: 'hook assurance scan', sourceRef: 'hook-read-model', capturedAt: new Date(now()).toISOString(),
          }), axis: 'contentDigest',
        });
      }
      finalizePlacement(builder, {
        placementId, resourceId, environmentId, administrativeScope: 'user',
        locationBreadcrumb: [hostLabel(group.host), 'Hooks'], artifactIds: [artifactId],
        consumerBindingIds: [bindingId], conditions,
        evidenceScorecard: scorecardFor([
          assertion({
            subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'hook assurance scan',
            sourceRef: 'hook-read-model', capturedAt: new Date(now()).toISOString(),
          }),
          assertion({
            subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'hook assurance scan',
            sourceRef: 'hook-read-model', capturedAt: new Date(now()).toISOString(),
          }),
        ]),
        displayName, kind: 'hook', hostNamespace: group.host, consumerHosts: [group.host], technicalDetails,
        versions: verifiedBehaviorId ? { contentDigest: verifiedBehaviorId } : {},
      });
    }
  }
}

// ── install: executables, runtimes, host adapters ──────────────────────────

const HOST_IDS = new Set(['claude', 'codex', 'opencode', 'hermes']);

function installResourceKind(tool, overrides) {
  if (overrides?.[tool.tool]) return overrides[tool.tool];
  if (HOST_IDS.has(tool.tool)) return 'host-adapter';
  return 'executable';
}

function mapInstallTools(builder, tools, ctx) {
  const { installationKey, now, environmentId: defaultEnvironmentId, installResourceKinds } = ctx;
  for (const tool of tools ?? []) {
    // `tool.environmentId` lets a caller that has already probed several
    // environments (a Windows host plus its WSL distributions) tag which one
    // observed this tool, so one logical resource can carry a placement per
    // environment (ADR-0048 §2, MNT-INV-012) rather than collapsing onto
    // whichever environment this process happens to be running in.
    const environmentId = tool.environmentId ?? defaultEnvironmentId;
    const kind = installResourceKind(tool, installResourceKinds);
    const resourceId = resourceIdentity({ kind, sourceSelector: tool.tool }, installationKey);
    builder.upsertResource(resourceId, { kind, displayName: tool.label ?? tool.tool });
    if (!tool.present) continue;
    const placementId = placementIdentity({
      resourceId, environmentId, administrativeScope: 'machine', locationSelector: tool.tool,
    }, installationKey);
    // Locator includes the environment: the same tool name in two
    // environments (Windows vs. a WSL distribution) is never the same
    // physical binary, so it must never collapse onto one shared artifact.
    const artifactId = artifactIdentity({ carrier: 'executable', locator: `${tool.tool}:${environmentId}` }, installationKey);
    builder.upsertArtifact(artifactId, { carrier: 'executable', label: tool.label ?? tool.tool });
    const bindingId = bindingIdentity({
      placementId, artifactId, consumerKind: 'tool', consumerLabel: tool.label ?? tool.tool,
    }, installationKey);
    builder.addBinding({
      bindingId, placementId, artifactId, consumerKind: 'tool', consumerLabel: tool.label ?? tool.tool,
      mechanism: tool.installMethod ?? null, enabled: true, effectiveScope: 'machine', grade: 'verified',
      affectedByProposedAction: false,
    });
    const versions = tool.version ? { installed: tool.version } : {};
    if (tool.version) {
      builder.addVersion({
        ...assertion({
          subjectId: placementId, field: 'installedVersion', value: tool.version, grade: 'verified',
          authority: 'install scan', sourceRef: `install:${tool.tool}`, capturedAt: new Date(now()).toISOString(),
          scope: 'machine',
        }), axis: 'installed',
      });
    }
    finalizePlacement(builder, {
      placementId, resourceId, environmentId, administrativeScope: 'machine',
      locationBreadcrumb: ['Executables', tool.label ?? tool.tool], artifactIds: [artifactId],
      consumerBindingIds: [bindingId], conditions: ['healthy'],
      evidenceScorecard: scorecardFor([
        assertion({
          subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'install scan',
          sourceRef: 'install', capturedAt: new Date(now()).toISOString(),
        }),
        assertion({
          subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'install scan',
          sourceRef: 'install', capturedAt: new Date(now()).toISOString(),
        }),
      ]),
      displayName: tool.label ?? tool.tool, kind, hostNamespace: kind === 'host-adapter' ? tool.tool : undefined, consumerHosts: [], versions,
    });
  }
}

// ── storage reclaimables (cache, related-storage) ───────────────────────────

function mapStorageReclaimables(builder, reclaimables, ctx) {
  const { installationKey, now, environmentId } = ctx;
  for (const row of reclaimables ?? []) {
    if (!row?.id) continue;
    const kind = row.safety === 'regenerable' ? 'cache' : 'related-storage';
    const resourceId = resourceIdentity({ kind, sourceSelector: row.id }, installationKey);
    builder.upsertResource(resourceId, { kind, displayName: row.label ?? row.id });
    const placementId = placementIdentity({
      resourceId, environmentId, administrativeScope: 'machine', locationSelector: row.id,
    }, installationKey);
    if (typeof row.path === 'string' && row.path) builder.locate(placementId, { path: row.path });
    const artifactId = artifactIdentity({ carrier: 'cache-object', locator: row.id }, installationKey);
    builder.upsertArtifact(artifactId, { carrier: 'cache-object', label: row.label ?? row.id });
    const bindingId = bindingIdentity({
      placementId, artifactId, consumerKind: 'tool', consumerLabel: row.label ?? row.id,
    }, installationKey);
    builder.addBinding({
      bindingId, placementId, artifactId, consumerKind: 'tool', consumerLabel: row.label ?? row.id,
      mechanism: 'storage-scan', enabled: null, effectiveScope: 'machine', grade: 'verified',
      affectedByProposedAction: false,
    });
    finalizePlacement(builder, {
      placementId, resourceId, environmentId, administrativeScope: 'machine',
      locationBreadcrumb: ['Storage', row.label ?? row.id], artifactIds: [artifactId],
      consumerBindingIds: [bindingId],
      conditions: row.safety === 'regenerable' ? ['reproducible-cache'] : ['healthy'],
      evidenceScorecard: scorecardFor([
        assertion({
          subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'storage scan',
          sourceRef: 'storage', capturedAt: new Date(now()).toISOString(),
        }),
        assertion({
          subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'storage scan',
          sourceRef: 'storage', capturedAt: new Date(now()).toISOString(),
        }),
        assertion({
          subjectId: placementId, field: 'impact', value: row.rationale, grade: 'verified',
          authority: 'storage scan', sourceRef: 'storage', capturedAt: new Date(now()).toISOString(),
        }),
      ]),
      displayName: row.label ?? row.id, kind, consumerHosts: [],
      technicalDetails: row.rationale ? [row.rationale] : [],
    });
  }
}

// ── ranked storage consumers (related-storage root + breakdown children) ───

/** Consumer groups related to an agent host, model, runtime, provider, or
 *  developer tooling (ADR-0048 §4). `system` (generic OS/container data) and
 *  `project-trees` (already covered by project/instruction-file mapping) are
 *  the "generic user-home/system roots" this skips. */
const CONSUMER_ELIGIBLE_GROUPS = new Set(['ai-toolchain', 'node', 'rust', 'go', 'python', 'java', 'browsers']);

function consumerBytesValue(measurement) {
  if (measurement == null) return null;
  if (typeof measurement === 'number') return Number.isFinite(measurement) ? measurement : null;
  return typeof measurement.value === 'number' ? measurement.value : null;
}

function emitConsumerStoragePlacement(builder, ctx, { row, resourceId, isRoot, rootLabel = null }) {
  const { installationKey, now, environmentId } = ctx;
  const placementId = placementIdentity({
    resourceId, environmentId, administrativeScope: 'machine', locationSelector: row.id,
  }, installationKey);
  const artifactId = artifactIdentity({ carrier: 'storage-root', locator: row.id }, installationKey);
  builder.upsertArtifact(artifactId, { carrier: 'storage-root', label: row.label });
  const bindingId = bindingIdentity({
    placementId, artifactId, consumerKind: 'tool', consumerLabel: row.label,
  }, installationKey);
  builder.addBinding({
    bindingId, placementId, artifactId, consumerKind: 'tool', consumerLabel: row.label,
    mechanism: 'storage-consumer-scan', enabled: null, effectiveScope: 'machine', grade: 'verified',
    affectedByProposedAction: false,
  });
  const bytes = consumerBytesValue(row.bytes);
  const assertions = [
    assertion({
      subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'storage consumer scan',
      sourceRef: 'consumers', capturedAt: new Date(now()).toISOString(),
    }),
    assertion({
      subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'storage consumer scan',
      sourceRef: 'consumers', capturedAt: new Date(now()).toISOString(),
    }),
  ];
  // Impact (bytes) is added only where actually measured — an unmeasured or
  // partial figure is omitted rather than shown as a false zero.
  if (bytes != null) {
    assertions.push(assertion({
      subjectId: placementId, field: 'impact', value: bytes, grade: 'verified', authority: 'storage consumer scan',
      sourceRef: 'consumers', capturedAt: new Date(now()).toISOString(),
    }));
  }
  finalizePlacement(builder, {
    placementId, resourceId, environmentId, administrativeScope: 'machine',
    locationBreadcrumb: isRoot ? ['Storage', row.label] : ['Storage', rootLabel, row.label],
    artifactIds: [artifactId], consumerBindingIds: [bindingId], conditions: ['healthy'],
    evidenceScorecard: scorecardFor(assertions),
    displayName: row.label, kind: 'related-storage', consumerHosts: [],
    technicalDetails: row.accountingNote ? [row.accountingNote] : [],
  });
}

/**
 * Map the ranked-storage-consumers footprint section (footprint/consumers.mjs
 * `collectConsumers()`) to `related-storage` resources: one root-summary
 * placement per eligible root descriptor, and its `breakdown` children as
 * separate placements grouped under that SAME logical resource (MNT-INV-009).
 * No guidance and no versions — this is read-only ranking evidence, never an
 * action surface.
 */
function mapConsumerStorageRoots(builder, consumers, ctx) {
  const { installationKey } = ctx;
  const rows = (consumers?.rows ?? []).filter((row) => row.presence === 'present');
  const roots = rows.filter((row) => row.kind === 'root' && CONSUMER_ELIGIBLE_GROUPS.has(row.group));
  const rootById = new Map(roots.map((row) => [row.id, row]));
  const resourceIdByRootId = new Map();
  for (const root of roots) {
    const resourceId = resourceIdentity({ kind: 'related-storage', sourceSelector: `consumer-root:${root.id}` }, installationKey);
    builder.upsertResource(resourceId, { kind: 'related-storage', displayName: root.label });
    resourceIdByRootId.set(root.id, resourceId);
    emitConsumerStoragePlacement(builder, ctx, { row: root, resourceId, isRoot: true });
  }
  const children = rows.filter((row) => row.kind === 'breakdown' && rootById.has(row.containedBy));
  for (const child of children) {
    const root = rootById.get(child.containedBy);
    emitConsumerStoragePlacement(builder, ctx, {
      row: child, resourceId: resourceIdByRootId.get(root.id), isRoot: false, rootLabel: root.label,
    });
  }
}

// ── runtime daemons (orphaned-process) ──────────────────────────────────────

function mapDaemons(builder, daemons, ctx) {
  const { installationKey, now, environmentId } = ctx;
  const entries = daemons?.entries ?? [];
  if (entries.length === 0) return;
  const resourceId = resourceIdentity({ kind: 'executable', sourceSelector: 'ruflo-daemon' }, installationKey);
  builder.upsertResource(resourceId, { kind: 'executable', displayName: 'ruflo daemon' });
  entries.forEach((entry, index) => {
    const locationSelector = `${entry.pid ?? index}:${entry.workspace ?? index}`;
    const placementId = placementIdentity({
      resourceId, environmentId, administrativeScope: 'machine', locationSelector,
    }, installationKey);
    const artifactId = artifactIdentity({ carrier: 'executable', locator: locationSelector }, installationKey);
    builder.upsertArtifact(artifactId, { carrier: 'executable', label: 'ruflo daemon process' });
    const bindingId = bindingIdentity({
      placementId, artifactId, consumerKind: 'tool', consumerLabel: 'ruflo daemon',
    }, installationKey);
    builder.addBinding({
      bindingId, placementId, artifactId, consumerKind: 'tool', consumerLabel: 'ruflo daemon',
      mechanism: 'process-census', enabled: true, effectiveScope: 'machine', grade: 'verified',
      affectedByProposedAction: false,
    });
    const orphaned = entry.workspaceExists === false;
    finalizePlacement(builder, {
      placementId, resourceId, environmentId, administrativeScope: 'machine',
      locationBreadcrumb: ['Runtime', 'Daemons'], artifactIds: [artifactId], consumerBindingIds: [bindingId],
      conditions: [orphaned ? 'orphaned-process' : 'healthy'],
      evidenceScorecard: scorecardFor([
        assertion({
          subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'runtime census',
          sourceRef: 'runtime', capturedAt: new Date(now()).toISOString(),
        }),
        assertion({
          subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'runtime census',
          sourceRef: 'runtime', capturedAt: new Date(now()).toISOString(),
        }),
      ]),
      displayName: 'ruflo daemon', kind: 'executable', consumerHosts: [],
      technicalDetails: orphaned ? ['The daemon’s workspace no longer exists.'] : [],
    });
    if (entry.workspace) builder.locate(placementId, { path: entry.workspace });
  });
}

// ── models ───────────────────────────────────────────────────────────────

function modelConsumers(bindings, identity) {
  return bindings.filter((binding) => binding.identity === identity || binding.modelIdentity === identity);
}

function mapModel(builder, model, bindings, ctx) {
  const { installationKey, now, environmentId, modelStorage } = ctx;
  const resourceId = resourceIdentity({
    kind: 'model', hostNamespace: model.key.host, producer: model.key.provider,
    sourceSelector: model.key.modelId, definitionDigest: model.key.digest,
  }, installationKey);
  builder.upsertResource(resourceId, { kind: 'model', displayName: model.displayName, publisher: model.key.provider });
  const placementId = placementIdentity({
    resourceId, environmentId, administrativeScope: 'user', locationSelector: model.identity,
  }, installationKey);
  const artifactId = artifactIdentity({ carrier: 'model-revision', locator: model.identity }, installationKey);
  const storage = modelStorage?.[model.identity] ?? null;
  builder.upsertArtifact(artifactId, {
    carrier: 'model-revision', label: `${model.key.provider ?? model.key.host} model blob`,
    ...(model.key.digest ? { digest: model.key.digest } : {}),
    ...(storage ? {
      logicalBytes: storage.logicalBytes ?? null, physicalBytes: storage.physicalBytes ?? null,
      sharedBlobs: storage.sharedBlobs ?? null,
    } : {}),
  });
  const consumers = modelConsumers(bindings, model.identity);
  const bindingIds = [];
  for (const consumer of consumers) {
    const bindingId = bindingIdentity({
      placementId, artifactId, consumerKind: 'route', consumerLabel: consumer.consumer,
    }, installationKey);
    bindingIds.push(bindingId);
    builder.addBinding({
      bindingId, placementId, artifactId, consumerKind: 'route', consumerLabel: consumer.consumer,
      mechanism: 'kit-routing', enabled: consumer.consumerState !== 'unknown',
      effectiveScope: 'user', grade: consumer.consumerState === 'runtime-proven' ? 'verified' : 'provider-declared',
      affectedByProposedAction: true,
    });
  }
  const activeUse = consumers.some((consumer) => consumer.consumerState === 'runtime-proven');
  if (model.key.digest) {
    builder.addVersion({
      ...assertion({
        subjectId: placementId, field: 'installedVersion', value: model.key.digest, grade: 'verified',
        authority: `${model.key.host} model inventory`, sourceRef: 'model-inventory',
        capturedAt: new Date(now()).toISOString(),
      }), axis: 'contentDigest',
    });
  }
  builder.addProvenance(assertion({
    subjectId: placementId, field: 'provenance',
    value: { kind: 'provider-owned-configuration', label: model.key.provider ?? model.key.host },
    grade: 'verified', authority: `${model.key.host} model inventory`, sourceRef: 'model-inventory',
    capturedAt: new Date(now()).toISOString(),
  }));
  finalizePlacement(builder, {
    placementId, resourceId, environmentId, administrativeScope: 'user',
    locationBreadcrumb: [model.key.provider ?? model.key.host, 'Models'], artifactIds: [artifactId],
    consumerBindingIds: bindingIds, conditions: ['healthy'],
    evidenceScorecard: scorecardFor([
      assertion({
        subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'model inventory',
        sourceRef: 'model-inventory', capturedAt: new Date(now()).toISOString(),
      }),
      assertion({
        subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'model inventory',
        sourceRef: 'model-inventory', capturedAt: new Date(now()).toISOString(),
      }),
      assertion({
        subjectId: placementId, field: 'consumers', value: consumers.length, grade: 'verified',
        authority: 'model inventory', sourceRef: 'model-inventory', capturedAt: new Date(now()).toISOString(),
      }),
    ]),
    displayName: model.displayName, kind: 'model', consumerHosts: [...new Set(consumers.map((consumer) => consumer.host).filter((host) => HOST_IDS.has(host)))],
    versions: model.key.digest ? { contentDigest: model.key.digest } : {},
    extra: { activeUse },
  });
}

function mapModels(builder, modelSnapshot, ctx) {
  for (const model of modelSnapshot?.models ?? []) mapModel(builder, model, modelSnapshot?.bindings ?? [], ctx);
}

// ── providers and credential readiness ──────────────────────────────────────

function credentialReadinessFor(fact) {
  if (fact?.credential && ['not-configured', 'configured-not-checked', 'ready', 'check-failed', 'expired-renewal-needed'].includes(fact.credential)) {
    return fact.credential;
  }
  if (!fact?.credentialPresent) return 'not-configured';
  if (fact.reachable === true) return 'ready';
  if (fact.reachable === false) return 'check-failed';
  return 'configured-not-checked';
}

function mapProvider(builder, providerId, fact, ctx) {
  const { installationKey, now, environmentId } = ctx;
  const configResourceId = resourceIdentity({
    kind: 'provider-configuration', sourceSelector: providerId,
  }, installationKey);
  builder.upsertResource(configResourceId, { kind: 'provider-configuration', displayName: providerId });
  const configPlacementId = placementIdentity({
    resourceId: configResourceId, environmentId, administrativeScope: 'user', locationSelector: providerId,
  }, installationKey);
  const configArtifactId = artifactIdentity({ carrier: 'config-selector', locator: `provider:${providerId}` }, installationKey);
  builder.upsertArtifact(configArtifactId, { carrier: 'config-selector', label: `${providerId} provider configuration` });
  const configBindingId = bindingIdentity({
    placementId: configPlacementId, artifactId: configArtifactId, consumerKind: 'provider', consumerLabel: providerId,
  }, installationKey);
  builder.addBinding({
    bindingId: configBindingId, placementId: configPlacementId, artifactId: configArtifactId,
    consumerKind: 'provider', consumerLabel: providerId, mechanism: 'provider-configuration',
    enabled: fact?.configured ?? null, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: false,
  });
  finalizePlacement(builder, {
    placementId: configPlacementId, resourceId: configResourceId, environmentId, administrativeScope: 'user',
    locationBreadcrumb: ['Providers', providerId], artifactIds: [configArtifactId],
    consumerBindingIds: [configBindingId], conditions: fact?.reachable === false ? ['missing-verified-dependency'] : ['healthy'],
    evidenceScorecard: scorecardFor([
      assertion({
        subjectId: configPlacementId, field: 'identity', value: true, grade: 'verified',
        authority: 'provider detection', sourceRef: 'providers', capturedAt: new Date(now()).toISOString(),
      }),
      assertion({
        subjectId: configPlacementId, field: 'placement', value: true, grade: 'verified',
        authority: 'provider detection', sourceRef: 'providers', capturedAt: new Date(now()).toISOString(),
      }),
    ]),
    displayName: providerId, kind: 'provider-configuration', consumerHosts: [],
  });

  const credentialResourceId = resourceIdentity({
    kind: 'credential-readiness', sourceSelector: providerId,
  }, installationKey);
  builder.upsertResource(credentialResourceId, { kind: 'credential-readiness', displayName: `${providerId} credential` });
  const credentialPlacementId = placementIdentity({
    resourceId: credentialResourceId, environmentId, administrativeScope: 'user', locationSelector: `${providerId}:credential`,
  }, installationKey);
  const credentialArtifactId = artifactIdentity({ carrier: 'config-selector', locator: `credential:${providerId}` }, installationKey);
  builder.upsertArtifact(credentialArtifactId, { carrier: 'config-selector', label: `${providerId} credential mechanism` });
  const credentialBindingId = bindingIdentity({
    placementId: credentialPlacementId, artifactId: credentialArtifactId, consumerKind: 'provider', consumerLabel: providerId,
  }, installationKey);
  builder.addBinding({
    bindingId: credentialBindingId, placementId: credentialPlacementId, artifactId: credentialArtifactId,
    consumerKind: 'provider', consumerLabel: providerId, mechanism: fact?.credentialMechanism ?? null,
    enabled: fact?.credentialPresent ?? null, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: false,
  });
  const readiness = credentialReadinessFor(fact);
  finalizePlacement(builder, {
    placementId: credentialPlacementId, resourceId: credentialResourceId, environmentId, administrativeScope: 'user',
    locationBreadcrumb: ['Providers', providerId, 'Credentials'], artifactIds: [credentialArtifactId],
    consumerBindingIds: [credentialBindingId],
    conditions: readiness === 'configured-not-checked' ? ['credential-mechanism-not-checked'] : ['healthy'],
    evidenceScorecard: scorecardFor([
      assertion({
        subjectId: credentialPlacementId, field: 'identity', value: true, grade: 'verified',
        authority: 'provider detection', sourceRef: 'providers', capturedAt: new Date(now()).toISOString(),
      }),
      assertion({
        subjectId: credentialPlacementId, field: 'placement', value: true, grade: 'verified',
        authority: 'provider detection', sourceRef: 'providers', capturedAt: new Date(now()).toISOString(),
      }),
    ]),
    displayName: `${providerId} credential`, kind: 'credential-readiness', consumerHosts: [],
    extra: {
      credentialReadiness: readiness,
      ...(fact?.credentialMechanism ? { credentialMechanism: fact.credentialMechanism } : {}),
    },
  });
  builder.addEdge({
    fromPlacementId: configPlacementId, toId: credentialResourceId, kind: 'requires-credential',
    grade: 'verified', authority: 'provider detection',
  });
}

function normalizeProviderDetections(providerDetections) {
  if (!providerDetections) return {};
  if (providerDetections instanceof Map) return Object.fromEntries(providerDetections);
  if (providerDetections.providers) return providerDetections.providers;
  return providerDetections;
}

function mapProviders(builder, providerDetections, ctx) {
  const providers = normalizeProviderDetections(providerDetections);
  for (const [providerId, fact] of Object.entries(providers)) mapProvider(builder, providerId, fact, ctx);
}

// ── source-scan-incomplete backfill ──────────────────────────────────────

/** Placements whose environment has incomplete source coverage gain the
 *  `source-scan-incomplete` condition and technical detail. Never removes an
 *  existing condition or adds a claim of absence/totals (ADR-0048 §8). */
function applySourceCompleteness(placements, inventoryShell) {
  const cache = new Map();
  const complete = (environmentId) => {
    if (!cache.has(environmentId)) cache.set(environmentId, sourceComplete(inventoryShell, environmentId));
    return cache.get(environmentId);
  };
  for (const placement of placements) {
    if (complete(placement.environmentId)) continue;
    if (!placement.conditions.includes('source-scan-incomplete')) placement.conditions.push('source-scan-incomplete');
    if (!placement.technicalDetails.includes('Source scan incomplete')) placement.technicalDetails.push('Source scan incomplete');
  }
}

// ── environment/WSL cross-edges ─────────────────────────────────────────────

/** For every non-WSL environment placement that has a same-resource WSL
 *  counterpart, an explicit windows-hosts-wsl edge from the WSL placement to
 *  the Windows one (ADR-0048 §2: nothing crosses that boundary implicitly). */
function windowsHostsWslEdges(builder, environments) {
  const windows = environments.find((entry) => entry.kind === 'windows');
  if (!windows) return;
  const wslEnvironmentIds = new Set(environments.filter((entry) => entry.kind === 'wsl').map((entry) => entry.environmentId));
  if (wslEnvironmentIds.size === 0) return;
  const byResource = new Map();
  for (const placement of builder.placements) {
    if (!byResource.has(placement.resourceId)) byResource.set(placement.resourceId, []);
    byResource.get(placement.resourceId).push(placement);
  }
  for (const group of byResource.values()) {
    const windowsPlacement = group.find((placement) => placement.environmentId === windows.environmentId);
    if (!windowsPlacement) continue;
    for (const placement of group) {
      if (!wslEnvironmentIds.has(placement.environmentId)) continue;
      builder.addEdge({
        fromPlacementId: placement.placementId, toId: windowsPlacement.placementId, kind: 'windows-hosts-wsl',
        grade: 'verified', authority: 'wsl.exe --list', environmentRelation: 'windows-host',
      });
    }
  }
}

// ── top-level orchestration ─────────────────────────────────────────────────

function resolveEnvironments(environment, installationKey) {
  if (!environment?.platform) throw new TypeError('buildManagementInventory requires environment.platform');
  const environments = detectEnvironments({
    platform: environment.platform, release: environment.release, arch: environment.arch,
    wslDistributions: environment.wsl ?? [],
  }, installationKey);
  const environmentId = currentEnvironmentId(environments, {
    wslDistro: environment.currentWslDistro ?? null,
  });
  return { environments, environmentId };
}

function buildContext({ installationKey, now, environmentId, projects, discovery }) {
  return {
    installationKey, now, environmentId, projects,
    dependencyProbes: discovery.dependencyProbes ?? [],
    installResourceKinds: discovery.installResourceKinds ?? {},
    modelStorage: discovery.modelStorage ?? {},
  };
}

/** Run every resource-kind mapping stage. Each stage is independently a
 *  no-op on missing evidence, so partial input degrades gracefully rather
 *  than throwing. */
function runMappingStages(
  builder, { footprint, hookReadModel, modelSnapshot, providerDetections, discovery, byProjectId }, ctx,
) {
  mapCatalog(builder, footprint.catalog, ctx);
  mapHooks(builder, hookReadModel, ctx);
  mapInstallTools(builder, footprint.install?.tools, ctx);
  mapStorageReclaimables(builder, footprint.storage?.reclaimables, ctx);
  mapConsumerStorageRoots(builder, footprint.consumers, ctx);
  mapDaemons(builder, footprint.runtime?.daemons, ctx);
  mapModels(builder, modelSnapshot, ctx);
  mapProviders(builder, providerDetections, ctx);
  mapInstructionFiles(builder, discovery.instructionFiles, ctx);
  const representative = mapDiscoveryProjectInstructionFiles(builder, discovery.projects, ctx, byProjectId);
  deriveSubmoduleEdges(builder, discovery.projects, representative);
}

/** Unresolved receipts block nothing in the inventory itself (that's the
 *  transaction slice's job), but they DO surface as a placement condition:
 *  MNT non-negotiable #9's "recovery-receipt-open" is inventory evidence. */
function applyReceiptConditions(builder, receipts) {
  for (const receipt of receipts ?? []) {
    const placement = builder.placements.find((entry) => entry.placementId === receipt.affectedPlacementId);
    if (!placement) continue;
    if (!placement.conditions.includes('recovery-receipt-open')) placement.conditions.push('recovery-receipt-open');
  }
}

/** A path-free fingerprint: real source stamps carry filesystem paths
 *  (`{entries:[{path:'/Users/.../.agents/skills', ...}]}`), so the raw JSON
 *  can never be used directly (it would put a home-directory path in the
 *  inventory's own `sourceFingerprint` field). Hashed instead of truncated —
 *  a hex digest carries no path regardless of what the stamps contain. */
function sourceFingerprintFor(footprint) {
  const stamps = footprint?.catalog?.sourceStamps;
  return stamps ? createHash('sha256').update(canonicalJson(stamps)).digest('hex') : 'unfingerprinted';
}

function assembleInventoryShell(builder, { environments, sourceCoverage, footprint, now, installationKey }) {
  const dependencyEdges = deriveDependencyEdges({ descriptors: builder.edgeDescriptors, installationKey });
  const capturedAt = new Date(now()).toISOString();
  const sourceFingerprint = sourceFingerprintFor(footprint);
  const shell = {
    schemaVersion: MANAGEMENT_SCHEMA_VERSION,
    schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId: inventoryIdentity({ capturedAt, sourceFingerprint, placementCount: builder.placements.length }, installationKey),
    capturedAt,
    sourceFingerprint,
    environments,
    sourceCoverage,
    resources: [...builder.resources.values()],
    placements: builder.placements,
    artifacts: [...builder.artifacts.values()],
    consumerBindings: builder.bindings,
    provenanceAssertions: builder.provenanceAssertions,
    versionObservations: builder.versionObservations,
    dependencyEdges,
    conflictSets: [],
    guidanceEntries: [],
  };
  shell.conflictSets = classifyConflicts(shell, { installationKey });
  return shell;
}

/**
 * Build a privacy-projected ManagementInventory from already-collected
 * evidence. Never touches the filesystem, a process, or the network — every
 * fact came from the caller. See the module header for the accepted shape of
 * each option.
 *
 * @param {{ footprint?: *, modelSnapshot?: *, hookReadModel?: *, providerDetections?: *,
 *           receipts?: Array<*>, sourceCoverage?: Array<*>, discovery?: *,
 *           environment?: *, installationKey?: string, now?: () => number }} [options]
 * @returns {{ inventory: object, privateLocators: Map<string, object> }}
 */
export function buildManagementInventory({
  footprint = {}, modelSnapshot = null, hookReadModel = null, providerDetections = null,
  receipts = [], sourceCoverage = [], discovery = {}, environment = undefined, installationKey = undefined,
  now = Date.now,
} = {}) {
  if (!installationKey) throw new TypeError('buildManagementInventory requires an installationKey');
  const { environments, environmentId } = resolveEnvironments(environment, installationKey);

  const builder = createBuilder();
  const { registry: projects, byProjectId } = mapProjects(builder, {
    legacyRows: footprint?.projects?.projects ?? [], discoveryProjects: discovery.projects,
  }, { installationKey });
  // A project-scoped catalog presence whose path neither registry discovered
  // (an agent-managed worktree the census does not walk, for example) still
  // needs a real, opaque projectId — `project` placements may never carry a
  // null one. Filled in from the presence's own lexical root before catalog
  // mapping runs, so mapCatalogGroup's ordinary registry lookup finds it.
  registerFallbackProjectPaths(projects, projectPathsIn(footprint.catalog), { installationKey });
  // Add presentation evidence after identity assignment; a better label must
  // not change lexical project IDs or their action and receipt targets.
  for (const row of footprint?.catalog?.projectMetadata ?? []) {
    const entry = /** @type {{ projectKind?: string } | undefined} */ (projects.get(row.path));
    if (entry && (!entry.projectKind || entry.projectKind === 'unknown') && ['git', 'folder', 'worktree', 'unknown'].includes(row.projectKind)) entry.projectKind = row.projectKind;
  }
  const ctx = buildContext({ installationKey, now, environmentId, projects, discovery });

  runMappingStages(builder, {
    footprint, hookReadModel, modelSnapshot, providerDetections, discovery, byProjectId,
  }, ctx);
  applyReceiptConditions(builder, receipts);
  windowsHostsWslEdges(builder, environments);
  applySourceCompleteness(builder.placements, { sourceCoverage });

  const inventoryShell = assembleInventoryShell(builder, {
    environments, sourceCoverage, footprint, now, installationKey,
  });
  const inventory = assertManagementInventory(inventoryShell);
  return { inventory, privateLocators: builder.privateLocators };
}
