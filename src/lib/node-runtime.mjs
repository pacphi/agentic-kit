// node:sqlite is available without an experimental flag in 22.13 and 23.4.
// Keep this dependency-free so the CLI can reject older runtimes before loading
// any command that imports SQLite. Official history: https://nodejs.org/api/sqlite.html
export const NODE_RUNTIME_RANGE = '>=22.13.0 <23 || >=23.4.0';

export function supportsNodeRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24;
}

export function nodeRuntimeError(version = process.versions.node) {
  return supportsNodeRuntime(version) ? null
    : `agentic-kit requires Node ${NODE_RUNTIME_RANGE} for built-in SQLite; found ${version}. Install a maintained Node 22, 24, or 26 patch release.`;
}
