// `--json` failures stay JSON (ADR-0063; the audit record's Decision 6 for
// `ak sync --json`). Whatever stops a `--json` invocation early — an option
// the parser rejects, a usage error a command raises itself, or an unreadable
// kit.json — stdout still carries exactly one JSON object, and every human
// line (the message, the help, the recovery commands) goes to stderr. Each
// case runs the real CLI in a child process so stdout and stderr can be read
// apart.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxHome, sandboxProject, spawnEnv, rmrf } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-cli-json-honesty');
const PROJECT = sandboxProject('ak-cli-json-honesty');
after(() => rmrf(HOME, PROJECT));
const { configErrorRecovery, KitConfigError } = await import('../../src/lib/config.mjs');

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(PKG_ROOT, 'bin', 'agentic-kit.mjs');
const KIT_JSON = path.join(HOME, '.config', 'agentic-kit', 'kit.json');

/** Run `ak …args` in the sandbox. */
function ak(args, envOverrides = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: PROJECT, env: { ...spawnEnv(HOME), ...envOverrides }, encoding: 'utf8', timeout: 120_000,
  });
}

/** stdout must hold exactly one JSON value; JSON.parse rejects anything else. */
function oneJson(child) {
  assert.ok(child.stdout.trim().startsWith('{'), `stdout is not a JSON object:\n${child.stdout}\n--- stderr:\n${child.stderr}`);
  return JSON.parse(child.stdout);
}

const SYNC_SHAPE = ['plan', 'steps', 'unresolved', 'skipped', 'needsYourAction', 'converged', 'exitCode', 'error'];

// ── options the parser rejects ───────────────────────────────────────────────

test('ak sync --json with an unknown option answers with the sync result shape and exit 2', () => {
  const child = ak(['sync', '--json', '--bogus']);
  const out = oneJson(child);
  assert.equal(child.status, 2, child.stderr);
  assert.deepEqual(Object.keys(out), SYNC_SHAPE);
  assert.deepEqual([out.plan, out.steps, out.unresolved, out.skipped, out.needsYourAction], [[], [], [], [], []]);
  assert.equal(out.converged, null);
  assert.equal(out.exitCode, 2);
  assert.match(out.error, /Unknown option '--bogus'/);
  assert.match(child.stderr, /ak sync: Unknown option '--bogus'/, 'the message goes to stderr');
  assert.match(child.stderr, /Usage: ak sync/, 'so does the help');
});

test('ak status --json with an unknown option answers { error, exitCode: 2 }', () => {
  const child = ak(['status', '--json', '--bogus']);
  const out = oneJson(child);
  assert.equal(child.status, 2, child.stderr);
  assert.deepEqual(Object.keys(out), ['error', 'exitCode']);
  assert.equal(out.exitCode, 2);
  assert.match(out.error, /Unknown option '--bogus'/);
  assert.match(child.stderr, /ak status: Unknown option '--bogus'/);
  assert.match(child.stderr, /Usage: ak status/);
});

test('a retired spelling under --json gets the generic unknown-option error, with no hint', () => {
  for (const args of [['status', '--json', '--live'], ['status', '--json', '--deep'], ['system', '--json', '--deep']]) {
    const child = ak(args);
    const out = oneJson(child);
    assert.equal(child.status, 2, child.stderr);
    assert.match(out.error, new RegExp(`^Unknown option '${args[2]}'`), args.join(' '));
    assert.doesNotMatch(out.error, /refresh/, `${args.join(' ')}: no hint names the replacement`);
  }
});

