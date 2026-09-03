import path from 'node:path';

import { repoRoot } from '../paths.mjs';

/** Declarative filesystem surfaces. Readers are injected to keep traversal and
 * evidence policy in catalog.mjs while this module owns host conventions. */
export function catalogSurfaceSpecs(roots, readers, io) {
  const {
    claudeRoot, claudeMcpFile, codexRoot, codexConfigFile, opencodeRoot,
    opencodeConfigFile, agentsRoot, cwd, projects,
  } = roots;
  const { marker, markdown, stems, manifest, toml } = readers;
  const at = (base, ...rest) => path.join(base, ...rest);
  const specs = [
    { id: 'claude-skills', host: 'claude', kind: 'skill', scope: 'user', path: at(claudeRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'claude-agents', host: 'claude', kind: 'agent', scope: 'user', path: at(claudeRoot, 'agents'), read: (p) => markdown(p, io) },
    { id: 'claude-commands', host: 'claude', kind: 'command', scope: 'user', path: at(claudeRoot, 'commands'), read: (p) => markdown(p, io) },
    { id: 'claude-user-mcp', host: 'claude', kind: 'mcpServer', scope: 'user', path: claudeMcpFile, read: (p) => manifest(p, (d) => d?.mcpServers, io) },
  ];
  const launchingRoot = repoRoot(cwd);
  if (launchingRoot) {
    specs.push({ id: 'claude-project-mcp', host: 'claude', kind: 'mcpServer', scope: 'project', project: launchingRoot,
      path: at(launchingRoot, '.mcp.json'), read: (p) => manifest(p, (d) => d?.mcpServers, io) });
  }
  const catalogProjects = [...new Set([launchingRoot, ...(projects ?? [])]
    .filter(Boolean).map((project) => path.resolve(typeof project === 'string' ? project : project.path)))];
  for (const project of catalogProjects) {
    const claudeProject = at(project, '.claude');
    specs.push(
      { id: `claude-project-skills:${project}`, host: 'claude', kind: 'skill', scope: 'project', project, path: at(claudeProject, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
      { id: `claude-project-agents:${project}`, host: 'claude', kind: 'agent', scope: 'project', project, path: at(claudeProject, 'agents'), read: (p) => markdown(p, io) },
      { id: `claude-project-commands:${project}`, host: 'claude', kind: 'command', scope: 'project', project, path: at(claudeProject, 'commands'), read: (p) => markdown(p, io) },
      { id: `codex-project-skills:${project}`, host: 'codex', kind: 'skill', scope: 'project', project, path: at(project, '.agents', 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
      { id: `opencode-project-skills:${project}`, host: 'opencode', kind: 'skill', scope: 'project', project, path: at(project, '.agents', 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    );
  }
  specs.push(
    { id: 'codex-skills', host: 'codex', kind: 'skill', scope: 'user', path: at(codexRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'codex-agents-skills', host: 'codex', kind: 'skill', scope: 'user', path: at(agentsRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'codex-prompts', host: 'codex', kind: 'command', scope: 'user', path: at(codexRoot, 'prompts'), read: (p) => markdown(p, io) },
    { id: 'codex-mcp', host: 'codex', kind: 'mcpServer', scope: 'user', path: codexConfigFile, read: (p) => toml(p, 'mcp_servers', io) },
    { id: 'opencode-agents', host: 'opencode', kind: 'agent', scope: 'user', path: at(opencodeRoot, 'agents'), read: (p) => markdown(p, io) },
    { id: 'opencode-skills', host: 'opencode', kind: 'skill', scope: 'user', path: at(opencodeRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'opencode-agents-skills', host: 'opencode', kind: 'skill', scope: 'user', path: at(agentsRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'opencode-commands', host: 'opencode', kind: 'command', scope: 'user', path: at(opencodeRoot, 'command'), read: (p) => markdown(p, io) },
    { id: 'opencode-plugins', host: 'opencode', kind: 'plugin', scope: 'user', path: at(opencodeRoot, 'plugins'), read: (p) => stems(p, ['.js', '.mjs', '.cjs', '.ts'], io) },
    { id: 'opencode-mcp', host: 'opencode', kind: 'mcpServer', scope: 'user', path: opencodeConfigFile, read: (p) => manifest(p, (d) => d?.mcp, io) },
  );
  return { specs, catalogProjects, launchingProject: launchingRoot };
}

export function pluginCapabilitySpecs(host, provider, root, readers, io) {
  const { marker, markdown, manifest } = readers;
  const specs = [];
  for (const [tag, base] of [['', root], ['dot', path.join(root, '.claude')]]) {
    const id = (kind) => `${host}-plugin:${provider.ref}:${tag ? `${tag}-` : ''}${kind}`;
    specs.push(
      { id: id('skills'), host, kind: 'skill', scope: 'plugin', provider, path: path.join(base, 'skills'), prefix: provider.name, read: (p) => marker(p, 'SKILL.md', io) },
      { id: id('agents'), host, kind: 'agent', scope: 'plugin', provider, path: path.join(base, 'agents'), prefix: provider.name, read: (p) => markdown(p, io) },
      { id: id('commands'), host, kind: 'command', scope: 'plugin', provider, path: path.join(base, 'commands'), prefix: provider.name, read: (p) => markdown(p, io) },
    );
  }
  specs.push(
    { id: `${host}-plugin:${provider.ref}:migrated-command-skills`, host, kind: 'skill', scope: 'plugin', provider, path: path.join(root, '.codex-plugin', 'migrated-command-skills'), prefix: provider.name, read: (p) => marker(p, 'SKILL.md', io) },
    { id: `${host}-plugin:${provider.ref}:mcp`, host, kind: 'mcpServer', scope: 'plugin', provider, path: path.join(root, '.mcp.json'), prefix: provider.name, read: (p) => manifest(p, (d) => d?.mcpServers, io) },
  );
  return specs;
}
