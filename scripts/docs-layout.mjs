// The repository's documentation layout, expressed as a testable guard.
export const DOC_FOLDERS = {
  adr: 'decision records, every status; never moved', archive: 'frozen history', assets: 'figures for living guides',
  ddd: 'living domain model', plans: 'in-flight plans and specs', proposals: 'dormant proposals', schemas: 'living contracts',
};
export const NAME_EXCEPTIONS = { 'README.md': 'convention', 'CLAUDE.md': 'tool name', 'AGENTS.md': 'tool name', 'SKILL.md': 'tool name' };
export const ROOT_DOCS = ['README.md', 'CLAUDE.md', 'AGENTS.md'];
export const RULE_HEADING = '## Documentation layout';
export const RULE_FILES = ['CLAUDE.md', 'AGENTS.md'];
export const PACKAGED_PREFIXES = ['claude/', 'src/templates/'];
export const REPO_ONLY_PATHS = ['docs/plans/', 'docs/proposals/', 'docs/archive/'];
const MD_NAME = /^[a-z0-9][a-z0-9._-]*\.md$/;
const ARCHIVE_NAME = /^\d{4}-\d{2}(?:-\d{2})?-[a-z0-9][a-z0-9.-]*\.(?:md|html|json|jsonl|csv|mjs|png|svg)$/;
const PLAN_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9.-]*\.md$/;
const PROPOSAL_NAME = /^(?:[a-z0-9][a-z0-9-]*\/)?(?:[a-z0-9][a-z0-9-]*|README)\.md$/;

export function layoutProblems({ files, read }) {
  const problems = [];
  const archiveIndex = files.includes('docs/archive/README.md') ? read('docs/archive/README.md') : '';
  const guideIndex = files.includes('docs/README.md') ? read('docs/README.md') : '';
  for (const file of files) {
    const parts = file.split('/'); const name = parts.at(-1);
    if (parts.length === 1 && /\.(?:md|html)$/.test(file) && !ROOT_DOCS.includes(file)) problems.push(`${file}: documentation lives under docs/; the root keeps only ${ROOT_DOCS.join(', ')}`);
    if (name.endsWith('.md') && !(name in NAME_EXCEPTIONS) && !MD_NAME.test(name)) problems.push(`${file}: Markdown names are lower case; rename it to ${name.toLowerCase()}`);
    if (parts[0] === 'docs' && parts.length === 2 && file.endsWith('.md') && file !== 'docs/README.md' && !guideIndex.includes(`](${parts[1]})`)) problems.push(`${file}: list it in docs/README.md`);
    if (parts[0] === 'docs' && parts.length > 2) {
      const folder = parts[1]; const rest = parts.slice(2).join('/');
      if (!(folder in DOC_FOLDERS)) problems.push(`${file}: docs/${folder}/ is not a documentation folder; in-flight plans and specs go to docs/plans/, finished work to docs/archive/`);
      else if (folder === 'archive' && rest !== 'README.md') {
        if (parts.length > 3) problems.push(`${file}: docs/archive/ is flat; no subfolders`);
        else if (!ARCHIVE_NAME.test(rest)) problems.push(`${file}: archive names are YYYY-MM[-DD]-<origin>-<topic>.<ext>`);
        else if (!archiveIndex.includes(`](${rest})`)) problems.push(`${file}: add a row for it to docs/archive/README.md`);
      } else if (folder === 'plans' && rest !== 'README.md' && !PLAN_NAME.test(rest)) problems.push(`${file}: plan names are YYYY-MM-DD-<topic>.md`);
      else if (folder === 'proposals' && !PROPOSAL_NAME.test(rest)) problems.push(`${file}: proposals are docs/proposals/<topic>.md or docs/proposals/<topic>/<name>.md`);
    }
    if (PACKAGED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      const leaked = REPO_ONLY_PATHS.filter((repoPath) => read(file).includes(repoPath));
      if (leaked.length) problems.push(`${file}: shipped guidance names this repository's own ${leaked.join(', ')}`);
    }
  }
  for (const file of RULE_FILES) if (!files.includes(file) || !read(file).includes(RULE_HEADING) || !read(file).includes('docs/plans/')) problems.push(`${file}: missing the "${RULE_HEADING}" section that names docs/plans/`);
  return problems;
}