test('a --json after the -- terminator is a positional, so a rejected option answers in text', () => {
  for (const cmd of ['sync', 'status']) {
    const child = ak([cmd, '--bogus', '--', '--json']);
    assert.equal(child.status, 2, child.stderr);
    assert.doesNotMatch(child.stdout.trim(), /^\{/, `${cmd}: stdout is not JSON`);
    assert.match(child.stdout, new RegExp(`ak ${cmd}: Unknown option '--bogus'`));
    assert.match(child.stdout, new RegExp(`Usage: ak ${cmd}`));
  }
});

test('without --json a rejected option still prints the message and help on stdout', () => {
  const child = ak(['status', '--bogus']);
  assert.equal(child.status, 2);
  assert.match(child.stdout, /ak status: Unknown option '--bogus'/);
  assert.match(child.stdout, /Usage: ak status/);
  assert.doesNotMatch(child.stdout.trim(), /^\{/);
});

// ── usage errors the commands raise themselves ───────────────────────────────

const USAGE_ERRORS = [
  [['status', '--json', '--refresh=bogus'], /--refresh=bogus is not a refresh strength/],
  [['status', '--json', '--refresh', 'live'], /unexpected argument 'live'/],
  [['status', '--json', '--only', 'security'], /--only needs --refresh=live/],
  [['status', '--json', '--project-trees'], /--project-trees needs --refresh=machine/],
  [['system', '--json', '--refresh=bogus'], /--refresh=bogus is not a refresh strength/],
  [['system', '--json', '--refresh', 'live'], /unexpected argument 'live'/],
  [['system', '--json', '--only', 'security'], /--only applies to ak status --refresh=live/],
  [['system', '--json', '--project-trees'], /--project-trees needs --refresh=machine/],
  [['maintain', '--json', '--refresh=bogus'], /--refresh=bogus is not a refresh strength/],
  [['maintain', '--json', '--refresh', 'live'], /unexpected argument 'live'/],
  // `report --refresh=live --only …` is refused too, not silently accepted
  // and ignored — `--only` is `ak status`'s alone.
  [['maintain', '--json', '--refresh=live', '--only', 'security'], /--only applies to ak status --refresh=live/],
  [['maintain', 'inventory', '--json', '--refresh'], /--refresh applies to ak maintain report/],
  [['maintain', 'inventory', '--json', '--project-trees'], /--project-trees needs --refresh=machine/],
  [['maintain', 'bogus', '--json'], /usage: ak maintain/],
];

for (const [args, message] of USAGE_ERRORS) {
  test(`ak ${args.join(' ')}: one JSON object { error, exitCode: 2 }, the human line on stderr`, () => {
    const child = ak(args);
    const out = oneJson(child);
    assert.equal(child.status, 2, child.stderr);
    assert.deepEqual(Object.keys(out), ['error', 'exitCode']);
    assert.equal(out.exitCode, 2);
    assert.match(out.error, message);
    assert.match(child.stderr, message);
  });
}

const COMMAND_USAGE_ERRORS = [
  [['usage', 'bogus', '--json'], /usage: ak usage/],
  [['usage', 'score', '--window', '99', '--json'], /--window must be/],
  [['usage', 'prompts', '--window', '99', '--json'], /--window must be/],
  [['usage', 'score', 'extra', '--json'], /unexpected argument 'extra'/],
  [['usage', 'prompts', 'extra', '--json'], /unexpected argument 'extra'/],
  [['models', 'bogus', '--json'], /usage: ak models/],
  [['models', 'explain', '--json'], /usage: ak models explain/],
  [['models', 'plan', '--json'], /usage: ak models plan/],
  [['models', 'status', 'extra', '--json'], /unexpected argument/],
  [['models', 'status', '--host', 'bogus', '--json'], /unsupported model host/],
  [['audit', 'bogus', '--json'], /requires the hooks or context subcommand/],
  [['heal', 'bogus', '--json'], /requires the hooks subcommand/],
  [['heal', 'hooks', '--yes', '--json'], /--yes requires --apply/],
  [['x', 'aqe-store', 'bogus', '--json'], /usage: ak x aqe-store/],
  [['x', 'aqe-embedding', 'bogus', '--json'], /aqe-embedding/],
  [['x', 'codex-context', 'bogus', '--json'], /codex-context/],
  [['x', 'skills', 'bogus', '--json'], /usage: ak x skills/],
  [['x', 'reference', 'bogus', '--json'], /reference/],
  [['x', 'statusline', 'bogus', '--json'], /usage: ak x statusline/],
  [['x', 'daemon-gc', 'bogus', '--json'], /unexpected argument/],
  [['x', 'harvest', 'bogus', '--json'], /unexpected argument/],
  [['host', 'bogus', '--json'], /unknown host subcommand/],
  [['host', 'status', 'extra', '--json'], /unexpected argument/],
  [['host', 'adapters', '--json'], /unknown host subcommand: adapters \(status\|pick\|reset-routes\|off\|check-connection\|align\)/],
];

for (const [args, message] of COMMAND_USAGE_ERRORS) {
  test(`ak ${args.join(' ')} reports one command-level JSON usage error`, () => {
    const child = ak(args);
    const out = oneJson(child);
    assert.equal(child.status, 2, child.stderr);
    assert.deepEqual(Object.keys(out), ['error', 'exitCode']);
    assert.equal(out.exitCode, 2);
    assert.match(out.error, message);
    assert.match(child.stderr, message);
  });
}

for (const enabled of ['0', '1']) {
  test(`ak host adapters is an unknown subcommand even with the old feature flag set to ${enabled}`, () => {
    const child = ak(['host', 'adapters', 'revoke', 'acme', '--json'], { AK_EXPERIMENTAL_HOST_ADAPTERS: enabled });
    const out = oneJson(child);
    assert.equal(child.status, 2, child.stderr);
    assert.deepEqual(Object.keys(out), ['error', 'exitCode']);
    assert.equal(out.exitCode, 2);
    assert.match(out.error, /unknown host subcommand: adapters/);
  });
}

test('ak x aqe-provider is an unknown command', () => {
  const child = ak(['x', 'aqe-provider', 'acme']);
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stdout, /unknown plumbing command: aqe-provider/);
});

test('models rejects an unknown verb even when no snapshot exists', () => {
  const child = ak(['models', 'bogus', '--json']);
  assert.equal(child.status, 2, child.stderr);
  assert.match(oneJson(child).error, /usage: ak models/);
});

test('plain status rejects a stray positional with exit 2', () => {
  const child = ak(['status', 'stray']);
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stdout, /unexpected argument 'stray'/);
});

