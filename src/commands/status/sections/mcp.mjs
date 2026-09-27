// MCP
import {
  registrationStatus, agentBrowserMcpConfigured, legacyRufloRemovalCommands, isClaudeLauncher, staleAkClaudeFlow,
  claudeLauncherUnavailable,
} from '../../../lib/mcp.mjs';
import path from 'node:path';
import * as paths from '../../../lib/paths.mjs';
import { rufloMemoryLocation } from '../../../lib/ruflo-memory.mjs';
import { row } from '../row.mjs';

const ENABLE_REGISTRATION = 'set "mcp": { "register": true } in kit.json and run ak sync';
// register() writes a registration that starts `ak` only when the PATH `ak`
// can run the launcher (claudeLauncherUnavailable); until then that sync step
// fails every run, so the fix is the user's.
const LAUNCHER_FIX = {
  'ak-not-on-path': 'put `ak` on PATH, then run `ak sync`',
  'ak-launcher-outdated': 'update the `ak` on PATH (it predates `ak x ruflo-mcp --host`), then run `ak sync`',
};

/** The row for a fix that sync performs through register(): manual while
 *  the PATH `ak` cannot start the launcher, since register() then refuses. */
function registerRow(level, message, fix, launcher) {
  return launcher ? row('mcp', level, message, LAUNCHER_FIX[launcher], { repair: 'manual' }) : row('mcp', level, message, fix);
}

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
function launcherRows(mcp, managed, { cwd, home, launcher }) {
  const entry = mcp.effective?.claudeFlow;
  if (isClaudeLauncher(entry)) {
    return [row('mcp', 'ok', `Claude Code's Ruflo MCP starts through \`ak x ruflo-mcp\`; from here it uses ${launcherStore(cwd, home)}`)];
  }
  if (!staleAkClaudeFlow(entry)) return [];
  const message = 'claude-flow registration does not start through `ak x ruflo-mcp`, so a Claude Code session in a subfolder '
    + 'or outside a project picks its memory store (and MCP policy file) from that folder';
  return [managed
    ? registerRow('warn', message, 'sync re-registers claude-flow through `ak x ruflo-mcp --host claude`', launcher)
    : row('mcp', 'warn', message, `re-register it as \`ak x ruflo-mcp --host claude\`, or ${ENABLE_REGISTRATION}`, { repair: 'manual' })];
}

/** Rows for one registrationStatus() snapshot. A legacy `ruflo` entry gets a
 *  sync fix only for the scopes register() actually migrates (the shared
 *  legacyRufloDisposition predicate); preserved scopes carry their removal
 *  command as a manual fix, so sync never plans work it will not do. With
 *  kit.json's mcp.register false, setup and sync register nothing, so every
 *  fix here is the user's (manual). With `launcher` set (a
 *  claudeLauncherUnavailable reason), a fix that goes through register() is
 *  manual too: register() refuses to write a registration that starts `ak`
 *  until the PATH `ak` can run the launcher.
 *  @param {ReturnType<typeof registrationStatus>} mcp
 *  @param {any} cfg */
export function mcpRows(mcp, cfg, { cwd = process.cwd(), home = paths.home, launcher = null } = {}) {
  const rows = [];
  const managed = !!cfg.mcp?.register;
  if (mcp.claudeFlow && !agentBrowserMcpConfigured(mcp.effective.claudeFlow, cfg.agentBrowser !== false)) {
    const message = 'claude-flow registration does not carry the managed agent-browser config';
    rows.push(managed
      ? registerRow('warn', message, 'setup/sync re-registers claude-flow with the process-scoped browser config', launcher)
      : row('mcp', 'warn', message,
        `add the agent-browser config to your own claude-flow registration, or ${ENABLE_REGISTRATION}`, { repair: 'manual' }));
  } else if (mcp.claudeFlow) {
    rows.push(row('mcp', 'ok',
      `claude-flow registered (${mcp.claudeFlowScopes.join(', ')} scope)${mcp.denyCount ? `, ${mcp.denyCount} tool(s) denied by family exclusions` : ', all families allowed'}`));
  }
  if (mcp.claudeFlow) {
    rows.push(...launcherRows(mcp, managed, { cwd, home, launcher }));
  } else if (cfg.mcp.register) {
    rows.push(registerRow('warn', 'ruflo MCP not registered', 'setup/sync registers claude-flow at user scope', launcher));
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

/** Would sync call register() to write a registration? The same conditions
 *  as the rows above that name it, so the launcher is asked only then. */
function registerWouldWrite(mcp, cfg) {
  if (!cfg.mcp?.register) return false;
  if (!mcp.claudeFlow) return true;
  return !agentBrowserMcpConfigured(mcp.effective.claudeFlow, cfg.agentBrowser !== false)
    || staleAkClaudeFlow(mcp.effective?.claudeFlow);
}

export default {
  id: 'mcp',
  async collect({ cfg, cwd, home = paths.home, launcherCheck = claudeLauncherUnavailable, status = registrationStatus }) {
    const mcp = status({ cwd });
    const launcher = registerWouldWrite(mcp, cfg) ? await launcherCheck() : null;
    return mcpRows(mcp, cfg, { cwd, home, launcher });
  },
};
