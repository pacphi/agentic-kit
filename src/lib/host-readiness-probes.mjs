// Native setup observations, never inference requests or a runtime-health claim.
// Native capabilities and output shapes are inspected, not exact version locks.
// Unsupported provider/configuration layers remain unknown, not broken.
import path from 'node:path';
import { run as nativeRun, have as nativeHave } from './exec.mjs';
import { assessLocalSelection } from './host-readiness-local.mjs';

const HOSTS = new Set(['claude', 'codex', 'opencode']);
const MAX_OUTPUT = 1024 * 1024;
const observation = (state, reason) => ({ state, reason });
const unknown = reason => observation('unknown', reason);
const initial = () => ({
  installation: unknown('Installation has not been assessed.'),
  configuration: unknown('Effective configuration has not been assessed.'),
  authentication: unknown('Authentication requirements have not been assessed.'),
  model: unknown('Model selection has not been assessed.'),
});

function versionFrom(host, output) {
  const patterns = {
    claude: /^(\d+\.\d+\.\d+) \(Claude Code\)$/,
    codex: /^codex-cli (\d+\.\d+\.\d+)$/,
    opencode: /^(?:opencode )?(\d+\.\d+\.\d+)$/,
  };
  return patterns[host].exec(output.trim())?.[1] ?? null;
}

function jsonObject(output) {
  try {
    const result = JSON.parse(output);
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  } catch { return null; }
}

async function capability(probe, args, flag = '') {
  const output = await probe([...args, '--help']);
  return output?.code === 0 && /Usage:/i.test(output.stdout) && (!flag || output.stdout.includes(flag));
}

async function codexSetup(probe, result) {
  // Listing uses the native configuration loader without starting MCP servers.
  // Doctor also probes provider networks and desktop runtime: too broad for a
  // passive badge. Never export this listing, which may contain credentials.
  const report = await capability(probe, ['mcp', 'list'], '--json') ? await probe(['mcp', 'list', '--json']) : null;
  if (report?.code === 0) {
    try {
      const entries = JSON.parse(report.stdout);
      if (Array.isArray(entries) && entries.every(entry => entry && typeof entry.name === 'string')) {
        result.configuration = observation('pass', 'Codex loaded invocation configuration; MCP connections and active-session overrides are not checked.');
      }
    } catch { /* unrecognized output stays unknown */ }
  }
  const login = await capability(probe, ['login', 'status']) ? await probe(['login', 'status']) : null;
  // Documented exit zero means native credentials are present, not that a
  // provider request succeeded. Nonzero may be appropriate for custom/local
  // providers and must not be interpreted as a mandatory sign-in failure.
  if (login?.code === 0 && (!result.target?.provider || result.target.provider === 'openai')) {
    result.authentication = observation('pass', 'Codex reports configured authentication; inference was not tested.');
  }
}

async function claudeSetup(probe, result) {
  // Known doctor output shape: a clean native settings check is bounded
  // evidence, not a claim about session trust or organization policy.
  const doctor = await capability(probe, ['doctor']) ? await probe(['doctor']) : null;
  if (doctor?.code === 0 && doctor.stdout.startsWith('Claude Code doctor\n')
    && /^No installation issues found\.$/m.test(doctor.stdout)
    && !/\b(?:error|errors|invalid|warning|warnings|failed|failure)\b/i.test(doctor.stdout)) {
    result.configuration = observation('pass', 'Claude doctor reported clean installation and settings diagnostics; session trust and remote policy are not checked.');
  }
  const report = await capability(probe, ['auth', 'status'], '--json') ? await probe(['auth', 'status', '--json']) : null;
  const data = report && [0, 1].includes(report.code) ? jsonObject(report.stdout) : null;
  if (report?.code === 0 && data?.loggedIn === true && typeof data.apiProvider === 'string' && data.apiProvider.length > 0) {
    result.authentication = observation('pass', 'Claude reports configured authentication; inference was not tested.');
  } else if (data?.loggedIn === false && data.apiProvider === 'firstParty') {
    result.authentication = observation('fail', 'Claude reports no configured first-party authentication.');
  }
}

/** Collect bounded, noninteractive, sanitized native setup observations.
 * Unsupported capabilities and ambiguous errors remain unknown. Missing
 * executables, invalid local config and explicit required sign-out are failures.
 * No credentials, paths from native output, or native diagnostic text escape.
 * @param {{host:string,cwd:string,run?:typeof nativeRun,have?:typeof nativeHave,
 * home?:string,env?:NodeJS.ProcessEnv,assessSelection?:typeof assessLocalSelection}} options
 */
export async function collectHostSetup({ host, cwd, run = nativeRun, have = nativeHave, home, env = process.env, assessSelection = assessLocalSelection }) {
  if (!HOSTS.has(host)) throw new TypeError('unsupported host');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('cwd must be absolute');
  const result = initial();
  let present;
  try { present = await have(host, { timeout: 5000, maxBuffer: MAX_OUTPUT, cwd }); }
  catch { return result; }
  if (present === false) {
    result.installation = observation('fail', 'The enabled host executable is not available on PATH.');
    return result;
  }
  if (present !== true) return result;
  const probe = async args => {
    try {
      const value = await run(host, args, { cwd, env, timeout: 10000, maxBuffer: MAX_OUTPUT });
      if (!value || typeof value.stdout !== 'string' || typeof value.code !== 'number'
        || Buffer.byteLength(value.stdout, 'utf8') > MAX_OUTPUT) return null;
      return value;
    } catch { return null; }
  };
  const launched = await probe(['--version']);
  if (launched?.code !== 0) return result;
  const version = versionFrom(host, launched.stdout);
  result.installation = { ...observation('pass', 'The host version command completed successfully.'), ...(version ? { version } : {}) };
  const local = assessSelection({ host, cwd, home, env });
  Object.assign(result, local);
  const localConfiguration = local.configuration;
  if (host === 'codex') await codexSetup(probe, result);
  else if (host === 'claude') await claudeSetup(probe, result);
  if (localConfiguration?.state === 'fail') result.configuration = localConfiguration;
  return result;
}
