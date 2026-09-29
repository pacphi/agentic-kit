import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectCommentLabels } from '../helpers/comment-label-guard.mjs';

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

test('tracked JavaScript comments and test titles use durable references', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'scripts', 'bin', 'tests'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => /\.(?:mjs|cjs|js)$/.test(file));
  assert.ok(files.length > 0);
  const findings = files.flatMap(file => inspectCommentLabels(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), file)
    .map(hit => `${file}:${hit.line}: ${hit.kind}: ${hit.text}`));
  assert.deepEqual(findings, []);
});
