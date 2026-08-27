// The deja-vu companion status collector. Five concerns feed one orchestrator:
// error mapping, the install ladder, doctor health, the per-host target
// ladder, and the derived-index ladder. Each is its own small function so a
// change to one ladder can't accidentally reach into another; the
// orchestrator just assembles their rows in the same order the monolithic
// version used to push them.
import { companionLifecycleFor } from '../../lib/adapters/companion-lifecycle-registry.mjs';
import { row } from './row.mjs';

const DEJA_HOSTS = Object.freeze(['claude', 'codex', 'opencode']);
const SAFE_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function hasDejaVuOwnership(cfg) {
  const ownership = cfg?.integrations?.ownership?.dejaVu;
  return !!ownership?.install
    || (!!ownership?.targets && typeof ownership.targets === 'object'
      && Object.keys(ownership.targets).length > 0);
}

function safeDejaCode(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value)
    ? value : 'unavailable';
}

function safeDejaVersion(value) {
  return typeof value === 'string' && SAFE_VERSION.test(value) ? value : 'unknown';
}

function dejaErrorRow(facts, plan) {
  if (!facts?.error && !plan?.error) return null;
  const code = safeDejaCode(facts?.error ?? plan?.error);
  const external = code === 'deja-external-version-unsupported'
    || code === 'deja-external-install-unusable';
  return row('deja-vu', external ? 'warn' : 'fail', external
    ? `external deja-vu installation is not safely manageable (${code}); preserved`
    : `deja-vu health contract failed closed (${code})`);
}

function dejaInstallRows(facts, { enabled, hasOperation }) {
  const install = facts?.install ?? {};
  if (install.binaryPresent === false) {
    if (enabled && hasOperation('package-install')) {
      return [row('deja-vu', 'warn', 'deja-vu package missing',
        'sync installs the managed npm companion')];
    }
    if (install.ownership === 'external') {
      return [row('deja-vu', 'warn', 'external deja-vu package is unavailable; preserved')];
    }
    return [row('deja-vu', 'info', 'deja-vu package absent')];
  }
  if (install.binaryPresent === true) {
    const version = safeDejaVersion(install.version);
    if (hasOperation('package-upgrade')) {
      return [row('deja-vu', 'warn',
        `managed deja-vu ${version} has an available package upgrade`,
        'sync upgrades the owned npm companion')];
    }
    if (install.receiptState === 'drifted' || install.receiptState === 'malformed') {
      return [row('deja-vu', 'warn',
        `deja-vu ${version} package ownership receipt drifted; current installation preserved`)];
    }
    if (install.ownership === 'agentic-kit') {
      return [row('deja-vu', install.supported === false ? 'warn' : 'ok',
        `managed deja-vu ${version} package${install.supported === false ? ' is below v0.19.0' : ' is present'}`)];
    }
    return [row('deja-vu', 'info',
      `external deja-vu ${version} package detected; installation remains user-owned`)];
  }
  return [];
}

function dejaDoctorRows(facts) {
  if (facts?.doctor?.state !== 'ok') return [];
  if (facts.doctor.health?.state === 'degraded') {
    const issueCount = Number.isSafeInteger(facts.doctor.health.storeIssues)
      ? Math.min(facts.doctor.health.storeIssues, 999) : 0;
    return [row('deja-vu', 'warn',
      `deja-vu doctor schema v2 accepted but component health is degraded${issueCount > 0
        ? ` (${issueCount} bounded store issue${issueCount === 1 ? '' : 's'})` : ''}`)];
  }
  return [row('deja-vu', 'ok', 'deja-vu doctor schema v2 accepted')];
}

// Split from the ladder below purely to keep each function's cyclomatic
// complexity in range — the guard clause and its two derived booleans pull a
// lot of optional-chaining branches on their own.
function dejaTargetContext(host, { facts, cfg, hasOperation }) {
  const target = facts?.targets?.[host];
  const receipt = cfg?.integrations?.ownership?.dejaVu?.targets?.[host];
  const receiptPresent = !!receipt;
  if (!target || (!target.selected && !receiptPresent)) return null;
  const hasTargetOperation = hasOperation('target-remove', host)
    || hasOperation('target-install', host);
  const managedTransition = hasTargetOperation && receipt?.mode
    && receipt.mode !== facts?.desired?.mode;
  return { target, hasTargetOperation, managedTransition };
}

