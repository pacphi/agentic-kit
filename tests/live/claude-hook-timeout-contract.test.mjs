// Opt in with AK_CLAUDE_CONFORMANCE_BINARY pointing to the installed native
// 2.1.266 binary. Evaluates only a bounded, digest-verified arithmetic function.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const binary = process.env.AK_CLAUDE_CONFORMANCE_BINARY;
test('Claude 2.1.266 native artifact retains seconds and SessionEnd budget semantics', {
  skip: !binary && 'set AK_CLAUDE_CONFORMANCE_BINARY to opt in',
}, () => {
  const bytes = fs.readFileSync(binary);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '553d1b9e9e7068b275c0a783c7e139ff6503096f286e674c8c919379fb0eca62');
  const source = bytes.toString('utf8');
  assert.ok(source.includes('fn=e.timeout?e.timeout*1000:pf,an='));
  assert.ok(source.includes('pf=600000'));
  const start = source.indexOf('function Jfe(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS;');
  assert.ok(start >= 0);
  const end = source.indexOf('}function ', start) + 1;
  const functionSource = source.slice(start, end);
  assert.ok(functionSource.length > 100 && functionSource.length < 1000);
  const minimum = Number(source.match(/Uwn=(\d+)/)[1]);
  const maximum = Number(source.match(/CSs=(\d+)/)[1]);
  const budget = (timeout, override) => vm.runInNewContext(`(${functionSource})()`, {
    a: { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: override },
    Fy: () => false, Ule: () => ({}),
    nZ: () => ({ SessionEnd: [{ hooks: timeout == null ? [] : [{ timeout }] }] }),
    Uwn: minimum, CSs: maximum,
  }, { timeout: 100 });
  assert.equal(budget(undefined), 1500);
  assert.equal(budget(5), 5000);
  assert.equal(budget(5000), 60000);
  assert.equal(budget(5, 7000), 7000);
});
