// MCP
import {
  registrationStatus, agentBrowserMcpConfigured, legacyRufloRemovalCommands,
} from '../../../lib/mcp.mjs';
import { row } from '../row.mjs';

/** Rows for one registrationStatus() snapshot. A legacy `ruflo` entry gets a
 *  sync fix only for the scopes register() actually migrates (the shared
 *  legacyRufloDisposition predicate); preserved scopes carry their removal
 *  command as a manual fix, so sync never plans work it will not do.
 *  @param {ReturnType<typeof registrationStatus>} mcp
 *  @param {any} cfg */
export function mcpRows(mcp, cfg) {
  const rows = [];
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
  if (mcp.autoMigratableLegacyScopes.length) {
    rows.push(row('mcp', 'warn',
      "legacy 'ruflo'-keyed MCP registration present (user) — agentic-kit's earlier registration",
      'sync migrates it to claude-flow at user scope'));
  }
  if (mcp.preservedLegacyScopes.length) {
    const scopes = mcp.preservedLegacyScopes;
    rows.push(row('mcp', 'warn',
      `legacy 'ruflo'-keyed MCP registration present (${scopes.join(', ')}) — not agentic-kit's registration, so it is preserved; remove it yourself if unwanted`,
      legacyRufloRemovalCommands(scopes), { repair: 'manual' }));
  }
  return rows;
}

export default {
  id: 'mcp',
  async collect({ cfg, cwd }) {
    return mcpRows(registrationStatus({ cwd }), cfg);
  },
};