function dejaTargetRows(host, ctx) {
  const found = dejaTargetContext(host, ctx);
  if (!found) return [];
  const { target, hasTargetOperation, managedTransition } = found;
  if (target.receiptState === 'drifted') {
    return [row('deja-vu', 'warn', `${host}: managed target ownership drifted; current wiring preserved`)];
  }
  if (target.conflict === 'external-auto-active' && !managedTransition) {
    return [row('deja-vu', 'warn',
      `${host}: external automatic recall conflicts with MCP-only intent; external state preserved`)];
  }
  if (target.satisfied) {
    return [row('deja-vu', target.ownership === 'agentic-kit' ? 'ok' : 'info',
      `${host}: ${target.desiredTarget ?? 'deja-vu'} target active`
      + (target.ownership === 'agentic-kit' ? ' and receipt-owned' : ' via external wiring'))];
  }
  if (hasTargetOperation) {
    return [row('deja-vu', 'warn',
      `${host}: managed deja-vu target requires convergence`,
      `sync converges the exact ${host} target`)];
  }
  if (target.hostPresent === false) {
    return [row('deja-vu', 'warn', `${host}: selected host is unavailable; companion wiring skipped`)];
  }
  return [row('deja-vu', 'warn', `${host}: desired deja-vu target is not proven; external state preserved`)];
}

function dejaIndexRows(facts, { enabled, hasOperation }) {
  if (!(enabled && facts?.desired?.indexOnSetup)) return [];
  if (facts?.index?.state === 'ok') return [row('deja-vu', 'ok', 'deja-vu derived index is healthy')];
  if (hasOperation('index')) {
    return [row('deja-vu', 'warn',
      `deja-vu derived index is ${['missing', 'stale'].includes(facts?.index?.state)
        ? facts.index.state : 'not ready'}`,
      'sync runs one bounded deja index after target convergence')];
  }
  if (facts?.index?.state === 'stale-readonly') {
    return [row('deja-vu', 'warn', 'deja-vu derived index is stale-readonly; automatic repair is unsafe')];
  }
  if (facts?.index?.state !== undefined) {
    return [row('deja-vu', 'info', 'deja-vu derived index health is unknown')];
  }
  return [];
}

/**
 * Render the managed companion from its bounded lifecycle facts. No upstream
 * path, command output, signature, transcript metadata, or plugin payload is
 * copied into a row. A fix is attached only when the same adapter plan contains
 * an operation that can perform it.
 * @param {{cfg?:any,adapter?:any,planOptions?:Record<string,any>}} [options]
 */
export async function collectDejaVuRows(options = {}) {
  const {
    cfg,
    adapter = companionLifecycleFor('deja-vu'),
    planOptions = {},
  } = options;
  const desired = cfg?.integrations?.tools?.dejaVu;
  const enabled = desired?.enabled === true;
  const owned = hasDejaVuOwnership(cfg);
  if (!enabled && !owned) {
    return [row('deja-vu', 'info',
      'deja-vu disabled — package, host wiring, and history remain unprobed')];
  }
  if (!adapter) {
    return [row('deja-vu', 'warn', 'deja-vu lifecycle adapter unavailable')];
  }

  try {
    const facts = await adapter.detect({ cfg });
    const plan = await adapter.plan({ cfg, facts, options: planOptions });
    const operations = Array.isArray(plan?.operations) ? plan.operations : [];
    const actionable = !facts?.error && !plan?.error;
    const hasOperation = (kind, host = null) => actionable && operations.some((operation) =>
      operation?.kind === kind && (host === null || operation.host === host));

    const rows = [
      dejaErrorRow(facts, plan),
      ...dejaInstallRows(facts, { enabled, hasOperation }),
      ...dejaDoctorRows(facts),
      ...DEJA_HOSTS.flatMap((host) => dejaTargetRows(host, { facts, cfg, hasOperation })),
      ...dejaIndexRows(facts, { enabled, hasOperation }),
    ].filter(Boolean);

    if (plan?.warnings?.includes('deja-package-latest-unavailable')) {
      rows.push(row('deja-vu', 'warn',
        'managed deja-vu package is usable, but npm latest-version drift could not be verified'));
    }

    return rows.length ? rows : [row('deja-vu', 'info', 'deja-vu state is unobserved')];
  } catch {
    return [row('deja-vu', 'warn', 'deja-vu status unavailable')];
  }
}
