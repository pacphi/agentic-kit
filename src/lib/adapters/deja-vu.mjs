import { createHash } from 'node:crypto';
import { run, have } from '../exec.mjs';
import { installedVersion, latestVersion, cmpVersions, isValidSemver } from '../versions.mjs';
import {
  DEJA_VU_BIN,
  DEJA_VU_MIN_VERSION,
  DEJA_VU_PACKAGE,
  DEJA_VU_TARGETS,
  buildDejaVuInstallCommand,
  buildDejaVuUninstallCommand,
  observeDejaVuTargets,
  parseDejaVuDoctor,
} from '../deja-vu.mjs';

const HOST_BINS = Object.freeze({ claude: 'claude', codex: 'codex', opencode: 'opencode' });
const MODES = Object.freeze(['mcp', 'auto']);
const DOCTOR_TIMEOUT_MS = 10_000;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const boolOrNull = (value) => typeof value === 'boolean' ? value : null;
const hashOrNull = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  ? value : null;

function targetSignature(observed) {
  const bounded = {
    mcp: boolOrNull(observed?.direct?.mcp),
    auto: boolOrNull(observed?.direct?.auto),
    mcpProjection: hashOrNull(observed?.projection?.mcp),
    autoProjection: hashOrNull(observed?.projection?.auto),
  };
  return createHash('sha256').update(JSON.stringify(bounded)).digest('hex');
}

function defaultTargetObserver({ doctor }) {
  const targets = doctor?.facts?.mcp?.targets ?? {};
  const direct = observeDejaVuTargets();
  return Object.fromEntries(Object.entries(DEJA_VU_TARGETS).map(([host, names]) => [host, {
    direct: {
      mcp: direct[host].direct.mcp ?? (targets[names.mcp] === 'wired' ? true
        : targets[names.mcp] === 'not-wired' || targets[names.mcp] === 'config-missing' ? false : null),
      auto: direct[host].direct.auto ?? (targets[names.auto] === 'wired' ? true
        : targets[names.auto] === 'not-wired' || targets[names.auto] === 'config-missing' ? false : null),
    },
    projection: direct[host].projection,
    plugin: direct[host].plugin,
  }]));
}

function intent(cfg) {
  const value = cfg?.integrations?.tools?.dejaVu ?? {};
  return {
    enabled: value.enabled === true,
    mode: MODES.includes(value.mode) ? value.mode : 'mcp',
    hosts: Array.isArray(value.hosts) ? [...value.hosts] : [],
    indexOnSetup: value.indexOnSetup !== false,
  };
}

function readOwnership(cfg) {
  const value = cfg?.integrations?.ownership?.dejaVu;
  return plain(value) ? value : {};
}

function hasOwnership(ownership) {
  return !!ownership.install
    || (plain(ownership.targets) && Object.keys(ownership.targets).length > 0);
}

function mutableOwnership(cfg) {
  cfg.integrations ??= {};
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.dejaVu ??= {};
  cfg.integrations.ownership.dejaVu.targets ??= {};
  return cfg.integrations.ownership.dejaVu;
}

function cleanupOwnership(cfg) {
  const all = cfg?.integrations?.ownership;
  const own = all?.dejaVu;
  if (!plain(own)) return;
  if (plain(own.targets) && Object.keys(own.targets).length === 0) delete own.targets;
  if (!own.install && Object.keys(own).length === 0) delete all.dejaVu;
  if (plain(all) && Object.keys(all).length === 0) delete cfg.integrations.ownership;
}

function installReceiptState(receipt, npmVersion) {
  if (!receipt) return 'missing';
  if (!plain(receipt) || receipt.owner !== 'agentic-kit' || receipt.method !== 'npm'
    || receipt.package !== DEJA_VU_PACKAGE || typeof receipt.written?.version !== 'string') {
    return 'malformed';
  }
  if (npmVersion === null) return 'absent';
  return npmVersion === receipt.written.version ? 'current' : 'drifted';
}

