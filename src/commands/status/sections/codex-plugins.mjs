// Codex owns plugin installation, enablement, and refresh. Inspect every
// explicitly enabled cached plugin's hooks and skills, but never attach a
// sync fix: the supported repair surface is Codex's /plugins UI followed by
// a fresh session.
import { inspectCodexPlugins } from '../../../lib/codex-plugins.mjs';
import { row } from '../row.mjs';

export default {
  id: 'codex-plugins',
  async collect() {
    const rows = [];
    try {
      const plugins = inspectCodexPlugins();
      if (plugins.enabled.length && plugins.issues.length) {
        rows.push(row('codex-plugins', 'warn',
          `${plugins.issues.length} Codex plugin compatibility issue(s): ${plugins.issues[0]}; `
          + 'open Codex /plugins to refresh or disable it, then start a new session'));
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
