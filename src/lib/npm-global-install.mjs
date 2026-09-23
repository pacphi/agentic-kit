// One reviewed lifecycle-script policy for every npm GLOBAL install agentic-kit
// performs. npm 11 accepts --allow-scripts for global installs; depending on
// the npm release and local policy, an unlisted lifecycle may be warned about
// or denied. Passing the reviewed list keeps installation behavior explicit and
// prevents the initial-host path from drifting from the upgrade/heal path.
import { run } from './exec.mjs';

export const REVIEWED_GLOBAL_INSTALL_SCRIPTS = Object.freeze([
  'ruflo',
  'agentic-qe',
  '@claude-flow/cli',
  'better-sqlite3',
  'hnswlib-node',
  'agentdb',
  'agentic-flow',
  'argon2',
  'onnxruntime-node',
  'sharp',
  'protobufjs',
  '@google/genai',
  'tldjs',
  'vibium',
  // Ruflo's shipped browser MCP shells out to this native CLI. Its postinstall
  // downloads the platform binary and rewires the global shim; npm exit zero
  // alone is not viability evidence, so the dedicated lifecycle also verifies
  // the package-owned binary and its reported version.
  'agent-browser',
  // Claude Code's npm package materializes the platform executable from its
  // postinstall. Without this entry npm can report an installed package while
  // leaving a non-viable `claude` command under strict lifecycle policy.
  '@anthropic-ai/claude-code',
  // OpenCode's npm wrapper also materializes its platform executable in
  // postinstall. The shared policy must cover every managed host whose package
  // declares an install lifecycle, not only the incident that exposed it.
  'opencode-ai',
]);

export const reviewedGlobalInstallScripts = () => REVIEWED_GLOBAL_INSTALL_SCRIPTS.join(',');

export function globalInstallArgs(spec, { preferOnline = false } = {}) {
  if (typeof spec !== 'string' || !spec.trim()) throw new TypeError('global npm install spec is required');
  return ['install', '-g', ...(preferOnline ? ['--prefer-online'] : []),
    `--allow-scripts=${reviewedGlobalInstallScripts()}`, spec];
}

const firstLine = (r) => (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')
  .map((line) => line.trim()).find((line) => /^[A-Za-z]*Error\b/.test(line))
  ?? (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0];
const failure = (r) => (r.stderr || `exit ${r.code}`).split('\n').slice(-2).join(' ').slice(0, 200);
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Install a global package that provides a CLI, then prove `bin --version`.
 * npm exit 0 is not viability evidence: npm silently drops an optional
 * dependency that fails to fetch or build. Platform-binary packages (Codex's
 * `@openai/codex-<os>-<cpu>` aliases) are published minutes after the main
 * version, so an upgrade inside that window can leave a launcher with no
 * binary. One `--prefer-online` retry revalidates cached registry metadata
 * and restores the missing optional dependency.
 * @returns {Promise<{ok: boolean, changed: boolean, retried: boolean, detail: string}>} */
export async function installGlobalCli(spec, bin, { runner = run, sleep = pause, timeout = 600_000 } = {}) {
  let retried = false;
  let verify = null;
  for (const preferOnline of [false, true]) {
    if (preferOnline) { retried = true; await sleep(5_000); }
    const r = await runner('npm', globalInstallArgs(spec, { preferOnline }), { timeout });
    if (r.code !== 0) return { ok: false, changed: retried, retried, detail: failure(r) };
    verify = await runner(bin, ['--version'], { timeout: 15_000 });
    if (verify.code === 0) {
      return { ok: true, changed: true, retried, detail: retried ? `installed ${spec} (repaired on retry)` : `installed ${spec}` };
    }
  }
  return { ok: false, changed: true, retried,
    detail: `installed package but ${bin} --version failed: ${firstLine(verify).slice(0, 160)}` };
}
