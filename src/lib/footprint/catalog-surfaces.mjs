import path from 'node:path';

import { repoRoot } from '../paths.mjs';

const emptyReading = (status, reason = null) => ({
  status, reason, names: [], entries: [], partial: false, truncated: false,
});

function configuredSkillPath(pathValue, configFile, homeDir) {
  if (typeof pathValue !== 'string' || !pathValue.trim()) return null;
  const value = pathValue.trim();
  if (/^https?:\/\//i.test(value)) return { kind: 'remote', value };
  const expanded = value === '~' ? homeDir
    : (value.startsWith('~/') || value.startsWith('~\\')
      ? path.join(homeDir, value.slice(2)) : value);
  return {
    kind: 'local',
    value: path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(path.dirname(configFile), expanded),
  };
}

/** OpenCode v1 accepts additive local skill roots through `skills.paths`.
 * The configuration file itself is a measured surface so an unreadable or
 * JSONC-only layer becomes explicit partial evidence instead of silently
 * disappearing from the inventory. Network catalogs are not fetched by this
 * filesystem collector and therefore remain degraded evidence. */
function configuredOpenCodeSkillSpecs({ configFile, id, scope, project = null, homeDir }, readers, io) {
  const { marker } = readers;
  const { fsImpl } = io;
  let reading = emptyReading('absent', 'ENOENT');
  let values = [];
  try {
    const doc = JSON.parse(fsImpl.readFileSync(configFile, 'utf8'));
    values = Array.isArray(doc?.skills?.paths) ? doc.skills.paths : [];
    reading = emptyReading('ok');
  } catch (error) {
    reading = emptyReading(error?.code === 'ENOENT' ? 'absent' : 'degraded', error?.code ?? 'EPARSE');
  }
  const specs = [{
    id: `${id}:config`, host: 'opencode', kind: 'skill', scope, project,
    path: configFile, read: () => reading,
    discovery: { mechanism: 'configured-path-list', configuredBy: path.basename(configFile) },
  }];
  values.forEach((value, index) => {
    const source = configuredSkillPath(value, configFile, homeDir);
    if (!source) return;
    const discovery = { mechanism: 'configured-path', configuredBy: path.basename(configFile) };
    specs.push({
      id: `${id}:${index}`, host: 'opencode', kind: 'skill', scope, project,
      path: source.value, discovery,
      read: source.kind === 'remote'
        ? () => emptyReading('degraded', 'remote-skill-source-not-measured')
        : (p) => marker(p, 'SKILL.md', io),
    });
  });
  return specs;
}

/** Declarative filesystem surfaces. Readers are injected to keep traversal and
 * evidence policy in catalog.mjs while this module owns host conventions. */
export function catalogSurfaceSpecs(roots, readers, io) {
  const {
    claudeRoot, claudeMcpFile, codexRoot, codexConfigFile, opencodeRoot,
    opencodeConfigFile, agentsRoot, cwd, projects, env = process.env,
  } = roots;
  const { marker, markdown, stems, manifest, toml } = readers;
  const at = (base, ...rest) => path.join(base, ...rest);
  const specs = [
    { id: 'claude-skills', host: 'claude', kind: 'skill', scope: 'user', path: at(claudeRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'opencode-claude-skills', host: 'opencode', kind: 'skill', scope: 'user', path: at(claudeRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io),
      discovery: { mechanism: 'claude-compatible-directory', configuredBy: 'host-convention',
        enabled: env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS === '1' ? false : true } },
    { id: 'claude-agents', host: 'claude', kind: 'agent', scope: 'user', path: at(claudeRoot, 'agents'), read: (p) => markdown(p, io) },
    { id: 'claude-commands', host: 'claude', kind: 'command', scope: 'user', path: at(claudeRoot, 'commands'), read: (p) => markdown(p, io) },
    { id: 'claude-user-mcp', host: 'claude', kind: 'mcpServer', scope: 'user', path: claudeMcpFile, read: (p) => manifest(p, (d) => d?.mcpServers, io) },
  ];
  const userSurfaceKeys = new Set(specs.map((spec) => (
    `${spec.host}::${spec.kind}::${path.resolve(spec.path)}`
  )));
  // ~/.agents/skills is one user-level source shared by Codex and OpenCode.
  // Its declarative specs are appended below to retain the established surface
  // order, so register their identities here before project candidates are
  // considered.
  for (const host of ['codex', 'opencode']) {
    userSurfaceKeys.add(`${host}::skill::${path.resolve(at(agentsRoot, 'skills'))}`);
  }
  userSurfaceKeys.add(`opencode::skill::${path.resolve(at(claudeRoot, 'skills'))}`);
  const launchingRoot = repoRoot(cwd);
  const userHomes = new Set([claudeRoot, agentsRoot, codexRoot]
    .filter(Boolean).map((root) => path.dirname(path.resolve(root))));
  const catalogProjects = [...new Set([launchingRoot, ...(projects ?? [])]
    .filter(Boolean).map((project) => path.resolve(typeof project === 'string' ? project : project.path)))]
    .filter((project) => !userHomes.has(project));
  for (const project of catalogProjects) {
    const claudeProject = at(project, '.claude');
    const projectSpecs = [
      { id: `claude-project-skills:${project}`, host: 'claude', kind: 'skill', scope: 'project', project, path: at(claudeProject, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
      { id: `opencode-claude-project-skills:${project}`, host: 'opencode', kind: 'skill', scope: 'project', project, path: at(claudeProject, 'skills'), read: (p) => marker(p, 'SKILL.md', io),
        discovery: { mechanism: 'claude-compatible-directory', configuredBy: 'host-convention',
          enabled: env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS === '1' ? false : true } },
      { id: `claude-project-agents:${project}`, host: 'claude', kind: 'agent', scope: 'project', project, path: at(claudeProject, 'agents'), read: (p) => markdown(p, io) },
      { id: `claude-project-commands:${project}`, host: 'claude', kind: 'command', scope: 'project', project, path: at(claudeProject, 'commands'), read: (p) => markdown(p, io) },
      { id: `claude-project-mcp:${project}`, host: 'claude', kind: 'mcpServer', scope: 'project', project, path: at(project, '.mcp.json'), read: (p) => manifest(p, (d) => d?.mcpServers, io) },
      { id: `codex-project-skills:${project}`, host: 'codex', kind: 'skill', scope: 'project', project, path: at(project, '.agents', 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
      { id: `codex-project-agents:${project}`, host: 'codex', kind: 'agent', scope: 'project', project, path: at(project, '.codex', 'agents'), read: (p) => stems(p, ['.toml', '.md'], io) },
      { id: `codex-project-mcp:${project}`, host: 'codex', kind: 'mcpServer', scope: 'project', project, path: at(project, '.codex', 'config.toml'), read: (p) => toml(p, 'mcp_servers', io) },
      { id: `opencode-project-skills:${project}`, host: 'opencode', kind: 'skill', scope: 'project', project, path: at(project, '.agents', 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
      { id: `opencode-project-dot-skills:${project}`, host: 'opencode', kind: 'skill', scope: 'project', project, path: at(project, '.opencode', 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
      { id: `opencode-project-agents:${project}`, host: 'opencode', kind: 'agent', scope: 'project', project, path: at(project, '.opencode', 'agents'), read: (p) => markdown(p, io) },
      { id: `opencode-project-commands:${project}`, host: 'opencode', kind: 'command', scope: 'project', project, path: at(project, '.opencode', 'commands'), read: (p) => markdown(p, io) },
      { id: `opencode-project-mcp-json:${project}`, host: 'opencode', kind: 'mcpServer', scope: 'project', project, path: at(project, 'opencode.json'), read: (p) => manifest(p, (d) => d?.mcp, io) },
      { id: `opencode-project-mcp-jsonc:${project}`, host: 'opencode', kind: 'mcpServer', scope: 'project', project, path: at(project, 'opencode.jsonc'), read: (p) => manifest(p, (d) => d?.mcp, io) },
    ];
    // A transcript cwd can be the user's home rather than a project. In that
    // case `<cwd>/.claude/*` and `<cwd>/.agents/skills` are the exact user
    // surfaces above. Preserve cross-host sharing, but never assign the same
    // host/kind/path both user and project scope: that fabricates project
    // pressure and unsafe remediation context from one physical source.
    specs.push(...projectSpecs.filter((spec) => !userSurfaceKeys.has(
      `${spec.host}::${spec.kind}::${path.resolve(spec.path)}`,
    )));
    specs.push(...configuredOpenCodeSkillSpecs({
      configFile: at(project, 'opencode.json'), id: `opencode-project-skill-paths:${project}`,
      scope: 'project', project, homeDir: path.dirname(agentsRoot),
    }, readers, io));
  }
  specs.push(
    { id: 'codex-skills', host: 'codex', kind: 'skill', scope: 'user', path: at(codexRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'codex-agents-skills', host: 'codex', kind: 'skill', scope: 'user', path: at(agentsRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'codex-agents', host: 'codex', kind: 'agent', scope: 'user', path: at(codexRoot, 'agents'), read: (p) => stems(p, ['.toml', '.md'], io) },
    { id: 'codex-prompts', host: 'codex', kind: 'command', scope: 'user', path: at(codexRoot, 'prompts'), read: (p) => markdown(p, io) },
    { id: 'codex-mcp', host: 'codex', kind: 'mcpServer', scope: 'user', path: codexConfigFile, read: (p) => toml(p, 'mcp_servers', io) },
    { id: 'opencode-agents', host: 'opencode', kind: 'agent', scope: 'user', path: at(opencodeRoot, 'agents'), read: (p) => markdown(p, io) },
    { id: 'opencode-skills', host: 'opencode', kind: 'skill', scope: 'user', path: at(opencodeRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'opencode-agents-skills', host: 'opencode', kind: 'skill', scope: 'user', path: at(agentsRoot, 'skills'), read: (p) => marker(p, 'SKILL.md', io) },
    { id: 'opencode-commands', host: 'opencode', kind: 'command', scope: 'user', path: at(opencodeRoot, 'commands'), read: (p) => markdown(p, io) },
    { id: 'opencode-legacy-commands', host: 'opencode', kind: 'command', scope: 'user', path: at(opencodeRoot, 'command'), read: (p) => markdown(p, io) },
    { id: 'opencode-plugins', host: 'opencode', kind: 'plugin', scope: 'user', path: at(opencodeRoot, 'plugins'), read: (p) => stems(p, ['.js', '.mjs', '.cjs', '.ts'], io) },
    { id: 'opencode-mcp', host: 'opencode', kind: 'mcpServer', scope: 'user', path: opencodeConfigFile, read: (p) => manifest(p, (d) => d?.mcp, io) },
  );
  specs.push(...configuredOpenCodeSkillSpecs({
    configFile: opencodeConfigFile, id: 'opencode-skill-paths', scope: 'user',
    homeDir: path.dirname(agentsRoot),
  }, readers, io));
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