test('without --json a command-level usage error still prints on stdout', () => {
  const child = ak(['status', '--refresh=bogus']);
  assert.equal(child.status, 2);
  assert.match(child.stdout, /ak status: --refresh=bogus is not a refresh strength/);
});

// ── an unreadable kit.json keeps its recovery text ───────────────────────────

/** Write an invalid kit.json for the duration of `fn`, then remove it. */
function withInvalidKitJson(fn) {
  fs.mkdirSync(path.dirname(KIT_JSON), { recursive: true });
  fs.writeFileSync(KIT_JSON, '{ not json');
  try { return fn(); } finally { rmrf(KIT_JSON); }
}

const RECOVERY_COMMAND = /^mv -- |^Move-Item /;

test('ak sync --json with an invalid kit.json answers with error and the recovery commands', () => {
  withInvalidKitJson(() => {
    const child = ak(['sync', '--json']);
    const out = oneJson(child);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(out.exitCode, 1);
    assert.equal(out.converged, null);
    assert.match(out.error, /invalid kit config/);
    assert.match(out.recovery.commands[0], RECOVERY_COMMAND);
    assert.equal(out.recovery.commands[1], 'ak status');
    assert.ok(out.recovery.backup.endsWith('kit.json.invalid'), out.recovery.backup);
    assert.match(out.recovery.note, /restore only the intended values/);
    assert.match(child.stderr, /Recovery \(the original is preserved\):/, 'the human recovery lines go to stderr');
    assert.ok(child.stderr.includes(out.recovery.commands[0]));
    assert.equal(fs.readFileSync(KIT_JSON, 'utf8'), '{ not json', 'the original is preserved');
  });
});

test('ak status --json with an invalid kit.json answers with the same recovery, exit 1', () => {
  withInvalidKitJson(() => {
    const sync = oneJson(ak(['sync', '--json']));
    const child = ak(['status', '--json']);
    const out = oneJson(child);
    assert.equal(child.status, 1, child.stderr);
    assert.deepEqual(Object.keys(out), ['error', 'exitCode', 'recovery']);
    assert.equal(out.exitCode, 1);
    assert.match(out.error, /invalid kit config/);
    assert.deepEqual(out.recovery, sync.recovery);
    assert.match(child.stderr, /Recovery \(the original is preserved\):/);
    assert.ok(child.stderr.includes(out.recovery.commands[0]));
  });
});

// `discovery` reads kit.json (its discovery intent); the default `report` verb
// does not, so an invalid kit.json does not stop it.
test('ak maintain discovery --json with an invalid kit.json answers with the recovery, exit 1, not a usage refusal', () => {
  withInvalidKitJson(() => {
    const child = ak(['maintain', 'discovery', '--json']);
    const out = oneJson(child);
    assert.equal(child.status, 1, child.stderr);
    assert.deepEqual(Object.keys(out), ['error', 'exitCode', 'recovery']);
    assert.equal(out.exitCode, 1);
    assert.match(out.error, /invalid kit config/);
    assert.match(out.recovery.commands[0], RECOVERY_COMMAND);
    assert.match(child.stderr, /Recovery \(the original is preserved\):/);
  });
});

test('without --json an invalid kit.json still prints the recovery on stdout', () => {
  withInvalidKitJson(() => {
    const child = ak(['status']);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /Recovery \(the original is preserved\):/);
    assert.match(child.stdout, /^ {2}(mv -- |Move-Item )/m);
    assert.match(child.stdout, /^ {2}ak status$/m);
  });
});

test('configErrorRecovery: the move command for each shell, and null for any other error', () => {
  const err = new KitConfigError("/home/o'neil/.config/agentic-kit/kit.json", 'Unexpected token');
  const posix = configErrorRecovery(err, 'linux');
  assert.deepEqual(posix, {
    backup: "/home/o'neil/.config/agentic-kit/kit.json.invalid",
    commands: [
      `mv -- '/home/o'"'"'neil/.config/agentic-kit/kit.json' '/home/o'"'"'neil/.config/agentic-kit/kit.json.invalid'`,
      'ak status',
    ],
    note: "Then compare /home/o'neil/.config/agentic-kit/kit.json.invalid with the regenerated defaults and restore only the intended values.",
  });
  const win = configErrorRecovery(new KitConfigError("C:\\Users\\o'neil\\kit.json", 'bad'), 'win32');
  assert.equal(win.commands[0],
    "Move-Item -LiteralPath 'C:\\Users\\o''neil\\kit.json' -Destination 'C:\\Users\\o''neil\\kit.json.invalid'");
  assert.equal(configErrorRecovery(new Error('boom')), null);
  assert.equal(configErrorRecovery(undefined), null);
});
