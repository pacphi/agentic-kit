// MCP
import { registrationStatus, agentBrowserMcpConfigured } from '../../../lib/mcp.mjs';
import { row } from '../row.mjs';

export default {
  id: 'mcp',
  async collect({ cfg }) {
    const rows = [];
    const mcp = registrationStatus();
    if (mcp.claudeFlow && !agentBrowserMcpConfigured(mcp.effective.claudeFlow, cfg.agentBrowser !== false)) {
      rows.push(row('mcp', 'warn',
        'claude-flow registration does not carry the managed agent-browser config',
        'setup/sync re-registers claude-flow with the process-scoped browser config'));
    } else if (mcp.claudeFlow) {
      rows.push(row('mcp', 'ok',
        `claude-flow registered (${mcp.claudeFlowScopes.join(', ')} scope)${mcp.denyCount ? `, ${mcp.denyCount} tool(s) denied by family exclusions` : ', all families allowed'}`));
    } else if (cfg.mcp.register) {
      rows.push(row('mcp', 'warn', 'ruflo MCP not registered', 'setup/sync registers claude-flow at user scope'));
    } else {
      rows.push(row('mcp', 'info', 'MCP registration disabled in kit.json'));
    }
    if (mcp.legacyRuflo) {
      const auto = mcp.autoMigratableLegacyScopes.length
        ? 'sync migrates it to claude-flow at user scope'
        : null;
      const preserved = mcp.preservedLegacyScopes.length
        ? `${mcp.preservedLegacyScopes.join(', ')} scope is reported but preserved` : null;
      rows.push(row('mcp', 'warn',
        `legacy 'ruflo'-keyed MCP registration present (${mcp.legacyRufloScopes.join(', ')})`,
        [auto, preserved].filter(Boolean).join('; ')));
    }
    return rows;
  },
};
