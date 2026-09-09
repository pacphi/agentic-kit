import { inspectCodexContext } from '../../../lib/codex-context.mjs';
import { buildContextReport } from '../../../lib/context-report.mjs';
import { row } from '../row.mjs';

export default {
  id: 'codex-context',
  async collect({ cfg }) {
    if (!cfg.integrations?.hosts?.codex && !cfg.codexContext) return [];
    const status = inspectCodexContext(cfg);
    const rows = collectRows(status);
    rows[0].contextReport = buildContextReport(cfg, status);
    return rows;
  },
};

function collectRows(status) {
  if (!status.owned) return [row('codex-context', 'info', 'Codex context is unmanaged; opt in with `ak x codex-context max`')];
  if (!status.available) return [row('codex-context', 'warn', `managed Codex context unavailable: ${status.reason}`)];
  if (!status.enabled) return [row('codex-context', 'warn', 'Codex context ownership retained while host is disabled; use `ak x codex-context off` to restore')];
  if (status.drifted) return [row('codex-context', 'warn', 'managed Codex context request has drifted', 'sync restores the native maximum request')];
  const rows = [row('codex-context', 'ok', `native maximum request ${status.configuredWindow}; per-model limits apply to new sessions (cache client ${status.clientVersion}; running client and session unverified)`)];
  for (const m of status.models) rows.push(row('codex-context/model', 'info', `${m.model}: ${m.effectiveWindow} effective / ${m.maximumWindow} native maximum`));
  if (status.autoCompactTokenLimit) rows.push(row('codex-context', 'info', `user auto-compaction threshold ${status.autoCompactTokenLimit} retained`));
  return rows;
}
