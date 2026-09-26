import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqeTomlEnvironment } from '../../src/lib/aqe-embedding-toml.mjs';

test('ordinary quoted Codex project tables do not block a scoped AQE edit', () => {
  const unrelated = '[projects."/Users/user/a.b"]\ntrust_level = "trusted"\n';
  const source = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\nargs = []\n' + unrelated;
  const next = aqeTomlEnvironment(source).replace({ present: true, value: 'http://localhost:11434' });
  assert.ok(next.includes(unrelated));
  assert.match(next, /AQE_EMBEDDER_ENDPOINT/);
});
test('quoted aliases of AQE tables are recognized without confusing dots within keys', () => {
  const source = '[mcp_servers."agentic-qe"]\ncommand = "aqe-mcp"\n[mcp_servers."agentic-qe".env]\nAQE_EMBEDDER_ENDPOINT = "http://localhost:11434"\n';
  assert.equal(aqeTomlEnvironment(source).current.value, 'http://localhost:11434');
  assert.equal(aqeTomlEnvironment('[mcp_servers."agentic-qe.env"]\ncommand = "other"\n').missing, true);
});
test('multi-line AQE args written by aqe/codex are recognized and edited in place', () => {
  const base = '[mcp_servers.agentic-qe]\ntype = "stdio"\ncommand = "npx"\nargs = [\n    "-y",\n    "agentic-qe@latest",\n    "mcp",\n]\n\n[mcp_servers.agentic-qe.env]\nAQE_V3_MODE = "true"\n';
  const editor = aqeTomlEnvironment(base);
  assert.deepEqual(editor.current, { present: false });
  const next = editor.replace({ present: true, value: 'http://127.0.0.1:11434' });
  assert.ok(next.startsWith(base.slice(0, base.indexOf('[mcp_servers.agentic-qe.env]'))));
  assert.equal(aqeTomlEnvironment(next).current.value, 'http://127.0.0.1:11434');
});
test('multi-line AQE args with non-string entries or comments stay unsupported', () => {
  assert.throws(() => aqeTomlEnvironment('[mcp_servers.agentic-qe]\ncommand = "npx"\nargs = [\n  1,\n]\n'), /arguments encoding/);
  assert.throws(() => aqeTomlEnvironment('[mcp_servers.agentic-qe]\ncommand = "npx"\nargs = [\n  "-y", # pin\n  "agentic-qe",\n]\n'), /arguments encoding/);
});

