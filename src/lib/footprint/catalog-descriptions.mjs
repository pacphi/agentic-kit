// Declared local metadata only. Never execute a resource to obtain a description.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../opencode-agents.mjs';

export function declaredDescription(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- strip control characters from declared display text.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 1024) : null;
}

function readBounded(file, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    return fsImpl.readFileSync(file, 'utf8');
  } catch { return null; }
}

export function readResourceDescription(file, { fsImpl = fs } = {}) {
  const text = readBounded(file, fsImpl);
  if (text == null) return null;
  const raw = text.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim();
  if (raw && /^(?:null|true|false|~|[[{&*!]|\d+(?:\.\d+)?$)/i.test(raw)) return null;
  const normalized = text.replace(/^(description:[ \t]*[>|])\+[ \t]*$/m, '$1');
  return declaredDescription(parseFrontmatter(normalized)?.fields?.description);
}

export function readPluginDescription(root, host, { fsImpl = fs } = {}) {
  if (!root) return null;
  const directories = host === 'codex' ? ['.codex-plugin', '.agent-plugin', '.claude-plugin'] : ['.claude-plugin'];
  for (const directory of directories) {
    const parent = path.join(root, directory);
    try {
      if (fsImpl.lstatSync(root).isSymbolicLink() || fsImpl.lstatSync(parent).isSymbolicLink()) continue;
      const text = readBounded(path.join(parent, 'plugin.json'), fsImpl);
      if (text == null) continue;
      return declaredDescription(JSON.parse(text)?.description);
    } catch { /* Missing or unreadable metadata is not a guessed description. */ }
  }
  return null;
}
