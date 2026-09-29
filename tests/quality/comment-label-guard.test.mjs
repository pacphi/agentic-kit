import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectCommentLabels } from '../helpers/comment-label-guard.mjs';
import { spawnEnv } from '../kit/helpers/home-sandbox.mjs';
import { tempDir } from '../kit/helpers/temp-dir.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('finds transient labels in all comment positions and reports their lines', () => {
  const source = '// Task 1\nfunction f() { /* Fix round 2 */ }\nconst x = 1; // final-review fix\n/* Branch 6a shared Task */\n';
  assert.deepEqual(inspectCommentLabels(source).map(({ line, kind }) => [line, kind]),
    [[1, 'comment'], [2, 'comment'], [3, 'comment'], [4, 'comment']]);
});

test('finds ordinary and member test titles including template segments', () => {
  for (const callee of ['test', 'it', 'describe', 'suite', 'test.skip', 'describe.only', 't.test', "test['todo']", 'test.only.each([])']) {
    assert.equal(inspectCommentLabels(`${callee}('Task 2.3a: behavior', () => {});`).length, 1, callee);
  }
  assert.equal(inspectCommentLabels('test(`Fix round 3`, () => {});').length, 1);
  assert.equal(inspectCommentLabels('test(`Task 3: ${value}`, () => {});').length, 1);
});

test('ignores ordinary member calls and parameterized test data', () => {
  for (const source of [
    '/Task/.test("Task 1");',
    'const pattern = /Task/; pattern.test("Task 1");',
    'const t = /Task/; t.test("Task 1");',
    'test.log("Task 1");',
    'describe.toString("Task 1");',
    'other.test("Task 1");',
    'test.each("Task 1")("ordinary title", () => {});',
  ]) assert.deepEqual(inspectCommentLabels(source), [], source);
});

test('parameterized callback arguments are table data, not Node contexts', () => {
  for (const api of ['test.each', 'test.only.each', "test['each']"]) {
    assert.deepEqual(inspectCommentLabels(`${api}([/Task/])('matches text', (pattern) => pattern.test('Task 1'));`), [], api);
    const findings = inspectCommentLabels(`${api}([/Task/])('Task 2: matches text', (t) => t.test('Task 1'));`);
    assert.equal(findings.length, 1, api);
    assert.equal(findings[0].text, 'Task 2: matches text');
  }
  assert.equal(inspectCommentLabels('test.each([1])("row", () => { test("outer", (context) => context.test("Task 1", () => {})); });').length, 1);
});

test('recognizes lexically declared nested Node test contexts', () => {
  assert.equal(inspectCommentLabels('test("outer", async (context) => { await context.test("Task 1", async (child) => { await child.test("Task 2", () => {}); }); });').length, 2);
  assert.deepEqual(inspectCommentLabels('other("outer", (context) => { context.test("Task 1"); });'), []);
});

test('ignores strings, URLs, regular expressions, template text and durable audit IDs', () => {
  const source = String.raw`
const url = 'https://example.test/Task 1';
const text = "// Task 2";
const pattern = /\/\/ Task 3/;
const template = \`/* Task 4 */ \${'// Task 5'}\`;
// B3-D2 / B5-D1 / ADR-0063 / agentic-qe#759
other('Task 6');
`.replaceAll('\\`', '`').replaceAll('\\${', '${');
  assert.deepEqual(inspectCommentLabels(source), []);
});

test('finds comments inside template expressions without flagging raw segments', () => {
  assert.equal(inspectCommentLabels('const x = `Task 1 ${ /* Task 2 */ 1 } // Task 3`;').length, 1);
});

test('handles JSDoc, empty files with comments, CRLF, division and regex boundaries', () => {
  assert.equal(inspectCommentLabels('/** Task 1 */\r\nconst x = /Task 2/.test("x") / 2; // Task 3').length, 2);
  assert.equal(inspectCommentLabels('/* Task 1 */').length, 1);
  assert.equal(inspectCommentLabels('function f() {} /* Task 1 */').length, 1);
});

test('rejects malformed JavaScript rather than silently overlooking labels', () => {
  assert.throws(() => inspectCommentLabels('const x = "unterminated'), /Cannot parse/);
});

test('inline lint directives cannot suppress inspection', () => {
  assert.equal(inspectCommentLabels('/* eslint-disable */\n// Task 1').length, 1);
  assert.equal(inspectCommentLabels('/* eslint-disable labels/references */\ntest("Task 2", () => {});').length, 1);
});

test('parses CommonJS return and module imports using the matching source mode', () => {
  assert.equal(inspectCommentLabels('return; // Task 1', 'fixture.cjs').length, 1);
  assert.equal(inspectCommentLabels('import x from "x"; // Task 1', 'fixture.mjs').length, 1);
  assert.throws(() => inspectCommentLabels('return;', 'fixture.mjs'), /Cannot parse/);
});

test('tracked JavaScript comments and test titles use durable references', (t) => {
  const home = tempDir('ak-comment-label-git', t);
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'scripts', 'bin', 'tests'], {
    cwd: root, encoding: 'utf8', env: spawnEnv(home),
  })
    .split('\0').filter(file => /\.(?:mjs|cjs|js)$/.test(file));
  assert.ok(files.length > 0);
  const findings = files.flatMap(file => inspectCommentLabels(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), file)
    .map(hit => `${file}:${hit.line}: ${hit.kind}: ${hit.text}`));
  assert.deepEqual(findings, []);
});
