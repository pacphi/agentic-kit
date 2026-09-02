// Codex owns plugin installation, enablement, and refresh. Status is read-only;
// exact user-approved placement repair belongs to `ak heal hooks`, never sync.
import { inspectCodexPlugins } from '../../../lib/codex-plugins.mjs';
import { row } from '../row.mjs';

export default {
  id: 'codex-plugins',
  async collect() {
    const rows = [];
    try {
      const plugins = inspectCodexPlugins();
      if (plugins.issues.length) {
        if (plugins.configIssues?.length) {
          rows.push(row('codex-plugins', 'warn',
            `Codex config inspection issue: ${plugins.configIssues[0]}; repair config.toml, then rerun ak status before changing plugin state`));
        } else {
          const remediation = plugins.placementIssues?.length
            ? 'run ak heal hooks --host codex to preview an exact disablement, or disable it in Codex /plugins, then start a new session'
            : 'open Codex /plugins to refresh or disable it, then start a new session';
          rows.push(row('codex-plugins', 'warn',
            `${plugins.issues.length} Codex plugin compatibility issue(s): ${plugins.issues[0]}; `
            + remediation));
        }
      } else if (plugins.enabled.length) {
        const versions = plugins.plugins.map((plugin) => `${plugin.ref} (${plugin.version})`).join(', ');
        rows.push(row('codex-plugins', 'ok',
          `${plugins.enabled.length} enabled Codex plugin(s); newest cached hooks and skills pass known compatibility checks (${versions})`));
      }
    } catch (e) {
      rows.push(row('codex-plugins', 'warn', `Codex plugin check unavailable: ${e.message}`));
    }
    return rows;
  },
};
