import { Linter } from 'eslint';

const labels = /\bTask \d+(?:\.\d+)?[a-z]?\b|\b[Ff]ix round \d|final-review fix|\bBranch \d+[a-z]?\b[^.\n]{0,20}\bTask\b/;
const testNames = new Set(['test', 'it', 'describe', 'suite']);

const modifiers = new Set(['only', 'skip', 'todo', 'concurrent', 'sequential', 'failing']);
const memberName = expression => expression.computed ? expression.property.value : expression.property.name;

// Static contract: known declaration names/modifiers, each(table)(title), and
// first callback parameters of direct declarations (never each table data).
// An unbound `t.test`
// is accepted as the conventional context form; bound receivers must resolve
// to a declaration callback parameter. Runtime aliases are not evaluated.
function isTestContext(receiver, sourceCode) {
  if (receiver.type !== 'Identifier') return false;
  let scope = sourceCode.getScope(receiver);
  while (scope) {
    const variable = scope.set.get(receiver.name);
    if (variable) {
      return variable.defs.some(definition => {
        const fn = definition.node;
        const call = fn.parent;
        return definition.type === 'Parameter' && fn.params[0] === definition.name
          && call?.type === 'CallExpression' && call.arguments.includes(fn)
          && isTestCall(call.callee, sourceCode, false);
      });
    }
    scope = scope.upper;
  }
  return receiver.name === 't';
}

function isTestCall(expression, sourceCode, allowEach = true) {
  if (expression.type === 'Identifier') return testNames.has(expression.name);
  if (expression.type === 'MemberExpression') {
    const name = memberName(expression);
    if (name === 'test') return isTestContext(expression.object, sourceCode);
    return modifiers.has(name) && isTestCall(expression.object, sourceCode, allowEach);
  }
  return allowEach && expression.type === 'CallExpression'
    && expression.callee.type === 'MemberExpression'
    && memberName(expression.callee) === 'each'
    && isTestCall(expression.callee.object, sourceCode);
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
          if (!isTestCall(node.callee, context.sourceCode)) return;
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
