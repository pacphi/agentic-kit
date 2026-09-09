// Dashboard reporting only: configuration/catalog evidence is never promoted
// to a live-session fact. Host capabilities and kit-owned controls differ.
const tokens = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

/** Build a shared, read-only reporting contract. Numeric host-wide windows
 * remain null when no active model/session has been established. Per-model
 * values describe the inspected native catalog/configuration, not sessions.
 * observedAt timestamps inspection; cacheFetchedAt timestamps its source. */
export function buildContextReport(cfg, codexStatus = null, { now = Date.now() } = {}) {
  const observedAt = new Date(now).toISOString();
  const hosts = Object.keys(LABELS)
    .filter(host => cfg.integrations?.hosts?.[host] === true || (host === 'codex' && cfg.codexContext))
    .map(host => {
      const base = {
        host, label: LABELS[host], enabled: cfg.integrations?.hosts?.[host] === true,
        managed: host === 'codex' && !!cfg.codexContext,
        state: 'not-inspected', source: 'integration-configuration', observedAt,
        cacheFetchedAt: null, runtimeVerified: false,
        modelCapacity: null, configuredRequest: null, effectiveWindow: null, usage: null,
        compaction: { configuredThreshold: null, scope: 'unverified', runtimeThreshold: null, control: 'not-inspected' },
        models: [], limitations: [],
      };
      if (host !== 'codex') {
        base.limitations = [
          'Context and compaction configuration not inspected; agentic-kit does not manage these controls.',
          'Live session window and usage unverified; historical input observations remain in Usage → Context.',
          ...(host === 'opencode' ? ['Native compaction controls differ by OpenCode version.'] : []),
        ];
        return base;
      }
      const status = codexStatus;
      base.observedAt = timestamp(status?.observedAt) ?? observedAt;
      if (!status?.available) {
        base.state = 'unavailable';
        base.source = 'native-catalog-and-user-config';
        base.limitations = [status?.reason || 'Codex context evidence unavailable.', 'Running client and session unverified.'];
        return base;
      }
      base.state = status.drifted ? 'drifted' : 'observed';
      base.source = 'native-catalog-and-user-config';
      base.cacheFetchedAt = timestamp(status.cacheFetchedAt);
      base.configuredRequest = tokens(status.configuredWindow);
      base.compaction = { configuredThreshold: tokens(status.autoCompactTokenLimit),
        scope: 'unverified', runtimeThreshold: null, control: 'user-owned' };
      base.models = (status.models || []).map(model => ({
        model: model.model, nativeWindow: tokens(model.nativeWindow), maximumWindow: tokens(model.maximumWindow),
        requestedWindow: tokens(model.requestedWindow), allocatedWindow: tokens(model.allocatedWindow),
        effectivePercent: tokens(model.effectivePercent), effectiveWindow: tokens(model.effectiveWindow),
      }));
      base.limitations = [
        'Per-model values derive from native catalog and user configuration; running client and session unverified.',
        'Configured compaction threshold is retained; active threshold and counting scope unverified.',
      ];
      return base;
    });
  return { schemaVersion: 1, observedAt, hosts };
}
