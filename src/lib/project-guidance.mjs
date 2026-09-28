// Project guidance ownership boundary for `ak setup --project`.
//
// Ruflo and AQE both initialize useful project assets, but their initializers
// can also materialize host guidance. Agentic-kit captures the pre-init state,
// lets those tools own their other assets, then restores user-authored guidance
// and adds only bounded, sentineled compatibility pointers. AGENTS.md remains
// untouched here; AQE owns its own AGENTIC-QE CODEX sentinel when requested.
import fs from 'node:fs';
import path from 'node:path';
import { BEGIN, END, hasBlock, stripBlock, upsertBlock } from './blocks.mjs';
import { writeFileWithBackup } from './file-write.mjs';

export const PROJECT_GUIDANCE_SLUG = 'agentic-kit-project-guidance';
export const AQE_GUARD_SLUG = 'agentic-kit-aqe-init-guard';

// A prose sentence pointing at AGENTS.md ("Read [AGENTS.md](AGENTS.md) for...")
// loads unreliably: Claude Code only opens AGENTS.md if it decides to, whereas
// an `@AGENTS.md` import is expanded at every session launch. Recognized at
// this trust level (line-anchored, case-insensitive) same as the other legacy
// patterns below — narrow enough not to fire on incidental mentions of the
// filename, but not exact-string-only, since this prose varies per project.
const STALE_AGENTS_POINTER = /^\s*(?:#{1,6}\s*)?(?:read|see|check|refer to)\s+\[?agents\.md\b/im;
const RELIABLE_AGENTS_IMPORT = /(?:^|\n)\s*@AGENTS\.md\s*(?:\n|$)/;

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

/** True when `content` reads like the known-unreliable prose AGENTS.md
 *  pointer, and nothing already gives Claude a reliable path to AGENTS.md
 *  (an existing sentineled reference block or a bare `@AGENTS.md` import
 *  someone added by hand). Never fires when AGENTS.md doesn't exist — there
 *  is nothing to point at. */
export function hasStaleAgentsPointer(content, { agentsExisted }) {
  if (!agentsExisted) return false;
  const text = content ?? '';
  if (hasBlock(text, PROJECT_GUIDANCE_SLUG)) return false;
  if (RELIABLE_AGENTS_IMPORT.test(text)) return false;
  return STALE_AGENTS_POINTER.test(text);
}

/** Additive migration: append the sentineled `@AGENTS.md` reference block
 *  alongside an existing stale prose pointer, never touching the prose
 *  itself. This repo's own CLAUDE.md carried exactly this pattern (a hand-
 *  written "Read AGENTS.md for..." sentence, #212) — non-empty existing
 *  content is otherwise authoritative and never gets AGENTS.md wired in, so
 *  the sentence sat there unreliable until someone noticed by hand. Additive
 *  only: deleting or rewriting arbitrary prose risks destroying user content
 *  this module has no basis for parsing (see the module-level "never destroy
 *  user content" invariant `stripLegacyOwned`/`reconcileProjectGuidance`
 *  already follow for known-legacy strings only). */
function withStaleAgentsPointerMigrated(content, { agentsExisted }) {
  if (!hasStaleAgentsPointer(content, { agentsExisted })) return content;
  return upsertBlock(content, PROJECT_GUIDANCE_SLUG, projectReferenceBlock());
}

/** Standalone entry point for callers (namely `ak sync`) that don't run
 *  Ruflo/AQE project initializers and so have no pre-init snapshot to
 *  capture — operates directly on the current file, additive-only per
 *  `withStaleAgentsPointerMigrated`. No-op when CLAUDE.md doesn't exist
 *  (nothing to migrate) or AGENTS.md doesn't exist (nothing to point at). */
export function migrateStaleAgentsPointer(root) {
  const claudeFile = path.join(root, 'CLAUDE.md');
  if (!fs.existsSync(claudeFile)) return { action: 'unchanged' };
  const agentsExisted = fs.existsSync(path.join(root, 'AGENTS.md'));
  const current = fs.readFileSync(claudeFile, 'utf8');
  const next = withStaleAgentsPointerMigrated(current, { agentsExisted });
  if (next === current) return { action: 'unchanged' };
  writeFileWithBackup(claudeFile, next);
  return { action: 'migrated-prose-pointer', bytes: Buffer.byteLength(next) };
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
 *   AGENTS.md implicitly — except a known-unreliable prose AGENTS.md pointer
 *   (`hasStaleAgentsPointer`), which gets the reliable import added
 *   alongside it, additively (see `withStaleAgentsPointerMigrated`).
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
  } else {
    desired = withStaleAgentsPointerMigrated(desired, { agentsExisted: prior.agents.existed });
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
