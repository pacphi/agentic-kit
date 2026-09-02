import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditHooks } from '../../src/lib/hook-audit/orchestrator.mjs';
import { buildHookHealingPlan } from '../../src/lib/hook-remediation/planner.mjs';

function writeJson(file, value, mode = 0o640) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function hookRemediationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-heal-'));
  const codexHome = path.join(root, 'codex');
  const transactionsRoot = path.join(root, 'transactions');
  const target = path.join(codexHome, 'hooks.json');
  writeJson(target, {
    keep: { user: true },
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node end.cjs', timeout: 5 }] }] },
  });
  const audit = () => auditHooks({
    hosts: ['codex'], versions: { codex: '0.151.0' }, projectRoots: [],
    codex: { codexHome, pluginCacheDir: path.join(codexHome, 'plugins', 'cache') },
    upstream: { file: path.join(root, 'missing-constraints.json') },
  });
  const plan = () => buildHookHealingPlan({ report: audit() });
  return { root, codexHome, transactionsRoot, target, audit, plan };
}

export async function captureConsole(fn) {
  const lines = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const status = await fn();
    return { status, stdout: lines.join('\n'), stderr: errors.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
