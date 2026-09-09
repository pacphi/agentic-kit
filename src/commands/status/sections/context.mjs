import { collectContextReport } from '../../../lib/context-report.mjs';
import { row } from '../row.mjs';

export default {
  id: 'context',
  async collect({ cfg }) {
    // The Codex section carries the complete report whenever it is present,
    // preserving its existing CLI and actionable sync contracts.
    if (cfg.integrations?.hosts?.codex || cfg.codexContext) return [];
    const contextReport = collectContextReport(cfg);
    if (!contextReport.hosts.length) return [];
    return [{ ...row('context', 'info', 'Host context controls not inspected; live session window and usage unverified'), contextReport }];
  },
};
