// Network edge of the upstream watch: GitHub through `gh api` and npm through
// `npm view`. Every call goes through an injectable `exec`, so tests replay
// recorded responses and never touch the network. Read-only by construction:
// no call here writes to GitHub or npm.
import { execFile } from 'node:child_process';

import { releaseFacts } from './classify.mjs';

const ID = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;

/** Run a command without a shell; resolves with its status and output, never rejects. */
export function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60_000 }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ status, stdout, stderr, error: error && typeof error.code !== 'number' ? error : null });
    });
  });
}

/** Map `items` through `fn` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createFetcher({ exec = run } = {}) {
  const json = async (command, args) => {
    const result = await exec(command, args);
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || 'no output').trim()}`);
    return JSON.parse(result.stdout);
  };
  return {
    async auth() {
      const result = await exec('gh', ['auth', 'status']);
      if (result.error?.code === 'ENOENT') return { ok: false, message: 'gh is not installed; install the GitHub CLI to check upstream threads.' };
      if (result.status === 0) return { ok: true };
      return { ok: false, message: 'gh is not authenticated; run `gh auth login`, then re-run.' };
    },
    async thread(id) {
      const [, repo, number] = ID.exec(id) ?? [];
      if (!repo) throw new Error(`not an owner/repo#number id: ${id}`);
      const issue = await json('gh', ['api', `repos/${repo}/issues/${number}`]);
      const pages = await json('gh', ['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments?per_page=100`]);
      return { issue, comments: pages.flat() };
    },
    async release({ channel, name }) {
      if (!/^[@\w][\w@./-]*$/.test(name)) throw new Error(`not a package or repository name: ${name}`);
      if (channel === 'npm') return releaseFacts('npm', await json('npm', ['view', name, 'time', 'dist-tags', '--json']));
      return releaseFacts('github-release', await json('gh', ['api', `repos/${name}/releases?per_page=100`]));
    },
  };
}
