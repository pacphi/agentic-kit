// Retired Claude→Codex `codex mcp-server` projection (ADR-0033). Its absence
// is healthy; setup/sync remove only the prior agentic-kit-owned entry.
// User-owned entries are preserved and receive an explicit manual remedy.
//
// Three independently-probed concerns share the codex-mcp subsystem tag, each
// with its own try/catch: one probe throwing must not silence the other two.
import {
  codexMcpStatus, codexMcpTopology, codexMcpRepairOutcome, rufloCodexMcpStatus,
} from '../../../lib/mcp.mjs';
import { have } from '../../../lib/exec.mjs';
import { row } from '../row.mjs';

/** The codex-mcp fixes that only sync's providers step performs
 *  (convergeProviderStack's retireCodexMcp and ensureRufloMcpInCodex). The
 *  codex-mcp-repair step removes recursive tables only, so `ak sync --skip
 *  providers` skips these fixes rather than planning them. */
export const CODEX_MCP_PROVIDER_FIXES = Object.freeze({
  retireLegacy: 'sync retires the legacy MCP entry',
  migrateRuflo: 'sync migrates it to workspace-pinned project memory',
  registerRuflo: 'sync registers the ruflo MCP into codex',
});

function legacyProjectionRows(cfg, cwd) {
  try {
    const { registered, owned } = codexMcpStatus(cfg, cwd);
    if (registered) {
      return [owned
        ? row('codex-mcp', 'warn', 'deprecated codex mcp-server registered — agentic-kit-owned',
          CODEX_MCP_PROVIDER_FIXES.retireLegacy)
        : row('codex-mcp', 'warn', 'deprecated codex mcp-server registered — user-owned; preserved',
          'claude mcp remove codex -s project', { repair: 'manual' })];
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
        CODEX_MCP_PROVIDER_FIXES.migrateRuflo)];
    }
    if (registered) {
      return [row('codex-mcp', 'ok',
        `ruflo MCP registered in codex ([mcp_servers.ruflo])${owned ? ' — workspace memory pinned' : ' — pre-existing (not ak-managed)'}`)];
    }
    if (await have('codex')) {
      return [row('codex-mcp', 'warn', 'codex enabled but ruflo MCP not registered in codex',
        CODEX_MCP_PROVIDER_FIXES.registerRuflo)];
    }
    return [];
  } catch (e) {
    return [row('codex-mcp', 'warn', `ruflo→codex MCP check unavailable: ${e.message}`)];
  }
}

// Effective project+user topology. These checks are independent of the
// agentic-kit ownership receipt because recursive/duplicate transports can
// stall a Codex-driven worker even when another tool created them. The
// agentic-qe check is gated on kit.json intent: with `aqe: false` the user
// opted out of AQE, so its Codex registration is neither expected nor advised.
// Each hazard's fix is a 'sync' repair only when sync's confirmed repair would
// clear it (codexMcpRepairOutcome); otherwise the user must review it.
function topologyRows(cwd, cfg) {
  const rows = [];
  try {
    const topology = codexMcpTopology({ cwd });
    const outcome = codexMcpRepairOutcome(topology);
    if (topology.selfRegistrations.length) {
      const scopes = topology.selfRegistrations.map((entry) => entry.scope).join(', ');
      rows.push(outcome.recursiveRepairable
        ? row('codex-mcp', 'fail', `recursive codex → codex mcp-server registration detected (${scopes})`,
          'sync removes the exact recursive [mcp_servers.codex] table after confirmation (backed up)')
        : row('codex-mcp', 'fail', `recursive codex → codex mcp-server registration detected (${scopes})`,
          'remove the [mcp_servers.codex] table from the reported Codex config before live multi-host runs',
          { repair: 'manual' }));
    }
    if (cfg.aqe !== false) {
      if (!topology.agenticQeRegistrations.length) {
        // Agentic-QE owns its Codex registration (ADR-0033); sync never writes it.
        rows.push(row('codex-mcp', 'warn', 'agentic-qe MCP is not concretely registered in Codex',
          'run: aqe platform setup codex --overwrite --with-ruflo', { repair: 'manual' }));
      } else {
        rows.push(row('codex-mcp', 'ok', 'agentic-qe MCP concretely registered in Codex'));
      }
    }
    if (topology.duplicateRuflo) {
      const names = topology.effectiveRufloRegistrations.map((entry) => entry.name).join(', ');
      rows.push(outcome.duplicateRepairable
        ? row('codex-mcp', 'warn', `duplicate Ruflo MCP registrations in Codex: ${names}`,
          'sync offers a backed-up repair and remembers approved user-scope legacy corrections')
        : row('codex-mcp', 'warn', `duplicate Ruflo MCP registrations in Codex: ${names} — custom entries sync will not remove`,
          `review the Codex config and remove the extra Ruflo table(s) yourself: ${[...new Set(topology.rufloRegistrations.map((entry) => entry.file))].join(', ')}`,
          { repair: 'manual' }));
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
      ...topologyRows(cwd, cfg),
    ];
  },
};
