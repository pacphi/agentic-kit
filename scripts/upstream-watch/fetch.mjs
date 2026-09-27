// Network edge of the upstream watch: GitHub through `gh api` and npm through
// `npm view`. Every call goes through an injectable `exec`, so tests replay
// recorded responses and never touch the network. Read-only by construction:
// no call here writes to GitHub or npm.
import { execFile } from 'node:child_process';

import { OWNER_REPO, PACKAGE_NAME } from '../../src/lib/hook-audit/upstream-watch.mjs';
import { maxVersion, releaseFacts } from './classify.mjs';

const ID = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;
const SHA = /^[0-9a-f]{7,40}$/;
const REF = /^[\w./-]+$/;
const NOT_FOUND = /HTTP 404|Not Found/i;
const NO_MATCH = /No match found for version/;

// What closed a thread: its closing pull requests, else the ClosedEvent's closer.
export const FIXING_CHANGES_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name} issueOrPullRequest(number:$number){__typename ... on Issue{closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{__typename ... on Commit{oid} ... on PullRequest{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}}}}}} ... on PullRequest{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}}}}`;

/**
 * The merged changes that fixed a thread, from the FIXING_CHANGES_QUERY answer.
 * Only a pull request merged into the repository's default branch counts, so
 * an unmerged or off-branch closing reference never confirms a release.
 */
function changesOf(repo, data) {
  const branch = data?.defaultBranchRef?.name;
  const node = data?.issueOrPullRequest;
  const merged = (pr) => Boolean(pr?.merged && pr.mergeCommit?.oid && branch && pr.baseRefName === branch
    && pr.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase());
  const asChange = (pr) => ({ repo, pr: pr.number, sha: pr.mergeCommit.oid });
  if (!node) return [];
  if (node.__typename === 'PullRequest') return merged(node) ? [asChange(node)] : [];
  const prs = (node.closedByPullRequestsReferences?.nodes ?? []).filter(merged).map(asChange);
  if (prs.length) return prs;
  const closer = node.timelineItems?.nodes?.at(-1)?.closer;
  if (closer?.__typename === 'Commit' && SHA.test(closer.oid ?? '')) return [{ repo, pr: null, sha: closer.oid }];
  if (closer?.__typename === 'PullRequest' && merged(closer)) return [asChange(closer)];
  return [];
}

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
    /** Merged pull requests (or the closing commit) that fixed a thread; empty when none qualifies. */
    async fixingChanges(id) {
      const [, repo, number] = ID.exec(id) ?? [];
      if (!repo) throw new Error(`not an owner/repo#number id: ${id}`);
      const [owner, name] = repo.split('/');
      const answer = await json('gh', ['api', 'graphql', '-f', `query=${FIXING_CHANGES_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`]);
      return changesOf(repo, answer?.data?.repository);
    },
    /**
     * Whether the first existing tag in `refs` contains `sha`. A tag missing for
     * every spelling is unknown (contained: null); any other failure throws, so
     * a rate limit never reads as "not contained".
     */
    async contains(repo, refs, sha) {
      if (!SHA.test(sha ?? '')) throw new Error(`not a commit: ${sha}`);
      if (!OWNER_REPO.test(repo ?? '')) throw new Error(`not an owner/repo: ${repo}`);
      for (const ref of refs) {
        if (!REF.test(ref ?? '')) throw new Error(`not a tag name: ${ref}`);
        const args = ['api', `repos/${repo}/compare/${ref}...${sha}`, '--jq', '{status:.status}'];
        const result = await exec('gh', args);
        if (result.status !== 0) {
          if (NOT_FOUND.test(result.stderr ?? '')) continue;
          throw new Error(`gh ${args.join(' ')} failed: ${(result.stderr || result.error?.message || 'no output').trim()}`);
        }
        const { status } = JSON.parse(result.stdout);
        if (!['behind', 'identical', 'ahead', 'diverged'].includes(status)) throw new Error(`gh ${args.join(' ')} returned status ${status}`);
        return { ref, contained: status === 'behind' || status === 'identical' };
      }
      return { ref: null, contained: null };
    },
    /**
     * The version of `name` the newest `chain[0]` installs, walking each
     * manifest's dependencies (then optionalDependencies) down the chain and
     * resolving every range to its highest published match with npm.
     */
    async bundled(chain, name) {
      for (const pkg of [...chain, name]) if (!PACKAGE_NAME.test(pkg ?? '')) throw new Error(`not a package name: ${pkg}`);
      const carrierVersion = await json('npm', ['view', chain[0], 'version', '--json']);
      let [pkg, version] = [chain[0], carrierVersion];
      const trail = [`${pkg} ${version}`];
      const unresolved = (basis) => ({ carrier: chain[0], carrierVersion, version: null, basis });
      for (const next of [...chain.slice(1), name]) {
        const manifest = await json('npm', ['view', `${pkg}@${version}`, '--json']);
        const range = manifest?.dependencies?.[next] ?? manifest?.optionalDependencies?.[next];
        if (!range) return unresolved(`${pkg} ${version} does not depend on ${next}`);
        const args = ['view', `${next}@${range}`, 'version', '--json'];
        const result = await exec('npm', args);
        if (result.status !== 0 && NO_MATCH.test(result.stderr ?? '')) return unresolved(`no published ${next} satisfies ${range}`);
        if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${(result.stderr || result.error?.message || 'no output').trim()}`);
        const resolved = maxVersion(JSON.parse(result.stdout || 'null'));
        if (!resolved) return unresolved(`no published ${next} satisfies ${range}`);
        [pkg, version] = [next, resolved];
        trail.push(`${pkg} ${version}`);
      }
      return { carrier: chain[0], carrierVersion, version, basis: trail.join(' → ') };
    },
    async release({ channel, name }) {
      if (!PACKAGE_NAME.test(name)) throw new Error(`not a package or repository name: ${name}`);
      if (channel === 'npm') return releaseFacts('npm', await json('npm', ['view', name, 'time', 'dist-tags', '--json']));
      return releaseFacts('github-release', await json('gh', ['api', `repos/${name}/releases?per_page=100`]));
    },
  };
}
