// Pure view projection; repository membership is supplied by the collector,
// never inferred from a display label or remote. Injected unchanged in browser.
export function projectView(payload, population = 'measured', origin = 'all') {
  const byPath = new Map();
  if (population === 'all') for (const row of payload.discoveryProjects || []) byPath.set(row.path || row, row);
  for (const row of payload.projects || []) byPath.set(row.path || row, {...byPath.get(row.path || row), ...row});
  const groups = new Map();
  for (const row of byPath.values()) {
    const origins = row.sessionOrigins?.length ? row.sessionOrigins : [{origin:'unknown'}];
    if (origin !== 'all' && !origins.some(item => item.origin === origin)) continue;
    const repo = row.repository;
    const key = repo?.repositoryId || (repo?.kind === 'folder' ? 'folders' : 'unknown');
    if (!groups.has(key)) groups.set(key, {key, label:repo?.root || repo?.commonDir || (key === 'folders' ? 'Other folders' : 'Repository not established'), rows:[]});
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}
