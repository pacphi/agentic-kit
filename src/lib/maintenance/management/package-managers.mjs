// ADR-0048 package-manager capability matrix (MNT-ACT-018, N-3 policy).
//
// This module states what each package manager can independently PROVE — not
// what Agentic Kit is authorized to execute. Coverage capabilities never grant
// install/upgrade authority (provider-and-action-policy.md "Package-manager
// coverage"). Nothing here spawns a process; `detectionCommand` is identity
// only, for a caller that already owns process execution (T's providers).
import { PACKAGE_MANAGERS, PACKAGE_MANAGER_RELEASE_MODELS } from './model.mjs';

/** @typedef {{ command: string, args: string[] }} DetectionCommand */

function detection(command, args) {
  return Object.freeze({ command, args: Object.freeze(args) });
}

// One capability row per manager. `capabilities` states what the manager can
// independently supply per provider-and-action-policy.md's minimum list;
// install/upgrade EXECUTION authority is never one of them.
const MATRIX = Object.freeze({
  homebrew: {
    detectionCommand: detection('brew', ['--version']),
    versionContractRange: 'Rolling release; capability-tested command contract with a documented minimum version.',
    capabilities: cap({ provenance: true, dependency: true }),
  },
  macports: {
    detectionCommand: detection('port', ['version']),
    versionContractRange: 'Rolling release; capability-tested command contract with a documented minimum version.',
    capabilities: cap({ provenance: true, dependency: true }),
  },
  apt: {
    detectionCommand: detection('apt-get', ['--version']),
    versionContractRange: 'OS-coupled; current supported release family plus three preceding families.',
    capabilities: cap({ provenance: true, dependency: true }),
  },
  dnf: {
    detectionCommand: detection('dnf', ['--version']),
    versionContractRange: 'OS-coupled; current supported release family plus three preceding families.',
    capabilities: cap({ provenance: true, dependency: true }),
  },
  pacman: {
    detectionCommand: detection('pacman', ['--version']),
    versionContractRange: 'Rolling release; capability-tested command contract with a documented minimum version.',
    capabilities: cap({ provenance: true, dependency: true }),
  },
  zypper: {
    detectionCommand: detection('zypper', ['--version']),
    versionContractRange: 'OS-coupled; current supported release family plus three preceding families.',
    capabilities: cap({ provenance: true, dependency: true }),
  },
  snap: {
    detectionCommand: detection('snap', ['version']),
    versionContractRange: 'Rolling release; capability-tested command contract with a documented minimum version.',
    capabilities: cap({ provenance: true }),
  },
  npm: {
    detectionCommand: detection('npm', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ provenance: true, dependency: true, candidate: true }),
  },
  pnpm: {
    detectionCommand: detection('pnpm', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ provenance: true, dependency: true, candidate: true }),
  },
  yarn: {
    detectionCommand: detection('yarn', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ provenance: true, dependency: true, candidate: true }),
  },
  bun: {
    detectionCommand: detection('bun', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ provenance: true, dependency: true, candidate: true }),
  },
  pip: {
    detectionCommand: detection('pip', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ dependency: true, candidate: true }),
  },
  pipx: {
    detectionCommand: detection('pipx', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ candidate: true }),
  },
  uv: {
    detectionCommand: detection('uv', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ dependency: true, candidate: true }),
  },
  cargo: {
    detectionCommand: detection('cargo', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ dependency: true, candidate: true }),
  },
  mise: {
    detectionCommand: detection('mise', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ candidate: true }),
  },
  asdf: {
    detectionCommand: detection('asdf', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ candidate: true }),
  },
  winget: {
    detectionCommand: detection('winget', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ provenance: true, candidate: true }),
  },
  chocolatey: {
    detectionCommand: detection('choco', ['--version']),
    versionContractRange: 'Semantic versioning; current major plus three preceding majors.',
    capabilities: cap({ provenance: true, candidate: true }),
  },
  scoop: {
    detectionCommand: detection('scoop', ['--version']),
    versionContractRange: 'Rolling release; capability-tested command contract with a documented minimum version.',
    capabilities: cap({ provenance: true, candidate: true }),
  },
});

