// Retired Claude→Codex `codex mcp-server` projection (ADR-0033). Its absence
// is healthy; setup/sync remove only the prior agentic-kit-owned entry.
// User-owned entries are preserved and receive an explicit manual remedy.
//
// Three independently-probed concerns share the codex-mcp subsystem tag, each
// with its own try/catch: one probe throwing must not silence the other two.
import { codexMcpStatus, codexMcpTopology, rufloCodexMcpStatus } from '../../../lib/mcp.mjs';
import { have } from '../../../lib/exec.mjs';
import { row } from '../row.mjs';

function legacyProjectionRows(cfg, cwd) {
  try {
    const { registered, owned } = codexMcpStatus(cfg, cwd);
    if (registered) {
      return [row('codex-mcp', 'warn',
        `deprecated codex mcp-server registered${owned ? ' — agentic-kit-owned' : ' — user-owned; preserved'}`,
        owned ? 'sync retires the legacy MCP entry' : 'remove manually: claude mcp remove codex -s project')];
    }
    return [row('codex-mcp', 'ok', 'legacy codex mcp-server absent; supervised cross-host execution uses ak run')];
  } catch (e) {
    return [row('codex-mcp', 'warn', `codex MCP check unavailable: ${e.message}`)];
  }
}

// Independent Ruflo MCP integration lets a Codex-driven session reach the
// same routing, swarm, and memory tools as Claude.
async function rufloIntegrationRows(cfg) {
  try {
    const { registered, owned, command, args } = rufloCodexMcpStatus(cfg);
    const workspacePinned = command === 'ak'
      && JSON.stringify(args) === JSON.stringify(['x', 'ruflo-mcp']);
    if (registered && owned && !workspacePinned) {
      return [row('codex-mcp', 'warn',
        'ak-owned ruflo MCP in codex uses the legacy cwd-only launcher',
        'sync migrates it to workspace-pinned project memory')];
    }
    if (registered) {
      return [row('codex-mcp', 'ok',
        `ruflo MCP registered in codex ([mcp_servers.ruflo])${owned ? ' — workspace memory pinned' : ' — pre-existing (not ak-managed)'}`)];
    }
    if (await have('codex')) {
      return [row('codex-mcp', 'warn', 'codex enabled but ruflo MCP not registered in codex',
        'sync registers the ruflo MCP into codex')];
    }
    return [];
  } catch (e) {
    return [row('codex-mcp', 'warn', `ruflo→codex MCP check unavailable: ${e.message}`)];
  }
}

// Effective project+user topology. These checks are independent of the
// agentic-kit ownership receipt because recursive/duplicate transports can
// stall a Codex-driven worker even when another tool created them.
function topologyRows(cwd) {
  const rows = [];
  try {
    const topology = codexMcpTopology({ cwd });
    if (topology.selfRegistrations.length) {
      const scopes = topology.selfRegistrations.map((entry) => entry.scope).join(', ');
      rows.push(row('codex-mcp', 'fail',
        `recursive codex → codex mcp-server registration detected (${scopes})`,
        'remove the [mcp_servers.codex] table from the reported Codex config before live multi-host runs'));
    }
    if (!topology.agenticQeRegistrations.length) {
      rows.push(row('codex-mcp', 'warn', 'agentic-qe MCP is not concretely registered in Codex',
        'run: aqe platform setup codex --overwrite --with-ruflo'));
    } else {
      rows.push(row('codex-mcp', 'ok', 'agentic-qe MCP concretely registered in Codex'));
    }
    if (topology.duplicateRuflo) {
      rows.push(row('codex-mcp', 'warn',
        `duplicate Ruflo MCP registrations in Codex: ${topology.rufloRegistrations.map((entry) => entry.name).join(', ')}`,
        'keep the workspace-aware [mcp_servers.ruflo] entry and remove legacy duplicates after reviewing ownership'));
    }
  } catch (e) {
    rows.push(row('codex-mcp', 'warn', `Codex MCP topology check unavailable: ${e.message}`));
  }
  return rows;
}

export default {
  id: 'codex-mcp',
  async collect({ cfg, cwd }) {
    if (!cfg.integrations?.hosts?.codex) return [];
    return [
      ...legacyProjectionRows(cfg, cwd),
      ...(await rufloIntegrationRows(cfg)),
      ...topologyRows(cwd),
    ];
  },
};
