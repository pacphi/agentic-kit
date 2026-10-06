import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.mjs') });

async function gateMessages(code, file) {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages.filter((message) => message.message.includes('ADR-0064'));
}

const WRITERS = {
  'a default fs import': "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');\n",
  'a named fs import': "import { writeFileSync } from 'node:fs';\nwriteFileSync('x', 'y');\n",
  'a promises import': "import fsp from 'node:fs/promises';\nawait fsp.writeFile('x', 'y');\n",
  'fs.promises': "import fs from 'node:fs';\nawait fs.promises.rm('x');\n",
  'an injected fsImpl': 'export const f = (fsImpl) => fsImpl.mkdirSync("x");\n',
  'a named user-dir import': "import { codexDir } from './paths.mjs';\nexport const d = codexDir();\n",
  'a namespaced user-dir call': "import * as paths from './paths.mjs';\nexport const d = paths.claudeDir();\n",
};

for (const [name, code] of Object.entries(WRITERS)) {
  test(`the rule warns on ${name} in a writer module`, async () => {
    const messages = await gateMessages(code, 'src/lib/example.mjs');
    assert.ok(messages.length >= 1, name);
    assert.ok(messages.every((message) => message.severity === 1), 'warn, not error');
  });
}

test('the rule leaves reads alone', async () => {
  const code = "import fs from 'node:fs';\nexport const r = fs.readFileSync('x', 'utf8');\n";
  assert.deepEqual(await gateMessages(code, 'src/lib/example.mjs'), []);
});

test('the rule skips the three modules that own writes', async () => {
  const code = "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');\n";
  for (const file of ['src/lib/file-write.mjs', 'src/lib/scope-gate.mjs', 'src/lib/paths.mjs']) {
    assert.deepEqual(await gateMessages(code, file), [], file);
  }
});

test('the rule does not reach tests or bin', async () => {
  const code = "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');\n";
  assert.deepEqual(await gateMessages(code, 'tests/kit/example.mjs'), []);
  assert.deepEqual(await gateMessages(code, 'bin/example.mjs'), []);
});
