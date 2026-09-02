// Project guidance ownership boundary for `ak setup --project`.
//
// Ruflo and AQE both initialize useful project assets, but their initializers
// can also materialize host guidance. Agentic-kit captures the pre-init state,
// lets those tools own their other assets, then restores user-authored guidance
// and adds only bounded, sentineled compatibility pointers. AGENTS.md remains
// untouched here; AQE owns its own AGENTIC-QE CODEX sentinel when requested.
import fs from 'node:fs';
import path from 'node:path';
import { BEGIN, END, stripBlock, upsertBlock } from './blocks.mjs';
import { writeFileWithBackup } from './file-write.mjs';

export const PROJECT_GUIDANCE_SLUG = 'agentic-kit-project-guidance';
export const AQE_GUARD_SLUG = 'agentic-kit-aqe-init-guard';

const LEGACY_AQE_GUARD = '## Agentic QE v3\n'
  + '<!-- managed by agentic-kit — aqe init skips regeneration when this sentinel is present -->\n';

/** Exact pre-sentinel project stub shipped by agentic-kit through 2026-09-02. */
export const legacyLeanProjectGuidance = (name) => `<!-- Full ruflo reference: machine-wide ~/.claude/CLAUDE.md (managed by agentic-kit) -->

# ${name}

## Swarm Config

- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid

\`\`\`bash
ruflo swarm init --topology hierarchical --max-agents 15 --strategy specialized
\`\`\`
`;

const managedBlock = (slug, body) => `${BEGIN(slug)}\n${body.trim()}\n${END(slug)}\n`;

const projectReferenceBlock = () => managedBlock(PROJECT_GUIDANCE_SLUG, '@AGENTS.md');

const aqeGuardBlock = () => managedBlock(AQE_GUARD_SLUG, `## Agentic QE v3
<!-- Compatibility guard only; Agentic-QE owns its generated host guidance. -->`);

const hasAqePriorArt = (content) => /(?:^|\n)## Agentic QE v3(?:\s|$)/.test(content);

function stripLegacyOwned(content, projectName) {
  let next = content;
  const legacy = legacyLeanProjectGuidance(projectName);
  if (next.startsWith(legacy)) next = next.slice(legacy.length).replace(/^\r?\n/, '');
  next = next.replace(LEGACY_AQE_GUARD, '');
  return next;
}

/** Snapshot only the guidance state needed to undo initializer prompt churn. */
export function captureProjectGuidance(root) {
  const claudeFile = path.join(root, 'CLAUDE.md');
  const agentsFile = path.join(root, 'AGENTS.md');
  const claudeExisted = fs.existsSync(claudeFile);
  return {
    claude: {
      existed: claudeExisted,
      content: claudeExisted ? fs.readFileSync(claudeFile, 'utf8') : '',
    },
    agents: { existed: fs.existsSync(agentsFile) },
  };
}

/**
 * Restore the pre-init project guidance, migrate agentic-kit's legacy stub,
 * and materialize the smallest necessary compatibility surface.
 *
 * - Existing user CLAUDE.md content is authoritative and is never replaced by
 *   AGENTS.md implicitly.
 * - An AGENTS-only project gets a one-line Claude import, not copied prose.
 * - With neither file, no Ruflo prompt is added; machine guidance is enough.
 * - AQE's tiny guard prevents its initializer from adding duplicate Claude
 *   guidance. AQE continues to own its separate Codex sentinel in AGENTS.md.
 */
export function reconcileProjectGuidance({ root, prior, aqeEnabled }) {
  const file = path.join(root, 'CLAUDE.md');
  let desired = prior.claude.content;
  desired = stripBlock(desired, PROJECT_GUIDANCE_SLUG);
  desired = stripBlock(desired, AQE_GUARD_SLUG);
  desired = stripLegacyOwned(desired, path.basename(root));

  if (desired.trim() === '' && prior.agents.existed) {
    desired = upsertBlock(desired, PROJECT_GUIDANCE_SLUG, projectReferenceBlock());
  }
  if (aqeEnabled && !hasAqePriorArt(desired)) {
    desired = upsertBlock(desired, AQE_GUARD_SLUG, aqeGuardBlock());
  }

  const exists = fs.existsSync(file);
  const current = exists ? fs.readFileSync(file, 'utf8') : '';
  if (desired === current) return { action: 'unchanged', bytes: Buffer.byteLength(desired) };

  if (desired.trim() === '' && !prior.claude.existed) {
    if (exists) fs.rmSync(file, { force: true });
    return { action: exists ? 'removed-generated' : 'unchanged', bytes: 0 };
  }

  writeFileWithBackup(file, desired);
  return {
    action: prior.claude.existed ? 'restored-and-reconciled' : 'created-reference',
    bytes: Buffer.byteLength(desired),
  };
}
