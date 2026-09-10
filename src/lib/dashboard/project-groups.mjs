// Pure repository-tree projection. Membership is supplied by the collector,
// never inferred from a display label, path spelling, or remote URL.
export function repositoryTree(payload = {}) {
  const byPath = new Map();
  for (const row of payload.discoveryProjects || []) if (row?.path) byPath.set(row.path, row);
  for (const row of payload.projects || []) if (row?.path) byPath.set(row.path, { ...byPath.get(row.path), ...row });

  const groups = new Map();
  const unresolved = [];
  for (const row of byPath.values()) {
    const repo = row.repository;
    if (Array.isArray(row.hosts) && row.hosts.length === 0) continue;
    if (!repo?.repositoryId || !['git', 'worktree'].includes(repo.kind)) {
      unresolved.push(row);
      continue;
    }
    const key = repo.repositoryId;
    if (!groups.has(key)) {
      const root = repo.root || row.path;
      groups.set(key, {
        key,
        repository: { path: root, label: root.split(/[\\/]/).filter(Boolean).pop() || 'repository', repository: { ...repo, kind: 'git' } },
        worktrees: [],
      });
    }
    const group = groups.get(key);
    if (repo.kind === 'git' && (!repo.root || row.path === repo.root)) group.repository = row;
    else if (repo.kind === 'worktree') group.worktrees.push(row);
  }
  const repositories = [...groups.values()];
  let excludedDirectories = 0;
  for (const row of unresolved) {
    const parent = repositories.find((group) => row.path?.startsWith(`${group.repository.path}/.claude/worktrees/`));
    if (parent) parent.worktrees.push(row);
    else excludedDirectories += 1;
  }
  for (const group of repositories) group.worktrees.sort((a, b) => String(a.label || a.path).localeCompare(String(b.label || b.path)));
  repositories.sort((a, b) => String(a.repository.label || a.repository.path).localeCompare(String(b.repository.label || b.repository.path)));
  return { repositories, excludedDirectories };
}
