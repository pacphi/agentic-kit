import fs from 'node:fs';

import {
  claudeSettingsPath, claudeUserMcpPath, codexConfigPath, opencodeConfigPath,
  projectSettings, projectSettingsLocal, repoRoot,
} from '../paths.mjs';
import { registry, blocksForTarget, guidanceTargets, hasBlock } from '../blocks.mjs';
import { statNode, measured, unknown } from './walk.mjs';

const SENTINEL_RE = /^<!-- BEGIN [^>]+ -->$/gm;

function fileSize(file, { asOf = null, fsImpl = fs } = {}) {
  const node = statNode(file, { fsImpl });
  if (node.status === 'unknown') {
    return node.reason === 'ENOENT'
      ? { ...measured(0, { asOf }), present: false, mtimeMs: null, path: file }
      : { ...unknown(node.reason), present: null, mtimeMs: null, path: file };
  }
  return { ...measured(node.bytes ?? 0, { asOf }), present: true, mtimeMs: node.mtimeMs, path: file };
}

/** Bounded configuration evidence. Guidance prose never leaves this function;
 * only file sizes and managed-block sentinel counts do. */
export function collectConfigSurface({
  cwd = process.cwd(), cfg = {}, asOf = null, extraSettingsFiles = [], fsImpl = fs,
} = {}) {
  const rows = registry(/** @type {any} */ (cfg)?.customBlocks ?? []);
  const guidance = [];
  for (const target of guidanceTargets({ cwd })) {
    const bytes = fileSize(target.file, { asOf, fsImpl });
    const expected = blocksForTarget(rows, target.name);
    let content;
    try { content = fsImpl.readFileSync(target.file, 'utf8'); } catch (error) {
      const absent = error.code === 'ENOENT';
      guidance.push({
        name: target.name, label: target.label, path: target.file, bytes,
        managed: absent ? measured(0, { asOf }) : unknown(error.code ?? 'io'),
        observed: absent ? measured(0, { asOf }) : unknown(error.code ?? 'io'),
        expected: expected.length, slugs: [],
      });
      continue;
    }
    const present = expected.filter((row) => hasBlock(content, row.slug));
    guidance.push({
      name: target.name, label: target.label, path: target.file, bytes,
      managed: measured(present.length, { asOf }),
      observed: measured((content.match(SENTINEL_RE) ?? []).length, { asOf }),
      expected: expected.length, slugs: present.map((row) => row.slug),
    });
  }

  const projectRoot = repoRoot(cwd);
  const settings = [
    { id: 'claude-settings', label: '~/.claude/settings.json', file: claudeSettingsPath() },
    { id: 'claude-user-mcp', label: '~/.claude.json', file: claudeUserMcpPath() },
    { id: 'codex-config', label: '~/.codex/config.toml', file: codexConfigPath() },
    { id: 'opencode-config', label: 'opencode.json', file: opencodeConfigPath() },
  ];
  if (projectRoot) {
    settings.push({ id: 'project-settings', label: '.claude/settings.json', file: projectSettings(projectRoot) });
    settings.push({ id: 'project-settings-local', label: '.claude/settings.local.json', file: projectSettingsLocal(projectRoot) });
  }
  for (const extra of extraSettingsFiles) {
    settings.push({ id: extra.id, label: extra.label, file: extra.path });
  }
  return {
    guidance,
    settings: settings.map((row) => ({ id: row.id, label: row.label, ...fileSize(row.file, { asOf, fsImpl }) })),
  };
}
