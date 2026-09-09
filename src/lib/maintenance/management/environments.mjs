// ADR-0048 environment identity (domain-model.md "EnvironmentIdentity"). Pure
// over injected platform facts — this module never shells out, reads
// /proc, or calls `wsl.exe`. Each WSL distribution is a separate Linux
// environment carrying an explicit `parentEnvironmentId` edge back to its
// Windows host; nothing here crosses that edge automatically (ADR-0048 §2).
import { ENVIRONMENT_KINDS } from './model.mjs';
import { environmentIdentity } from './identity.mjs';

const OS_FAMILY_BY_PLATFORM = Object.freeze({ darwin: 'macos', linux: 'linux', win32: 'windows' });

function windowsEnvironment({ release, arch, installationKey }) {
  return {
    environmentId: environmentIdentity({ kind: 'windows', host: 'this-machine' }, installationKey),
    kind: 'windows', osFamily: 'windows', osVersionFamily: release ?? null, architecture: arch ?? null,
    displayLabel: 'This PC',
  };
}

function wslEnvironment(distro, { arch, parentEnvironmentId, installationKey }) {
  const name = typeof distro === 'string' ? distro : distro?.name;
  if (!name) throw new TypeError('a WSL distribution requires a name');
  const osVersionFamily = typeof distro === 'object' ? distro.osVersionFamily ?? null : null;
  const architecture = (typeof distro === 'object' ? distro.architecture : null) ?? arch ?? null;
  return {
    environmentId: environmentIdentity({ kind: 'wsl', host: 'this-machine', distro: name }, installationKey),
    kind: 'wsl', osFamily: 'linux', osVersionFamily, architecture,
    parentEnvironmentId, displayLabel: `WSL · ${name}`,
  };
}

function singleEnvironment(kind, { release, arch, installationKey }) {
  const osFamily = kind === 'macos' ? 'darwin' : 'linux';
  const displayLabel = kind === 'macos' ? 'This Mac' : 'This machine';
  return {
    environmentId: environmentIdentity({ kind, host: 'this-machine' }, installationKey),
    kind, osFamily, osVersionFamily: release ?? null, architecture: arch ?? null, displayLabel,
  };
}

/**
 * Detect the current environment(s) from injected facts. A Windows host with
 * WSL distributions yields one Windows environment plus one Linux environment
 * per distribution — never a single blended environment, because a package
 * installed inside a distribution is invisible to Windows and vice versa.
 *
 * @param {{ platform?: string, release?: string|null, arch?: string|null,
 *           wslDistributions?: Array<string|{ name: string, osVersionFamily?: string,
 *           architecture?: string }> }} facts
 * @param {string} installationKey
 * @returns {object[]} EnvironmentIdentity rows, Windows host first when present
 */
export function detectEnvironments({
  platform, release = null, arch = null, wslDistributions = [],
} = {}, installationKey) {
  if (platform === 'win32') {
    const windows = windowsEnvironment({ release, arch, installationKey });
    const wsl = (wslDistributions ?? []).map((distro) => wslEnvironment(distro, {
      arch, parentEnvironmentId: windows.environmentId, installationKey,
    }));
    return [windows, ...wsl];
  }
  const kind = OS_FAMILY_BY_PLATFORM[platform] === 'macos' ? 'macos'
    : OS_FAMILY_BY_PLATFORM[platform] === 'linux' ? 'linux' : null;
  if (!kind || !ENVIRONMENT_KINDS.includes(kind)) {
    throw new TypeError(`detectEnvironments: unsupported platform ${String(platform)}`);
  }
  return [singleEnvironment(kind, { release, arch, installationKey })];
}

/** The environment a caller should default to when none is named explicitly:
 *  the non-WSL (or only) environment, optionally narrowed to a named
 *  distribution. */
export function currentEnvironmentId(environments, { wslDistro = null } = {}) {
  if (wslDistro) {
    const match = environments.find((entry) => (
      entry.kind === 'wsl' && entry.displayLabel === `WSL · ${wslDistro}`
    ));
    if (match) return match.environmentId;
  }
  const primary = environments.find((entry) => entry.kind !== 'wsl') ?? environments[0];
  return primary?.environmentId ?? null;
}

/** Look up one environment row by id, or `null`. */
export function environmentById(environments, environmentId) {
  return environments.find((entry) => entry.environmentId === environmentId) ?? null;
}
