// Per-activity routing (canonical routes → agentOverrides projection). Only surfaces
// once a policy is set; the dashboard renders this row like any other subsystem.
import * as paths from '../../../lib/paths.mjs';
import { readJson } from '../../../lib/settings.mjs';
import { aqeRouterFile, aqeSupportsAgentOverrides } from '../../../lib/providers.mjs';
import { configuredPolicyToAgentOverrides, agentOverridesDrift, routingSummary, divergedRoutes } from '../../../lib/routing.mjs';
import { row } from '../row.mjs';

function overridesSyncRow(base, cwd, policy) {
  // Same scope gate as the writer: applyAqeRouter anchors at repoRoot(cwd)
  // and declines outside a project — a raw-cwd read from a subdir would
  // false-warn "out of sync" (M2), and outside a project a warn would
  // recommend a sync that cannot repair it (#129).
  const root = paths.repoRoot(cwd);
  if (!root) {
    return row('routing', 'info', `${base} · not in a project — aqe router unmanaged here`);
  }
  const overrides = readJson(aqeRouterFile(root))?.agentOverrides;
  const drift = overrides == null || agentOverridesDrift(overrides, policy);
  return drift
    ? row('routing', 'warn', `${base} — llm-config.json out of sync`, 'sync re-applies agentOverrides')
    : row('routing', 'ok', base);
}

function divergedRow(policy) {
  // Seeded pins vs today's defaults. Deliberately `info` and deliberately
  // "diverges from": which side wins is activity-dependent (a newer default
  // can cost 2-3× the agentic turns on routine work), so a `warn` would push
  // users to spend turns clearing a lint. No `fix` — sync must never
  // auto-refresh a pin; `ak host refresh` is the opt-in path (#55).
  const diverged = divergedRoutes(policy);
  if (!diverged.length) return null;
  const pairs = [...new Set(diverged.flatMap((d) => [
    ...(d.modelDiverged ? [`${d.model} vs ${d.defaultModel}`] : []),
    ...d.escalation.map((e) => `${e.model} vs ${e.defaultModel} (escalation)`),
  ]))].join(', ');
  return row('routing', 'info',
    `${diverged.length} seeded route(s) diverge from current defaults (${pairs}) — ak host refresh`);
}

export default {
  id: 'routing',
  async collect({ cfg, cwd }) {
    const rows = [];
    try {
      const policy = cfg.routing?.routes ?? {};
      if (Object.keys(policy).length) {
        const s = routingSummary(policy);
        // The WRITER's projection (#129): applyAqeRouter materializes only
        // explicitly persisted routes, so status must count and compare the same
        // set — the resolved projection would demand entries sync never writes.
        const want = configuredPolicyToAgentOverrides(policy);
        const base = `dual-host · ${s.total} activities (${s.custom} custom) → ${Object.keys(want).length} agent overrides`;
        rows.push(aqeSupportsAgentOverrides()
          ? overridesSyncRow(base, cwd, policy)
          : row('routing', 'info', `${base} · needs agentic-qe ≥ 3.13.1 to materialize`));
        const diverged = divergedRow(policy);
        if (diverged) rows.push(diverged);
      }
    } catch (e) {
      rows.push(row('routing', 'warn', `routing check unavailable: ${e.message}`));
    }
    return rows;
  },
};
