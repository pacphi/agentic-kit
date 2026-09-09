// Runtime and retained-session attribution share one rule: a readable working
// directory is evidence of a context, not proof of a repository. Repository
// labels require a real Git boundary; known host state, user home, filesystem
// root and ordinary folders keep their own names.
import os from 'node:os';
import path from 'node:path';
import {
  claudeDir, codexDir, configDir, opencodeDir,
} from '../paths.mjs';
import { resolveProjectIdentity, safeProjectLabel } from '../live/project-label.mjs';

const comparable = (value, pathImpl) => {
  const normalized = pathImpl.resolve(value).replace(/[\\/]+$/, '') || pathImpl.parse(value).root;
  return pathImpl === path.win32 ? normalized.toLocaleLowerCase('en-US') : normalized;
};

const inside = (candidate, root, pathImpl) => {
  const value = comparable(candidate, pathImpl);
  const base = comparable(root, pathImpl);
  return value === base || value.startsWith(`${base}${pathImpl.sep}`);
};

const defaultStateRoots = () => [
  { root: path.join(codexDir(), '.chatgpt-projects'), kind: 'host-workspace', label: 'ChatGPT workspace' },
  { root: codexDir(), kind: 'host-state', label: 'Codex state directory' },
  { root: claudeDir(), kind: 'host-state', label: 'Claude state directory' },
  { root: opencodeDir(), kind: 'host-state', label: 'OpenCode state directory' },
  { root: configDir(), kind: 'host-state', label: 'Agentic Kit configuration' },
];

/**
 * Classify a readable cwd without promoting an arbitrary directory to a repo.
 * @param {string} cwd
 * @param {{ homeDir?: string, pathImpl?: typeof path,
 *   resolveIdentity?: typeof resolveProjectIdentity,
 *   stateRoots?: Array<{root:string, kind:string, label:string}>,
 *   fsImpl?: typeof import('node:fs') }} [options]
 */
export function classifyWorkingContext(cwd, {
  homeDir = os.homedir(),
  pathImpl = path,
  resolveIdentity = resolveProjectIdentity,
  stateRoots = defaultStateRoots(),
  fsImpl,
} = {}) {
  if (typeof cwd !== 'string' || !cwd || !pathImpl.isAbsolute(cwd)) return null;
  const identity = resolveIdentity(cwd, { fsImpl });
  if (identity?.canonical === true) {
    return { kind: 'repository', label: identity.label, path: cwd, projectKey: identity.key };
  }
  for (const entry of stateRoots) {
    if (entry?.root && inside(cwd, entry.root, pathImpl)) {
      return { kind: entry.kind, label: entry.label, path: cwd };
    }
  }
  if (inside(cwd, homeDir, pathImpl) && comparable(cwd, pathImpl) === comparable(homeDir, pathImpl)) {
    return { kind: 'user-home', label: 'User home', path: cwd };
  }
  if (comparable(cwd, pathImpl) === comparable(pathImpl.parse(cwd).root, pathImpl)) {
    return { kind: 'system-root', label: 'System root', path: cwd };
  }
  return {
    kind: 'directory',
    label: `Folder · ${safeProjectLabel(cwd) || 'unlabelled'}`,
    path: cwd,
  };
}