function boundedObservation(value) {
  return {
    direct: {
      mcp: boolOrNull(value?.direct?.mcp),
      auto: boolOrNull(value?.direct?.auto),
    },
    plugin: {
      present: boolOrNull(value?.plugin?.present),
      auto: boolOrNull(value?.plugin?.auto),
    },
    projection: {
      mcp: hashOrNull(value?.projection?.mcp),
      auto: hashOrNull(value?.projection?.auto),
    },
  };
}

function disabledFacts(desired) {
  const targets = Object.fromEntries(Object.keys(HOST_BINS).map((host) => [host, {
    selected: false,
    hostPresent: null,
    desiredTarget: null,
    direct: { mcp: null, auto: null },
    plugin: { present: null, auto: null },
    signature: targetSignature(null),
    receiptState: 'missing',
    ownership: 'none',
    satisfied: false,
    conflict: null,
  }]));
  return {
    desired,
    install: {
      binaryPresent: null,
      npmPresent: null,
      version: null,
      supported: null,
      ownership: 'none',
      receiptState: 'missing',
    },
    doctor: { state: 'skipped', reason: 'integration-disabled', schemaVersion: null },
    index: { state: 'unknown', staleStores: 0 },
    targets,
  };
}

function doctorHealth(facts) {
  if (!facts) return { state: 'unknown', storeIssues: 0, sqlite: 'unknown', policy: 'unknown', sync: 'unknown' };
  const unhealthyStoreStates = [
    'unreadable', 'parsed-zero', 'denied', 'needs-sqlite3', 'needs-zstd',
  ];
  const storeIssues = unhealthyStoreStates.reduce(
    (total, state) => total + (facts.stores?.states?.[state] ?? 0), 0)
    + (facts.stores?.partial ?? 0) + (facts.stores?.unchecked ?? 0);
  const sqlite = facts.sqlite3?.state ?? 'unknown';
  const policy = facts.policy?.state ?? 'unknown';
  const sync = facts.sync?.state ?? 'unknown';
  const degraded = storeIssues > 0 || sqlite !== 'ok'
    || policy === 'unreadable' || sync === 'unreadable';
  return { state: degraded ? 'degraded' : 'ok', storeIssues, sqlite, policy, sync };
}

function commandOperation(id, kind, built, extra = {}) {
  return { id, kind, command: built.command, args: [...built.args], ...extra };
}

function receiptMatches(receipt, host, signature) {
  return plain(receipt) && receipt.owner === 'agentic-kit'
    && receipt.host === host
    && MODES.includes(receipt.mode)
    && receipt.target === DEJA_VU_TARGETS[host]?.[receipt.mode]
    && receipt.written?.state === 'wired'
    && receipt.written?.mode === receipt.mode
    && receipt.written?.mechanism === 'direct-cli'
    && receipt.written?.precision === 'projection-sha256-v1'
    && typeof receipt.written?.signature === 'string'
    && receipt.written.signature === signature;
}

function targetProjectionPrecise(observed) {
  return (observed.direct.mcp !== true || observed.projection.mcp !== null)
    && (observed.direct.auto !== true || observed.projection.auto !== null);
}

function targetAbsent(observed) {
  return observed.direct.mcp === false && observed.direct.auto === false;
}

function targetSatisfied(observed, mode) {
  if (mode === 'auto') return observed.direct.auto === true || observed.plugin.auto === true;
  const mcpActive = observed.direct.mcp === true || observed.plugin.present === true;
  return mcpActive && observed.direct.auto !== true && observed.plugin.auto !== true;
}

function packageInstallCommand(version) {
  return {
    command: 'npm',
    args: ['install', '-g', `${DEJA_VU_PACKAGE}@${version}`, '--no-audit', '--no-fund'],
  };
}

const packageUninstallCommand = () => ({
  command: 'npm', args: ['uninstall', '-g', DEJA_VU_PACKAGE, '--no-audit', '--no-fund'],
});
const indexCommand = (rebuild = false) => ({
  command: DEJA_VU_BIN, args: ['index', ...(rebuild ? ['--rebuild'] : [])],
});

