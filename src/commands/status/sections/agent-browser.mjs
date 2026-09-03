// Ruflo browser executor. Disk-only by design: status never runs `doctor`,
// starts Chrome, or cleans daemon sidecars.
import { inspectAgentBrowser, AGENT_BROWSER_RUFLO_RANGE } from '../../../lib/agent-browser.mjs';
import { row } from '../row.mjs';

export default {
  id: 'agent-browser',
  async collect({ cfg }) {
    if (cfg.agentBrowser === false) {
      return [row('agent-browser', 'info', 'managed Ruflo browser executor disabled in kit.json')];
    }
    const state = inspectAgentBrowser(cfg);
    if (!state.supported) {
      return [row('agent-browser', 'warn', 'agent-browser requires Node 22+; no install attempted')];
    }
    if (!state.package.present) {
      return [row('agent-browser', 'warn', `agent-browser ${state.target} not installed`,
        `sync installs exact Ruflo-compatible agent-browser ${state.target}`)];
    }
    if (!state.package.compatible) {
      const owner = state.package.ownership === 'agentic-kit' ? 'Kit-owned' : 'external';
      return [row('agent-browser', 'warn',
        `${owner} agent-browser ${state.package.version} is outside Ruflo ${AGENT_BROWSER_RUFLO_RANGE}; preserved`,
        state.package.ownership === 'agentic-kit' ? 'sync restores the receipt-owned compatible version' : null)];
    }
    if (!state.package.native) {
      return [row('agent-browser', 'fail',
        `agent-browser ${state.package.version} package present but native executable missing`,
        state.package.ownership === 'agentic-kit' ? 'sync reinstalls and verifies the native CLI' : null)];
    }
    if (state.package.receiptState === 'drifted') {
      return [row('agent-browser', 'warn',
        `agent-browser ${state.package.version} drifted from its ownership receipt; preserved for manual review`)];
    }
    if (state.package.receiptState === 'legacy') {
      return [row('agent-browser', 'warn',
        `agent-browser ${state.package.version} ownership receipt needs a verified native digest`,
        'sync verifies the package-owned CLI and refreshes its ownership receipt')];
    }
    if (state.config.state === 'external' || state.config.state === 'drifted') {
      return [row('agent-browser', 'warn',
        `trusted Ruflo browser config is ${state.config.state}; preserved for manual review`)];
    }
    if (state.config.state !== 'current' || !state.config.valid) {
      return [row('agent-browser', 'warn', 'trusted Ruflo browser config is missing or incomplete',
        'sync writes the receipt-owned process-scoped config')];
    }
    if (!state.browser) {
      if (!state.browserPayload.autoInstallSupported) {
        return [row('agent-browser', 'warn',
          `agent-browser ${state.package.version} CLI ready; Chrome for Testing is unavailable on ${state.browserPayload.platform}/${state.browserPayload.arch}; provide a compatible Chromium/Chrome executable`)];
      }
      return [row('agent-browser', 'warn',
        `agent-browser ${state.package.version} CLI ready but no local Chrome payload was found`,
        'sync downloads Chrome for Testing without privileged OS dependencies')];
    }
    const owner = state.package.ownership === 'agentic-kit' ? 'Kit-managed' : 'external/self-managed';
    return [row('agent-browser', 'ok',
      `agent-browser ${state.package.version} ready for Ruflo (${owner}; ${state.browser.source})`)];
  },
};
