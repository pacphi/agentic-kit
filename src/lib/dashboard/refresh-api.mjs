import { randomUUID } from 'node:crypto';
import { REFRESH_STRENGTHS, runRefresh as sharedRunRefresh } from '../refresh.mjs';
import { sendJson } from '../loopback-server.mjs';
import { readMaintenanceJson } from './maintenance-security.mjs';

export const REFRESH_POST_ROUTES = new Set(['/api/refresh']);
export const REFRESH_LOCAL_TIMEOUT_MS = 5 * 60_000;

/** One operation per dashboard server. Its public state never exposes stage results. */
export function createRefreshOperation({ stages, runRefresh = sharedRunRefresh }) {
  let current = null;
  const state = () => current ? { ...current, stages: current.stages.map(stage => ({ ...stage })) }
    : { running: false, lastRun: null };
  function start({ strength, projectTrees = false }) {
    if (current?.running) return null;
    current = { operationId: randomUUID(), running: true, strength, projectTrees, startedAt: new Date().toISOString(),
      finishedAt: null, ok: null, stages: [] };
    Promise.resolve().then(() => runRefresh({ strength, projectTrees, stages,
      onStage(event) {
        const index = current.stages.findIndex(stage => stage.id === event.id);
        if (index < 0) current.stages.push(event);
        else current.stages[index] = event;
      },
    })).then(outcome => {
      current.ok = outcome.ok;
      current.stages = outcome.stages.map(({ id, label, state: stageState, detail, elapsedMs }) =>
        ({ id, label, state: stageState, detail, elapsedMs }));
    }).catch(error => {
      current.ok = false;
      current.stages.push({ id: 'refresh', label: 'Refresh', state: 'failed',
        detail: error?.message ?? String(error), elapsedMs: 0 });
    }).finally(() => { current.running = false; current.finishedAt = new Date().toISOString(); });
    return state();
  }
  return { start, state };
}

/** Dashboard collaborators are already memoized by startDashboard. */
/** @param {{ cwd: string, pkgRoot?: string, getSystem: Function, getMaintenance: Function,
 *   refreshInventoryAfterProviderScan: Function, getHostReadiness: Function,
 *   statusCollect: Function, loadConfig: Function }} options */
export function dashboardRefreshStages({ cwd, getSystem, getMaintenance, refreshInventoryAfterProviderScan,
  getHostReadiness, statusCollect, loadConfig }) {
  return {
    async machine({ projectTrees }) {
      const result = await (await getSystem()).refreshDeep({ includeProjectTrees: projectTrees === true });
      const ok = result?.ok === true && result.persisted?.ok !== false;
      return { ok, detail: ok ? null : result?.error ?? 'the measurement did not finish' };
    },
    async maintenance() {
      const model = await (await getMaintenance()).scan({ deep: false });
      const { providersChecked, providersTotal } = model?.scan ?? {};
      const detail = Number.isInteger(providersChecked) && Number.isInteger(providersTotal)
        ? `checked ${providersChecked} of ${providersTotal} providers` : null;
      return { ok: true, detail };
    },
    async inventory({ strength }) {
      const result = await refreshInventoryAfterProviderScan({ measured: strength === 'machine' });
      return { ok: result != null, detail: result == null ? 'the inventory rebuild did not finish' : null };
    },
    async live() {
      const { runLiveChecks } = await import('../live-checks.mjs');
      const results = await runLiveChecks({ cfg: loadConfig(), cwd });
      const counts = new Map();
      for (const { status } of results) counts.set(status, (counts.get(status) ?? 0) + 1);
      return { ok: true, detail: results.length ? [...counts].map(([status, n]) => `${n} ${status}`).join(', ')
        : 'no live check applies' };
    },
    async local() {
      const status = await statusCollect();
      await getHostReadiness({ force: true });
      return { ok: !status?.error, detail: status?.error ?? null };
    },
  };
}

/** Authentication and same-origin policy are enforced by the server gate. */
export async function handleRefreshPost(req, res, operation) {
  let body;
  try { body = await readMaintenanceJson(req, { maxBytes: 4096 }); }
  catch (error) {
    const code = error.status ?? error.statusCode;
    sendJson(res, [400, 413, 415].includes(code) ? code : 400, { error: 'invalid refresh request' });
    return;
  }
  if (!body || Object.keys(body).some(key => !['strength', 'projectTrees'].includes(key))
    || !REFRESH_STRENGTHS.includes(body.strength)
    || (body.projectTrees !== undefined && typeof body.projectTrees !== 'boolean')
    || (body.projectTrees !== undefined && body.strength !== 'machine')) {
    sendJson(res, 400, { error: 'invalid refresh request' }); return;
  }
  const state = operation.start(body);
  if (!state) sendJson(res, 409, { error: 'a refresh is already running', state: operation.state() });
  else sendJson(res, 202, { started: true, state });
}

export function handleRefreshGet(res, operation) { sendJson(res, 200, operation.state()); }
