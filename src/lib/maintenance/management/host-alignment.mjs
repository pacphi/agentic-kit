// Pure, path-free projection of the configuration evidence provider. The
// existing scope/project query and one-placement action flow remain canonical.
import { resourceIdentity, placementIdentity, artifactIdentity, bindingIdentity } from './identity.mjs';
import { assertion, scorecardFor } from './evidence.mjs';
import { finalizePlacement, hostLabel } from './projection-builder.mjs';
import { projectPresentation } from './projection-projects.mjs';

export function mapHostAlignment(builder, facts, ctx) {
  const { installationKey, environmentId, projects, now } = ctx;
  for (const entry of facts?.entries ?? []) {
    const project = entry.project ? projects.get(entry.project) : null;
    const scope = entry.scope === 'project' ? 'project' : 'user';
    const projectId = project?.projectId ?? null;
    const kind = 'mcp-registration';
    const resourceId = resourceIdentity({ kind, sourceSelector: entry.id }, installationKey);
    builder.upsertResource(resourceId, { kind, displayName: entry.name,
      description: entry.message, descriptionSource: 'Host alignment policy' });
    const placementId = placementIdentity({ resourceId, environmentId, administrativeScope: scope,
      projectId, locationSelector: entry.id }, installationKey);
    const artifactId = artifactIdentity({ carrier: 'config-selector', locator: entry.file }, installationKey);
    builder.upsertArtifact(artifactId, { carrier: 'config-selector', label: `${hostLabel(entry.host)} host configuration` });
    const bindingId = bindingIdentity({ placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(entry.host), mechanism: 'MCP' }, installationKey);
    builder.addBinding({ bindingId, placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(entry.host),
      mechanism: 'MCP', enabled: null, effectiveScope: scope, grade: 'verified', affectedByProposedAction: true });
    const evidence = ['identity', 'placement', 'consumers', 'impact'].map(field => assertion({
      subjectId: placementId, field, value: true, grade: 'verified', authority: 'configuration snapshot',
      sourceRef: 'host-alignment', capturedAt: new Date(now()).toISOString(), scope,
    }));
    finalizePlacement(builder, { placementId, resourceId, environmentId, administrativeScope: scope, projectId,
      locationBreadcrumb: project ? [...project.breadcrumb, hostLabel(entry.host), 'Host alignment'] : [hostLabel(entry.host), 'Host alignment'],
      artifactIds: [artifactId], consumerBindingIds: [bindingId],
      conditions: ['host-alignment-required', ...(entry.code === 'config-unassessed' ? ['source-scan-incomplete'] : [])],
      evidenceScorecard: scorecardFor(evidence), displayName: entry.name, kind,
      hostNamespace: entry.host, consumerHosts: [entry.host],
      technicalDetails: [entry.message, 'Native Ruflo and AQE provider routing is preserved.',
        entry.repairable ? 'One selected registration is corrected with a recovery backup; automatic dashboard Undo is unavailable.' : entry.remedy],
      extra: { hostAlignmentResourceId: entry.id, ...(project ? projectPresentation(project) : {}) },
    });
    builder.locate(placementId, { path: entry.file });
  }
}

export function hostAlignmentMatcher(placement, facts) {
  if (!facts?.complete || !placement.hostAlignmentResourceId) return null;
  const entry = facts.entries.find(e => e.id === placement.hostAlignmentResourceId && e.repairable);
  if (!entry || entry.scope !== placement.administrativeScope || !placement.consumerHosts.includes(entry.host)) return null;
  return { verb: 'repair-registration', operation: 'realign', outcome: 'Realign this host transport',
    verifiedPremises: ['placement', 'consumers', 'impact'],
    impact: { summary: 'Remove only this retired registration; retain a recovery backup.' },
    preserved: ['Other registrations', 'Ruflo and AQE native provider routing', 'Other projects'],
    findingResourceKey: { kind: 'mcpServer', id: entry.id, host: entry.host, scope: entry.scope },
  };
}
