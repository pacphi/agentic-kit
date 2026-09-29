// The upstream watch's ledger: `events.ndjson` on the orphan branch named by
// `watchPolicy.ledger.branch` (spec 2026-09-28). Read and built with git
// plumbing, so no checkout, index or local branch changes; `build` returns a
// commit the workflow pushes. Every git call goes through an injectable exec.
import { spawn } from 'node:child_process';

export const LEDGER_FILE = 'events.ndjson';
export const LEDGER_README = `# Upstream watch ledger

This branch is written only by agentic-kit's upstream watch workflow
(\`.github/workflows/upstream-watch.yml\` on \`main\`). It shares no history with \`main\`.

- \`events.ndjson\` holds one record per line, oldest first.
- Each commit adds the records of one run. Its \`Checked-At\` trailer is where the next run starts.

Query it from a clone of agentic-kit:

\`\`\`bash
node scripts/upstream-watch.mjs ledger --since 2026-09-01
git fetch origin upstream-watch-ledger && git show origin/upstream-watch-ledger:events.ndjson
\`\`\`

How it works: \`docs/upstream-watch.md\` on \`main\`.
`;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, error: Error | null }} ExecResult
 * @typedef {(command: string, args: string[], options?: { input?: string | null, cwd?: string, env?: NodeJS.ProcessEnv }) => Promise<ExecResult>} Exec
 */

/** Run a command without a shell, feeding `input` on stdin; resolves with its status and output,
 *  never rejects. `env` is passed through to spawn(); omitted, the child inherits process.env.
 * @param {string} command
 * @param {string[]} args
 * @param {{ input?: string | null, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<ExecResult>} */
export function runWithInput(command, args, { input = null, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    // A command that exits before reading all of stdin (e.g. `git hash-object`
    // on an empty blob) closes its end of the pipe first; the parent's write
    // then fails with EPIPE. Without this listener that's an unhandled error
    // on the stdin stream — an uncaughtException that can surface async,
    // after this promise (and its test) already settled. The real outcome is
    // still `close`, so a stdin write failure is silently ignored here.
    child.stdin.on('error', () => {});
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr, error: null }));
    child.stdin.end(input ?? '');
  });
}

/** A ledger record from an event (`eventLine` shape), without null or undefined fields. */
export function toRecord(event, recordedAt) {
  const fields = Object.fromEntries(Object.entries(event.fields ?? {}).filter(([, value]) => value != null));
  return { line: event.line, id: event.id, event: event.event, date: event.date, fields, recordedAt };
}

const isUtc = (value) => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const isRecord = (parsed) => ['id', 'event', 'date'].every((key) => typeof parsed[key] === 'string')
  && Boolean(parsed.fields) && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields) && isUtc(parsed.recordedAt);

export function parseRecords(text) {
  return String(text).split('\n').map((line, index) => /** @type {[string, number]} */ ([line, index + 1]))
    .filter(([line]) => line.trim())
    .map(([line, number]) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { throw new Error(`${LEDGER_FILE} line ${number} is not JSON`); }
      if (!parsed || typeof parsed.line !== 'string' || !parsed.line.trim()) throw new Error(`${LEDGER_FILE} line ${number} has no ledger line`);
      if (!isRecord(parsed)) throw new Error(`${LEDGER_FILE} line ${number} is not a ledger record`);
      return parsed;
    });
}

export const serializeRecords = (records) => records.map((item) => JSON.stringify(item)).join('\n') + (records.length ? '\n' : '');

/** @param {{ exec?: Exec, cwd?: string, remote?: string }} [options] */
export function createLedgerStore({ exec = runWithInput, cwd = process.cwd(), remote = 'origin' } = {}) {
  const git = async (args, input = null) => {
    const result = await exec('git', args, { input, cwd });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || 'no output').trim()}`);
    return result.stdout;
  };
  return {
    /** The ledger on `remote`: tip, records and Checked-At; empty when the branch does not exist. */
    async read(branch, { now = new Date() } = {}) {
      if (!BRANCH.test(branch ?? '')) throw new Error(`not a branch name: ${branch}`);
      const tracking = `refs/remotes/${remote}/${branch}`;
      // Exit 2 means no such branch; git's message would be translated on some machines.
      const listed = await exec('git', ['ls-remote', '--exit-code', '--heads', remote, branch], { cwd });
      if (listed.status === 2) return { commit: null, records: [], checkedAt: null };
      if (listed.status !== 0) throw new Error(`git ls-remote ${remote} ${branch} failed: ${(listed.stderr || listed.error?.message || 'no output').trim()}`);
      // Full depth: a shallow fetch would mark a maintainer's full clone shallow.
      const fetched = await exec('git', ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${tracking}`], { cwd });
      if (fetched.status !== 0) throw new Error(`git fetch ${remote} ${branch} failed: ${(fetched.stderr || fetched.error?.message || 'no output').trim()}`);
      const commit = (await git(['rev-parse', '--verify', `${tracking}^{commit}`])).trim();
      const records = parseRecords(await git(['show', `${commit}:${LEDGER_FILE}`]));
      const trailer = (await git(['log', '-1', '--format=%(trailers:key=Checked-At,valueonly)', commit])).trim();
      // Missing, malformed or future: absent. A future start would silence every reply until then.
      const checkedAt = ISO.test(trailer) && Date.parse(trailer) <= now.getTime() ? trailer : null;
      return { commit, records, checkedAt };
    },
    /** The next ledger commit (never pushed): README and every record, parent the current tip. */
    async build({ parent, records, checkedAt, subject, sentences = [] }) {
      if (parent !== null && !SHA.test(parent ?? '')) throw new Error(`not a commit: ${parent}`);
      if (!ISO.test(checkedAt ?? '')) throw new Error(`not a UTC time: ${checkedAt}`);
      const readme = (await git(['hash-object', '-w', '--stdin'], LEDGER_README)).trim();
      const events = (await git(['hash-object', '-w', '--stdin'], serializeRecords(records))).trim();
      const tree = (await git(['mktree'], `100644 blob ${readme}\tREADME.md\n100644 blob ${events}\t${LEDGER_FILE}\n`)).trim();
      const message = `${subject}\n\n${sentences.length ? `${sentences.join('\n')}\n\n` : ''}Checked-At: ${checkedAt}\n`;
      return (await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], message)).trim();
    },
  };
}
