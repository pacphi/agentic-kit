// ADR-0058 §5. Ruflo reads <cwd>/.harness/mcp-policy.json and FAILS CLOSED when it is
// missing or invalid under RUFLO_MCP_ENFORCE_POLICY=1 (policy-enforcer.js), so validity is
// the gate for projecting that variable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writePrivateFileAtomic } from '../file-write.mjs';

export const POLICY_RELATIVE = path.join('.harness', 'mcp-policy.json');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const policyFile = (root) => path.join(root, POLICY_RELATIVE);

export function renderPolicy({ maxCallsPerMinute }) {
  return JSON.stringify({
    _about: 'Managed by agentic-kit (ADR-0058). Ruflo enforces auditLog and maxToolCallsPerTurn per rolling turnWindowMs.',
    auditLog: true, maxToolCallsPerTurn: maxCallsPerMinute, turnWindowMs: 60000,
  }, null, 2) + '\n';
}

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
    return { state: 'valid', policy, source };
  } catch { return { state: 'invalid', source }; }
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
    if (!dryRun) { fs.rmSync(policyFile(root)); delete receipts[key]; }
    return { status: 'removed', changed: true };
  }
  const desired = renderPolicy(intent);
  if (current.state !== 'absent' && !owned) return { status: 'user-managed', changed: false };
  if (owned && current.state !== 'absent' && !ownedAndUnchanged) return { status: 'user-managed', changed: false };
  if (current.source === desired) return { status: 'converged', changed: false };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(policyFile(root)), { recursive: true });
    writePrivateFileAtomic(policyFile(root), desired);
    receipts[key] = { sha256: sha(desired) };
  }
  return { status: 'written', changed: true };
}
