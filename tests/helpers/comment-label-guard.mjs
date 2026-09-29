import { Linter } from 'eslint';

const labels = /\bTask \d+(?:\.\d+)?[a-z]?\b|\b[Ff]ix round \d|final-review fix|\bBranch \d+[a-z]?\b[^.\n]{0,20}\bTask\b/;
const testNames = new Set(['test', 'it', 'describe', 'suite']);

function isTestCall(expression) {
  if (expression.type === 'Identifier') return testNames.has(expression.name);
  if (expression.type === 'MemberExpression') {
    const name = expression.computed ? expression.property.value : expression.property.name;
    return testNames.has(name) || isTestCall(expression.object);
  }
  return expression.type === 'CallExpression' && isTestCall(expression.callee);
}

/** Parse real comments and static test titles through the existing lint parser.
 * Strings, regex literals and template raw text stay opaque; syntax errors fail
 * closed rather than quietly exempting malformed source from the guard.
 */
export function inspectCommentLabels(source, file = 'fixture.mjs') {
  const findings = [];
  const add = (text, node, kind) => {
    const match = labels.exec(text);
    if (match) findings.push({
      line: node.loc.start.line + text.slice(0, match.index).split('\n').length - 1,
      kind, text: text.trim(), start: node.range[0], end: node.range[1],
    });
  };
  const rule = {
    create(context) {
      return {
        Program() {
          for (const comment of context.sourceCode.getAllComments()) add(comment.value, comment, 'comment');
        },
        CallExpression(node) {
          if (!isTestCall(node.callee)) return;
          const title = node.arguments[0];
          if (title?.type === 'Literal' && typeof title.value === 'string') add(title.value, title, 'test title');
          if (title?.type === 'TemplateLiteral') {
            for (const part of title.quasis) add(part.value.cooked ?? part.value.raw, part, 'test title');
          }
        },
      };
    },
  };
  const messages = new Linter().verify(source, [{
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: file.endsWith('.cjs') ? 'commonjs' : 'module' },
    plugins: { labels: { rules: { references: rule } } },
    rules: { 'labels/references': 'error' },
  }], { filename: file, allowInlineConfig: false, reportUnusedDisableDirectives: false });
  if (messages.length) throw new Error(`Cannot parse ${file}: ${messages.map(message => `${message.line}:${message.message}`).join('; ')}`);
  return findings.sort((a, b) => a.start - b.start);
}