export function createDejaVuLifecycleAdapter(defaults = {}) {
  const runner = defaults.runner ?? run;
  const haveFn = defaults.haveFn ?? have;
  const packageVersionFn = defaults.packageVersionFn ?? installedVersion;
  const latestVersionFn = defaults.latestVersionFn ?? latestVersion;
  const compareVersions = defaults.compareVersions ?? cmpVersions;
  const observer = defaults.targetObserver ?? defaultTargetObserver;
  const clock = defaults.clock ?? (() => new Date().toISOString());

  const detect = async (request = {}) => {
    const cfg = request.cfg ?? {};
    const desired = intent(cfg);
    const ownership = readOwnership(cfg);
    if (!desired.enabled && !hasOwnership(ownership)) return disabledFacts(desired);
    const [binaryPresent, npmVersion, ...hostPresence] = await Promise.all([
      haveFn(DEJA_VU_BIN),
      packageVersionFn(DEJA_VU_PACKAGE),
      ...Object.values(HOST_BINS).map((bin) => haveFn(bin)),
    ]);
    let doctor = { state: 'skipped', reason: 'binary-missing', facts: null };
    if (binaryPresent) {
      const result = await runner(DEJA_VU_BIN, ['doctor', '--json', '--offline'], {
        timeout: DOCTOR_TIMEOUT_MS,
      });
      doctor = parseDejaVuDoctor(result.stdout);
      if (result.code !== 0 && doctor.state === 'ok') {
        doctor = { state: 'degraded', reason: 'doctor-command-failed', facts: doctor.facts };
      }
    }
    const observedRaw = await observer({ cfg, doctor, binaryPresent });
    const hosts = {};
    for (const [index, host] of Object.keys(HOST_BINS).entries()) {
      const observed = boundedObservation(observedRaw?.[host]);
      const signature = targetSignature(observed);
      const receipt = ownership.targets?.[host] ?? null;
      const receiptState = !receipt ? 'missing'
        : receiptMatches(receipt, host, signature) ? 'current' : 'drifted';
      const selected = desired.enabled && desired.hosts.includes(host);
      const active = selected && hostPresence[index] === true;
      const conflict = desired.mode === 'mcp' && (observed.direct.auto || observed.plugin.auto)
        ? 'external-auto-active'
        : receipt && receiptState !== 'current' ? 'ownership-drift' : null;
      hosts[host] = {
        selected,
        hostPresent: hostPresence[index] === true,
        desiredTarget: selected ? DEJA_VU_TARGETS[host][desired.mode] : null,
        direct: observed.direct,
        projection: observed.projection,
        plugin: observed.plugin,
        signature,
        receiptState,
        ownership: receiptState === 'current' ? 'agentic-kit'
          : (observed.direct.mcp || observed.direct.auto || observed.plugin.present) ? 'external' : 'none',
        satisfied: active && targetSatisfied(observed, desired.mode),
        conflict,
      };
    }
    const installState = installReceiptState(ownership.install, npmVersion);
    const version = doctor.facts?.version?.current ?? npmVersion;
    const facts = {
      desired,
      install: {
        binaryPresent,
        npmPresent: npmVersion !== null,
        version: typeof version === 'string' ? version : null,
        supported: typeof version === 'string'
          ? compareVersions(version, DEJA_VU_MIN_VERSION) >= 0 : null,
        ownership: installState === 'current' || installState === 'absent'
          ? 'agentic-kit' : binaryPresent || npmVersion ? 'external' : 'none',
        receiptState: installState,
      },
      doctor: {
        state: doctor.state,
        reason: doctor.reason,
        schemaVersion: doctor.facts?.schemaVersion ?? null,
        health: doctorHealth(doctor.facts),
      },
      index: doctor.facts?.index ?? { state: 'unknown', staleStores: 0 },
      targets: hosts,
    };
    const ownedUpgradeCanRepair = installState === 'current' && npmVersion !== null
      && compareVersions(npmVersion, DEJA_VU_MIN_VERSION) < 0;
    if (binaryPresent && doctor.state !== 'ok' && !ownedUpgradeCanRepair) {
      facts.error = `deja-doctor-${doctor.reason}`;
    }
    return facts;
  };

  const plan = async (request = {}) => {
    const facts = request.facts ?? await detect(request);
    const cfg = request.cfg ?? {};
    const ownership = readOwnership(cfg);
    const operations = [];
    const warnings = [];
    if (facts.error) return { changed: false, operations, warnings, error: facts.error };

    const allowUpgrade = request.allowUpgrade !== false && request.options?.allowUpgrade !== false;
    const needsInstallVersion = facts.desired.enabled && !facts.install.binaryPresent
      && facts.install.ownership !== 'external';
    const needsUpgradeVersion = facts.desired.enabled && allowUpgrade
      && facts.install.receiptState === 'current';
    let latest = null;
    if (needsInstallVersion || needsUpgradeVersion) {
      let candidate = null;
      try { candidate = await latestVersionFn(DEJA_VU_PACKAGE); } catch { /* bounded fallback below */ }
      if (isValidSemver(candidate)
        && compareVersions(candidate, DEJA_VU_MIN_VERSION) >= 0) {
        latest = candidate;
      } else if (needsInstallVersion || facts.install.supported === false) {
        latest = DEJA_VU_MIN_VERSION;
        warnings.push('deja-package-latest-unavailable-baseline-used');
      } else {
        warnings.push('deja-package-latest-unavailable');
      }
    }
    if (facts.desired.enabled && !facts.install.binaryPresent) {
      if (facts.install.ownership === 'external') {
        return { changed: false, operations, warnings, error: 'deja-external-install-unusable' };
      }
      operations.push(commandOperation('package-install', 'package-install', packageInstallCommand(latest), {
        version: latest,
      }));
    } else if (facts.desired.enabled && facts.install.supported === false) {
      if (facts.install.receiptState === 'current') {
        if (allowUpgrade) {
          operations.push(commandOperation('package-upgrade', 'package-upgrade', packageInstallCommand(latest), {
            version: latest,
          }));
        } else {
          warnings.push('deja-package-upgrade-suppressed');
        }
      } else {
        return { changed: false, operations, warnings, error: 'deja-external-version-unsupported' };
      }
    } else if (facts.desired.enabled && allowUpgrade && facts.install.receiptState === 'current'
      && latest && facts.install.version && compareVersions(latest, facts.install.version) > 0) {
      operations.push(commandOperation('package-upgrade', 'package-upgrade', packageInstallCommand(latest), {
        version: latest,
      }));
    }

    for (const [host, fact] of Object.entries(facts.targets)) {
      const receipt = ownership.targets?.[host];
      const shouldRemove = receipt && (!fact.selected || receipt.mode !== facts.desired.mode);
      if (shouldRemove) {
        if (fact.receiptState !== 'current') {
          warnings.push(`${host}-ownership-drift-preserved`);
        } else {
          operations.push(commandOperation(
            `target-remove-${host}`, 'target-remove',
            buildDejaVuUninstallCommand(host, receipt.mode),
            { host, mode: receipt.mode, signature: fact.signature },
          ));
        }
      }
      if (!fact.selected) continue;
      if (!fact.hostPresent) { warnings.push(`${host}-host-missing`); continue; }
      if (fact.conflict && !receipt) { warnings.push(`${host}-${fact.conflict}`); continue; }
      if (!fact.satisfied && !(receipt && shouldRemove && fact.receiptState !== 'current')) {
        operations.push(commandOperation(
          `target-install-${host}`, 'target-install',
          buildDejaVuInstallCommand(host, facts.desired.mode),
          { host, mode: facts.desired.mode },
        ));
      }
    }
    if (facts.desired.enabled && facts.desired.indexOnSetup
      && (['missing', 'stale'].includes(facts.index.state) || !facts.install.binaryPresent)) {
      operations.push(commandOperation('index', 'index', indexCommand(false)));
    }
    return { changed: operations.length > 0, operations, warnings };
  };

  async function execute(request, initialPlan) {
    const cfg = request.cfg;
    if (!cfg) throw new TypeError('deja-vu lifecycle apply requires cfg');
    const beforeOwnership = JSON.stringify(readOwnership(cfg));
    const actions = [];
    const errors = [];
    let changed = false;
    let indexRan = false;
    for (const operation of initialPlan.operations) {
      const fresh = await detect({ ...request, cfg });
      if (fresh.error && operation.kind !== 'package-install') {
        errors.push(fresh.error);
        break;
      }
      if (operation.kind === 'target-remove') {
        const fact = fresh.targets[operation.host];
        if (fact.receiptState !== 'current' || fact.signature !== operation.signature) {
          errors.push(`${operation.host}-collateral-uninstall-refused`);
          break;
        }
      }
      if (operation.kind === 'index' && indexRan) continue;
      const result = await runner(operation.command, operation.args, {
        timeout: ['package-install', 'package-upgrade'].includes(operation.kind) ? 600_000
          : operation.kind === 'index' ? 600_000 : 120_000,
      });
      if (result.code !== 0) {
        errors.push(`${operation.kind}-failed`);
        actions.push({ id: operation.id, status: 'failed', changed: false });
        break;
      }
      if (operation.kind === 'package-install' || operation.kind === 'package-upgrade') {
        const verifiedVersion = await packageVersionFn(DEJA_VU_PACKAGE);
        if (verifiedVersion !== operation.version || !(await haveFn(DEJA_VU_BIN))) {
          errors.push('package-install-unverified');
          break;
        }
        mutableOwnership(cfg).install = {
          owner: 'agentic-kit', method: 'npm', package: DEJA_VU_PACKAGE,
          prior: null, written: { version: verifiedVersion }, recordedAt: clock(),
        };
      } else if (operation.kind === 'target-remove') {
        const verified = await detect({ ...request, cfg });
        if (!targetAbsent(verified.targets[operation.host])) {
          errors.push(`${operation.host}-target-remove-unverified`);
          break;
        }
        delete mutableOwnership(cfg).targets[operation.host];
      } else if (operation.kind === 'target-install') {
        const verified = await detect({ ...request, cfg });
        const fact = verified.targets[operation.host];
        if (!targetSatisfied(fact, operation.mode)) {
          errors.push(`${operation.host}-target-install-unverified`);
          break;
        }
        if (!targetProjectionPrecise(fact)) {
          errors.push(`${operation.host}-target-observation-imprecise`);
          break;
        }
        mutableOwnership(cfg).targets[operation.host] = {
          owner: 'agentic-kit', host: operation.host,
          target: DEJA_VU_TARGETS[operation.host][operation.mode], mode: operation.mode,
          prior: { state: 'absent' },
          written: {
            state: 'wired', mode: operation.mode, mechanism: 'direct-cli',
            precision: 'projection-sha256-v1', signature: fact.signature,
          },
          recordedAt: clock(),
        };
      } else if (operation.kind === 'index') {
        indexRan = true;
        const verified = await detect({ ...request, cfg });
        if (verified.index.state !== 'ok') {
          errors.push('index-unverified');
          break;
        }
      }
      changed = true;
      actions.push({ id: operation.id, status: 'ok', changed: true });
    }
    cleanupOwnership(cfg);
    const verified = await detect({ ...request, cfg });
    const configChanged = JSON.stringify(readOwnership(cfg)) !== beforeOwnership;
    return {
      ok: errors.length === 0,
      changed,
      configChanged,
      facts: verified,
      actions,
      warnings: initialPlan.warnings ?? [],
      errors,
    };
  }

  return {
    id: 'deja-vu',
    detect,
    plan,
    async apply(request = {}) {
      const facts = request.facts ?? await detect(request);
      const planned = request.plan ?? await plan({ ...request, facts });
      if (planned.error) return { ok: false, changed: false, configChanged: false, errors: [planned.error] };
      return execute(request, planned);
    },
    async verify(request = {}) {
      // runLifecycle already performs detect before dispatching verify. Reuse
      // that immutable observation so structural verification executes the
      // offline doctor exactly once and cannot compare two different moments.
      const facts = request.facts ?? await detect(request);
      const errors = [];
      if (facts.error) errors.push(facts.error);
      if (facts.doctor?.health?.state === 'degraded') errors.push('deja-doctor-components-degraded');
      if (facts.desired.enabled && !facts.install.binaryPresent) errors.push('deja-binary-missing');
      for (const [host, fact] of Object.entries(facts.targets)) {
        if (fact.selected && fact.hostPresent && !fact.satisfied) errors.push(`${host}-target-unsatisfied`);
      }
      return { ok: errors.length === 0, changed: false, facts, errors };
    },
    async undo(request = {}) {
      const cfg = request.cfg;
      if (!cfg) throw new TypeError('deja-vu lifecycle undo requires cfg');
      const beforeOwnership = JSON.stringify(readOwnership(cfg));
      const own = readOwnership(cfg);
      const operations = [];
      const malformedReceipts = [];
      for (const [host, receipt] of Object.entries(own.targets ?? {})) {
        if (!Object.hasOwn(HOST_BINS, host) || !MODES.includes(receipt?.mode)) {
          malformedReceipts.push('target-ownership-receipt-malformed');
          continue;
        }
        const built = buildDejaVuUninstallCommand(host, receipt.mode);
        operations.push(commandOperation(`target-remove-${host}`, 'target-remove', built, {
          host, mode: receipt.mode,
        }));
      }
      const actions = [];
      const errors = [...malformedReceipts];
      let changed = false;
      for (const operation of operations) {
        const fresh = await detect({ ...request, cfg });
        const fact = fresh.targets[operation.host];
        if (fact.receiptState !== 'current') {
          errors.push(`${operation.host}-collateral-uninstall-refused`);
          continue;
        }
        const result = await runner(operation.command, operation.args, { timeout: 120_000 });
        if (result.code !== 0) { errors.push(`${operation.host}-target-remove-failed`); continue; }
        const verified = await detect({ ...request, cfg });
        if (!targetAbsent(verified.targets[operation.host])) {
          errors.push(`${operation.host}-target-remove-unverified`);
          continue;
        }
        delete mutableOwnership(cfg).targets[operation.host];
        changed = true;
        actions.push({ id: operation.id, status: 'ok', changed: true });
      }
      if (request.options?.removePackage && readOwnership(cfg).install) {
        const fresh = await detect({ ...request, cfg });
        if (fresh.install.receiptState !== 'current') {
          errors.push('package-uninstall-ownership-drift');
        } else if (Object.keys(readOwnership(cfg).targets ?? {}).length > 0) {
          errors.push('package-uninstall-targets-remain');
        } else {
          const built = packageUninstallCommand();
          const result = await runner(built.command, built.args, { timeout: 300_000 });
          if (result.code !== 0 || await packageVersionFn(DEJA_VU_PACKAGE) !== null) {
            errors.push('package-uninstall-failed');
          } else {
            delete mutableOwnership(cfg).install;
            changed = true;
            actions.push({ id: 'package-uninstall', status: 'ok', changed: true });
          }
        }
      }
      cleanupOwnership(cfg);
      return {
        ok: errors.length === 0,
        changed,
        configChanged: JSON.stringify(readOwnership(cfg)) !== beforeOwnership,
        facts: await detect({ ...request, cfg }), actions, errors,
      };
    },
  };
}

export const DEJA_VU_LIFECYCLE_ADAPTER = createDejaVuLifecycleAdapter();
