// MCP
import {
  registrationStatus, agentBrowserMcpConfigured, legacyRufloRemovalCommands, isClaudeLauncher, staleAkClaudeFlow,
} from '../../../lib/mcp.mjs';
import path from 'node:path';
import * as paths from '../../../lib/paths.mjs';
import { rufloMemoryLocation } from '../../../lib/ruflo-memory.mjs';
import { row } from '../row.mjs';

const ENABLE_REGISTRATION = 'set "mcp": { "register": true } in kit.json and run ak sync';

/** The store ak's launcher picks from `cwd` (B3-D1), in the words status uses. */
function launcherStore(cwd, home) {
  const location = rufloMemoryLocation(cwd, { home });
  return location.kind === 'user'
    ? `the user-level store ${location.dir} (this folder is ${location.reason})`
    : path.join(location.root, '.swarm');
}

/** How Claude Code's effective claude-flow entry starts Ruflo: through the
 *  launcher (and which store that picks from here), or ak's earlier
 *  `ruflo mcp start` form that sync moves onto the launcher. */
function launcherRows(mcp, managed, { cwd, home }) {
  const entry = mcp.effective?.claudeFlow;
  if (isClaudeLauncher(entry)) {
    return [row('mcp', 'ok', `Claude Code's Ruflo MCP starts through \`ak x ruflo-mcp\`; from here it uses ${launcherStore(cwd, home)}`)];
  }
  if (!staleAkClaudeFlow(entry)) return [];
  const message = 'claude-flow registration does not start through `ak x ruflo-mcp`, so a Claude Code session in a subfolder '
    + 'or outside a project picks its memory store (and MCP policy file) from that folder';
  return [managed
    ? row('mcp', 'warn', message, 'sync re-registers claude-flow through `ak x ruflo-mcp --host claude`')
    : row('mcp', 'warn', message, `re-register it as \`ak x ruflo-mcp --host claude\`, or ${ENABLE_REGISTRATION}`, { repair: 'manual' })];
}

/** Rows for one registrationStatus() snapshot. A legacy `ruflo` entry gets a
 *  sync fix only for the scopes register() actually migrates (the shared
 *  legacyRufloDisposition predicate); preserved scopes carry their removal
 *  command as a manual fix, so sync never plans work it will not do. With
 *  kit.json's mcp.register false, setup and sync register nothing, so every
 *  fix here is the user's (manual).
 *  @param {ReturnType<typeof registrationStatus>} mcp
 *  @param {any} cfg */
export function mcpRows(mcp, cfg, { cwd = process.cwd(), home = paths.home } = {}) {
  const rows = [];
  const managed = !!cfg.mcp?.register;
  if (mcp.claudeFlow && !agentBrowserMcpConfigured(mcp.effective.claudeFlow, cfg.agentBrowser !== false)) {
    const message = 'claude-flow registration does not carry the managed agent-browser config';
    rows.push(managed
      ? row('mcp', 'warn', message, 'setup/sync re-registers claude-flow with the process-scoped browser config')
      : row('mcp', 'warn', message,
        `add the agent-browser config to your own claude-flow registration, or ${ENABLE_REGISTRATION}`, { repair: 'manual' }));
  } else if (mcp.claudeFlow) {
    rows.push(row('mcp', 'ok',
      `claude-flow registered (${mcp.claudeFlowScopes.join(', ')} scope)${mcp.denyCount ? `, ${mcp.denyCount} tool(s) denied by family exclusions` : ', all families allowed'}`));
  }
  if (mcp.claudeFlow) {
    rows.push(...launcherRows(mcp, managed, { cwd, home }));
  } else if (cfg.mcp.register) {
    rows.push(row('mcp', 'warn', 'ruflo MCP not registered', 'setup/sync registers claude-flow at user scope'));
  } else {
    rows.push(row('mcp', 'info', 'MCP registration disabled in kit.json'));
  }
  if (mcp.autoMigratableLegacyScopes.length) {
    const message = "legacy 'ruflo'-keyed MCP registration present (user) — agentic-kit's earlier registration";
    rows.push(managed
      ? row('mcp', 'warn', message, 'sync migrates it to claude-flow at user scope')
      : row('mcp', 'warn', message,
        `${ENABLE_REGISTRATION} to migrate it, or remove it yourself: ${legacyRufloRemovalCommands(['user'])}`, { repair: 'manual' }));
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
  async collect({ cfg, cwd, home = paths.home }) {
    return mcpRows(registrationStatus({ cwd }), cfg, { cwd, home });
  },
};
