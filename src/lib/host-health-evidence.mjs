// Cache invalidation for observed local configuration, not a release attestation.
// HMAC prevents the public evidence key becoming a credential-guessing oracle.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { hostHealthInputPaths } from './paths.mjs';

export function createHostHealthSnapshot({ secret = randomBytes(32), env = process.env, inputPaths = hostHealthInputPaths } = {}) {
  return ({ cwd, cfg }) => {
    const hash = createHmac('sha256', secret).update(JSON.stringify([cwd, cfg, env]));
    let complete = true;
    for (const file of inputPaths(cwd, env)) {
      hash.update(file);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) { complete = false; hash.update('unassessed'); continue; }
        hash.update(fs.realpathSync(file));
        const bytes = fs.readFileSync(file);
        // Claude's login/config registry also contains frequently changing
        // usage bookkeeping. Only its integration/trust fields govern health.
        if (path.basename(file) === '.claude.json') {
          const doc = JSON.parse(bytes.toString('utf8'));
          const projects = Object.fromEntries(Object.entries(doc.projects ?? {}).map(([root, value]) =>
            [root, { mcpServers: value.mcpServers, allowedTools: value.allowedTools, hasTrustDialogAccepted: value.hasTrustDialogAccepted }]));
          hash.update(JSON.stringify({ mcpServers: doc.mcpServers, projects }));
        } else hash.update(bytes);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') complete = false;
        hash.update(String(error.code));
      }
    }
    // Track the selected launchers too, including symlink targets. The native
    // version observation is separately bound into each host's evidence.
    for (const host of ['claude', 'codex', 'opencode']) {
      for (const dir of (env.PATH ?? '').split(path.delimiter).slice(0, 256)) {
        const file = path.resolve(dir, host + (process.platform === 'win32' ? '.cmd' : ''));
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) continue;
          hash.update(JSON.stringify([host, fs.realpathSync(file), st.size, st.mtimeMs, st.ino]));
          break;
        } catch { /* next PATH entry */ }
      }
    }
    return { key: hash.digest('hex'), complete };
  };
}
