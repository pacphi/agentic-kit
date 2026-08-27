// MCP
import { registrationStatus } from '../../../lib/mcp.mjs';
import { row } from '../row.mjs';

export default {
  id: 'mcp',
  async collect({ cfg }) {
    const rows = [];
    const mcp = registrationStatus();
    if (mcp.claudeFlow) {
      rows.push(row('mcp', 'ok',
        `claude-flow registered (user scope)${mcp.denyCount ? `, ${mcp.denyCount} tool(s) denied by family exclusions` : ', all families allowed'}`));
    } else if (cfg.mcp.register) {
      rows.push(row('mcp', 'warn', 'ruflo MCP not registered', 'setup/sync registers claude-flow at user scope'));
    } else {
      rows.push(row('mcp', 'info', 'MCP registration disabled in kit.json'));
    }
    if (mcp.legacyRuflo) {
      rows.push(row('mcp', 'warn', "legacy 'ruflo'-keyed MCP registration present", 'sync migrates it to claude-flow'));
    }
    return rows;
  },
};