// #237 (audit P1): root and [mcp_servers] assignments that cannot alias the AQE
// registration are user-owned and must not block the scoped edit; every form that
// can alias it (inline, dotted, quoted, escaped) is refused, never guessed.
const AQE = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\nargs = []\n';
const AQE_ENV = `${AQE}\n[mcp_servers.agentic-qe.env]\nAQE_EMBEDDER_ENDPOINT = "http://127.0.0.1:11434"\n`;
const INLINE = /inline, dotted or quoted AQE registrations require manual embedding configuration/;
const DOTTED = /dotted or quoted TOML assignments require manual embedding configuration/;
const TRANSPORT = /unrecognized AQE MCP transport preserved/;
const cases = [
  ['C01 root dotted tui.status_line before AQE (reporter)', 'tui.status_line = ["model"]\n' + AQE, 'ok'],
  ['C02 root multi-line array', 'tui.status_line = [\n  "model",\n  "cwd",\n]\n' + AQE, 'ok'],
  ['C03 root multi-line basic string hiding a fake AQE assignment', 'notes = """\nmcp_servers.agentic-qe.command = "evil"\n"""\n' + AQE, 'ok'],
  ['C04 root multi-line literal string hiding a fake table', "notes = '''\n[mcp_servers.agentic-qe.env]\n'''\n" + AQE, 'ok'],
  ['C05 root unrelated inline table', 'tui = { status_line = ["model"] }\n' + AQE, 'ok'],
  ['C06 root dotted mcp_servers."agentic-qe".command', 'mcp_servers."agentic-qe".command = "x"\n' + AQE, INLINE],
  ["C07 root dotted mcp_servers.'agentic-qe'.env.X", "mcp_servers.'agentic-qe'.env.X = \"y\"\n" + AQE, INLINE],
  ['C08 root dotted key with whitespace around dots', 'mcp_servers . agentic-qe . command = "x"\n' + AQE, INLINE],
  ['C09 inline agentic-qe under [mcp_servers], no AQE table', '[mcp_servers]\nagentic-qe = { command = "aqe" }\n', INLINE],
  ['C10 quoted inline "agentic-qe" under [mcp_servers]', '[mcp_servers]\n"agentic-qe" = { command = "aqe-mcp", args = [] }\n', INLINE],
  ['C11 unrelated dotted server under [mcp_servers]', '[mcp_servers]\nother.command = "x"\n\n' + AQE, 'ok'],
  ['C12 quoted AQE env header', `${AQE}\n[mcp_servers."agentic-qe".env]\nAQE_EMBEDDER_ENDPOINT = "http://x"\n`, 'ok'],
  ['C13 duplicate unrelated root dotted keys stay user-owned', 'tui.a = 1\ntui.a = 2\n' + AQE, 'ok'],
  ['C14 \\u-escaped quoted root "mcp\\u005Fservers"', '"mcp\\u005Fservers".agentic-qe.command = "x"\n' + AQE, INLINE],
  ['C15 \\U-escaped quoted root key is decoded, not rejected as JSON', '"\\U0001F600".x = 1\n' + AQE, 'ok'],
  ['C16 root key literally named "mcp_servers.agentic-qe"', '"mcp_servers.agentic-qe" = 1\n' + AQE, 'ok'],
  ['C17 root bare mcp_servers inline table', 'mcp_servers = { agentic-qe = { command = "aqe-mcp" } }\n', INLINE],
  ['C18 root dotted key, no AQE registration', 'tui.status_line = ["model"]\n', 'missing'],
  ['C19 dotted key inside the AQE table', `${AQE}env.AQE_EMBEDDER_ENDPOINT = "x"\n`, DOTTED],
  ['C20 dotted key inside the AQE env table', `${AQE}\n[mcp_servers.agentic-qe.env]\nA.B = "x"\n`, DOTTED],
  ['C21 root dotted key after comment and blank; env present', '# hi\n\nfeatures.web_search = true\n' + AQE_ENV, 'ok'],
  ['C22 root quoted unrelated key', '"model provider" = "x"\n' + AQE, 'ok'],
  ['C23 bare agentic-qe string under [mcp_servers]', '[mcp_servers]\nagentic-qe = "x"\n', INLINE],
  ['C24 absolute aqe ["mcp"] transport (Decision 3)', '[mcp_servers.agentic-qe]\ncommand = "/usr/local/bin/aqe"\nargs = ["mcp"]\n', 'ok'],
  ['C24b aqe ["mcp", "start"] transport stays preserved', '[mcp_servers.agentic-qe]\ncommand = "aqe"\nargs = ["mcp", "start"]\n', TRANSPORT],
  ['C25 inline agentic-qe AND a later AQE table', '[mcp_servers]\nagentic-qe = { command = "x" }\n\n' + AQE, INLINE],
  ['C26 CRLF root dotted key', ('tui.status_line = ["model"]\n' + AQE).replace(/\n/g, '\r\n'), 'ok'],
  ['C27 root dotted unrelated server', 'mcp_servers.other.command = "x"\n' + AQE, 'ok'],
  ['C28 \\u-escaped AQE table header is still the AQE table', '[mcp_servers."agentic\\u002Dqe"]\ncommand = "aqe-mcp"\nargs = []\n', 'ok'],
  ['C29 \\U-escaped unrelated table header', '[projects."\\U0001F600"]\ntrust_level = "trusted"\n' + AQE, 'ok'],
];

for (const [name, source, expected] of cases) {
  test(`TOML AQE editor: ${name}`, () => {
    if (expected instanceof RegExp) {
      assert.throws(() => aqeTomlEnvironment(source), expected);
      return;
    }
    const editor = aqeTomlEnvironment(source);
    if (expected === 'missing') {
      assert.equal(editor.missing, true);
      return;
    }
    assert.equal(editor.missing, undefined);
    const next = editor.replace({ present: true, value: 'http://127.0.0.1:9' });
    const base = source.search(/\[mcp_servers\.(?:agentic-qe|"agentic\\u002Dqe")\]/);
    assert.ok(next.startsWith(source.slice(0, base)), 'every byte before the AQE table is preserved');
    assert.equal(aqeTomlEnvironment(next).current.value, 'http://127.0.0.1:9');
  });
}

test('a key escape that is not a Unicode scalar value gives an honest encoding refusal', () => {
  // Unknown escapes are already refused by the structure scanner; these pass it but
  // are not valid TOML characters, so they must not be reported as JSON errors.
  for (const key of ['"\\UFFFFFFFF"', '"\\uD800"']) {
    assert.throws(() => aqeTomlEnvironment(`${key}.x = 1\n${AQE}`), /unsupported TOML key encoding/);
  }
});