function cap(overrides) {
  return Object.freeze({
    detection: true, installedVersion: true, provenance: false, dependency: false,
    candidate: false, procedure: true, verification: true, ...overrides,
  });
}

function assertManager(manager) {
  if (!PACKAGE_MANAGERS.includes(manager)) throw new TypeError(`unknown package manager: ${manager}`);
}

/** The full capability row for one package manager (MNT-ACT-018). */
export function packageManagerCapabilities(manager) {
  assertManager(manager);
  const row = MATRIX[manager];
  return Object.freeze({ id: manager, releaseModel: PACKAGE_MANAGER_RELEASE_MODELS[manager], ...row });
}

/** The whole matrix, one row per `PACKAGE_MANAGERS` entry. */
export function allPackageManagerCapabilities() {
  return PACKAGE_MANAGERS.map((manager) => packageManagerCapabilities(manager));
}

/** `'semver' | 'os-coupled' | 'rolling'` per PACKAGE_MANAGER_RELEASE_MODELS. */
export function releaseModel(manager) {
  assertManager(manager);
  return PACKAGE_MANAGER_RELEASE_MODELS[manager];
}

// ── Version comparison helpers (dotted-numeric; no semver parsing library) ─

function versionParts(value) {
  return String(value ?? '').trim().split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function majorOf(value) {
  return versionParts(value)[0] ?? 0;
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function semverRange({ detectedVersion, current }) {
  if (typeof current !== 'string' || !current) {
    return { supported: null, reason: 'no current version was supplied for this manager' };
  }
  const currentMajor = majorOf(current);
  const floorMajor = Math.max(0, currentMajor - 3);
  const detectedMajor = majorOf(detectedVersion);
  return {
    supported: detectedMajor >= floorMajor && detectedMajor <= currentMajor,
    floor: String(floorMajor), ceiling: current,
  };
}

function osCoupledRange({ detectedVersion, current, familyOrder }) {
  if (typeof current !== 'string' || !Array.isArray(familyOrder) || !familyOrder.length) {
    return { supported: null, reason: 'no supported OS release family order was supplied' };
  }
  const currentIndex = familyOrder.indexOf(current);
  const detectedIndex = familyOrder.indexOf(detectedVersion);
  if (currentIndex < 0 || detectedIndex < 0) {
    return { supported: null, reason: 'the detected or current OS release family is not in the known order' };
  }
  const floorIndex = Math.max(0, currentIndex - 3);
  return {
    supported: detectedIndex >= floorIndex && detectedIndex <= currentIndex,
    floor: familyOrder[floorIndex], ceiling: current,
  };
}

function rollingRange({ detectedVersion, minimumTested }) {
  if (typeof minimumTested !== 'string' || !minimumTested) {
    return { supported: null, reason: 'no documented minimum tested version was supplied' };
  }
  return {
    supported: compareVersions(detectedVersion, minimumTested) >= 0,
    floor: minimumTested, ceiling: null,
  };
}

/**
 * Whether `detectedVersion` falls within the N-3 tested contract for
 * `manager`, per its release model (provider-and-action-policy.md "N-3
 * interpretation"). `supported: null` means the range could not be
 * determined from the inputs supplied — a caller must then omit any
 * candidate/procedure claim rather than assume support (MNT-ACT-018).
 */
export function supportedRange(manager, detectedVersion, context = {}) {
  assertManager(manager);
  const model = PACKAGE_MANAGER_RELEASE_MODELS[manager];
  const base = model === 'semver'
    ? semverRange({ detectedVersion, current: context.current })
    : model === 'os-coupled'
      ? osCoupledRange({ detectedVersion, current: context.current, familyOrder: context.familyOrder })
      : rollingRange({ detectedVersion, minimumTested: context.minimumTested });
  return Object.freeze({ manager, releaseModel: model, detectedVersion, ...base });
}

/** True only when `supportedRange` is conclusively `true` (never on `null`). */
export function isWithinTestedContract(manager, detectedVersion, context = {}) {
  return supportedRange(manager, detectedVersion, context).supported === true;
}
