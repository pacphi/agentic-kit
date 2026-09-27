// ADR-0058 §5. Ruflo's policy enforcer (policy-enforcer.js) reads <cwd>/.harness/mcp-policy.json
// and FAILS CLOSED when it is missing or invalid under RUFLO_MCP_ENFORCE_POLICY=1, so validity
// is the gate for projecting that variable. Ruflo 3.46.0 and newer enforce it on both stdio
// entry points (ruvnet/ruflo#3415); older versions reach the enforcer only through
// MCPServerManager, which neither stdio entry point uses, so there the file is inert.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writePrivateFileAtomic } from '../file-write.mjs';

export const POLICY_RELATIVE = path.join('.harness', 'mcp-policy.json');
// ak only ever enforces a policy file it wrote itself — other tools (MetaHarness,
// Agentic-QE) also write .harness/mcp-policy.json, and turning enforcement on against
// a foreign file would silently cap ruflo at a budget ak never chose. `_about` on an
// ak-written file always starts with this marker (see renderPolicy below).
export const AK_POLICY_MARKER = 'Managed by agentic-kit';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const policyFile = (root) => path.join(root, POLICY_RELATIVE);

export function renderPolicy({ maxCallsPerMinute }) {
  return JSON.stringify({
    _about: `${AK_POLICY_MARKER} (ADR-0058). Ruflo enforces auditLog and maxToolCallsPerTurn per rolling turnWindowMs.`,
    auditLog: true, maxToolCallsPerTurn: maxCallsPerMinute, turnWindowMs: 60000,
  }, null, 2) + '\n';
}

/** states: 'absent' (no file) | 'invalid' (unreadable/malformed/unsafe) |
 *  'foreign' (valid JSON object, but not written by ak) | 'valid' (ak-written). */
export function readPolicy(root) {
  let source;
  try {
    const stat = fs.lstatSync(policyFile(root));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { state: 'invalid' };
    source = fs.readFileSync(policyFile(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    return { state: 'invalid' };
  }
  try {
    const policy = JSON.parse(source);
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return { state: 'invalid', source };
    const akWritten = typeof policy._about === 'string' && policy._about.startsWith(AK_POLICY_MARKER);
    return { state: akWritten ? 'valid' : 'foreign', policy, source };
  } catch { return { state: 'invalid', source }; }
}

// Git reads info/exclude from the repository's common dir only, so for a linked
// worktree (a `.git` file naming `gitdir:`) the line goes into the main
// repository's info/exclude via that folder's `commondir` (gitrepository-layout).
// Resolved by reading those two files; git itself is never spawned.
export const POLICY_EXCLUDE_LINE = '/.harness/mcp-policy.json';
const EXCLUDE_COMMENT = '# agentic-kit';

function gitExcludeFile(root) {
  let dir = path.resolve(root);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* keep walking */ }
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!m) return null;
        gitDir = path.resolve(dir, m[1].trim());
      }
      let common = gitDir;
      try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not linked */ }
      // The pattern is anchored to the worktree top, so the policy must sit there.
      return dir === path.resolve(root) ? path.join(common, 'info', 'exclude') : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Keep ak's policy file out of git for this repository: 'added' | 'present' | 'no-git'. */
export function excludeFromGit(root) {
  const file = gitExcludeFile(root);
  if (!file) return 'no-git';
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* created below */ }
  if (text.split(/\r?\n/).includes(POLICY_EXCLUDE_LINE)) return 'present';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${text}${sep}${EXCLUDE_COMMENT}\n${POLICY_EXCLUDE_LINE}\n`);
  return 'added';
}

/** Remove only ak's line (and its comment just above it): 'removed' | 'absent' | 'no-git'. */
export function unexcludeFromGit(root) {
  const file = gitExcludeFile(root);
  if (!file) return 'no-git';
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 'absent'; }
  const lines = text.split('\n');
  const kept = lines.filter((line, i) => line !== POLICY_EXCLUDE_LINE
    && !(line === EXCLUDE_COMMENT && lines[i + 1] === POLICY_EXCLUDE_LINE));
  if (kept.length === lines.length) return 'absent';
  fs.writeFileSync(file, kept.join('\n'));
  return 'removed';
}

/** receipts: mutable map keyed by resolved project root → { sha256 } of the file ak wrote. */
export function reconcilePolicy(root, intent, receipts, { dryRun = false } = {}) {
  const key = path.resolve(root);
  const owned = receipts[key];
  const current = readPolicy(root);
  const ownedAndUnchanged = owned && current.source !== undefined && sha(current.source) === owned.sha256;
  if (!intent) {
    if (!owned) return { status: current.state === 'absent' ? 'absent' : 'user-managed', changed: false };
    if (current.state === 'absent') { delete receipts[key]; return { status: 'absent', changed: false }; }
    if (!ownedAndUnchanged) { delete receipts[key]; return { status: 'user-managed', changed: false }; }
    if (dryRun) return { status: 'removed', changed: true };
    fs.rmSync(policyFile(root)); delete receipts[key];
    return { status: 'removed', changed: true, gitExclude: unexcludeFromGit(root) };
  }
  const desired = renderPolicy(intent);
  if (current.state !== 'absent' && !owned) return { status: 'user-managed', changed: false };
  if (owned && current.state !== 'absent' && !ownedAndUnchanged) return { status: 'user-managed', changed: false };
  // ak's own file (written now, or converged from an earlier write) stays out of git.
  if (current.source === desired) {
    return dryRun ? { status: 'converged', changed: false } : { status: 'converged', changed: false, gitExclude: excludeFromGit(root) };
  }
  if (dryRun) return { status: 'written', changed: true };
  fs.mkdirSync(path.dirname(policyFile(root)), { recursive: true });
  writePrivateFileAtomic(policyFile(root), desired);
  receipts[key] = { sha256: sha(desired) };
  return { status: 'written', changed: true, gitExclude: excludeFromGit(root) };
}
