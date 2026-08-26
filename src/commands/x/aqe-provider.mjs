// Hidden stdin/stdout trampoline for Agentic-QE ADR-127 external providers.
// This command is intentionally absent from public help: users configure and
// grant adapters; AQE alone calls this transport. stdout is completion-only.
import path from 'node:path';
import { runAdmittedAqeProvider } from '../../lib/adapters/aqe-provider.mjs';

const MAX_PROMPT_BYTES = 1024 * 1024;

export const options = {
  model: { type: 'string' },
  'expect-hash': { type: 'string' },
  'project-root': { type: 'string' },
};

export const help = `ak x aqe-provider — internal Agentic-QE external-provider transport

This command is generated into .agentic-qe/llm-config.json by agentic-kit.
It requires a hash-pinned, admitted, enabled, explicitly granted adapter and
accepts the provider prompt on stdin. It is not a user configuration surface.

Examples:
  # Invoked by Agentic-QE from an agentic-kit-managed declaration:
  printf 'prompt' | ak x aqe-provider hermes --model default \\
    --expect-hash <sha256> --project-root /absolute/project`;

async function readPrompt(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_PROMPT_BYTES) throw new Error(`AQE provider prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function diagnosticLine(value) {
  const text = String(value ?? 'AQE provider bridge failed');
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function run({ flags, positionals }) {
  const id = positionals[0];
  if (typeof id !== 'string' || !id || positionals.length !== 1) {
    process.stderr.write('AQE provider bridge requires exactly one provider id\n');
    return 2;
  }
  if (typeof flags['expect-hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(flags['expect-hash'])) {
    process.stderr.write('AQE provider bridge requires --expect-hash <sha256>\n');
    return 2;
  }
  if (typeof flags['project-root'] !== 'string' || !path.isAbsolute(flags['project-root'])) {
    process.stderr.write('AQE provider bridge requires --project-root <absolute-path>\n');
    return 2;
  }

  let prompt;
  try {
    prompt = await readPrompt();
  } catch (error) {
    process.stderr.write(diagnosticLine(error?.message ?? error));
    return 1;
  }

  const result = await runAdmittedAqeProvider(id, {
    stdin: prompt,
    model: flags.model,
    expectedHash: flags['expect-hash'],
    projectRoot: path.resolve(flags['project-root']),
  });
  if (!result.ok) {
    // Never write partial hook output to stdout on failure: AQE treats any
    // nonempty stdout as a completion even when the child exits non-zero.
    process.stderr.write(diagnosticLine(result.stderrText?.trim() || result.detail));
    return Number.isInteger(result.exitCode) && result.exitCode > 0 && result.exitCode <= 255
      ? result.exitCode
      : 1;
  }

  if (result.stderrText) process.stderr.write(result.stderrText);
  process.stdout.write(result.stdoutText);
  return 0;
}
