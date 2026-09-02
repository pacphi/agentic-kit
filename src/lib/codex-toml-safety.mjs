// Conservative, zero-dependency TOML lexical inspection for Codex config.
// It does not deserialize values. It only identifies live physical lines and
// proves enough document structure for an exact scalar splice to be safe.

const BARE_KEY = '[A-Za-z0-9_-]+';
const BASIC_KEY = '"(?:[^"\\\\]|\\\\.)*"';
const LITERAL_KEY = "'[^']*'";
const KEY = `(?:${BARE_KEY}|${BASIC_KEY}|${LITERAL_KEY})`;
const KEY_PATH = `${KEY}(?:[\\t ]*\\.[\\t ]*${KEY})*`;
const TABLE = new RegExp(`^[\\t ]*\\[[\\t ]*${KEY_PATH}[\\t ]*\\][\\t ]*(?:#[^\\r\\n]*)?$`);
const ARRAY_TABLE = new RegExp(`^[\\t ]*\\[\\[[\\t ]*${KEY_PATH}[\\t ]*\\]\\][\\t ]*(?:#[^\\r\\n]*)?$`);
const ASSIGNMENT = new RegExp(`^[\\t ]*(${KEY_PATH})[\\t ]*=`);

function physicalLines(source) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && source[index] !== '\n') continue;
    let end = index;
    if (end > start && source[end - 1] === '\r') end -= 1;
    lines.push({ start, end: index < source.length ? index + 1 : index, text: source.slice(start, end) });
    start = index + 1;
  }
  return lines;
}

function valueBeforeComment(line, from) {
  let quote = null;
  let escape = false;
  for (let index = from; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (escape) escape = false;
      else if (char === '\\' && quote === '"') escape = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '#' && !quote) return line.slice(from, index).trim();
    if (char === '"' || char === "'") quote = char;
  }
  return line.slice(from).trim();
}

function supportedValue(value) {
  if (/^(?:"|')/.test(value)) return true;
  if (/^(?:\[|\{)/.test(value)) return true;
  if (/^(?:true|false|[+-]?(?:inf|nan))$/.test(value)) return true;
  if (/^[+-]?(?:0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)$/.test(value)) return true;
  return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    || /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(value);
}

function structurallyValid(lines, scanError) {
  if (scanError) return { valid: false, error: scanError };
  for (const line of lines) {
    if (!line.live) continue;
    const trimmed = line.text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      if (!TABLE.test(line.text) && !ARRAY_TABLE.test(line.text)) {
        return { valid: false, error: `unsupported or malformed TOML table at byte ${line.start}` };
      }
      continue;
    }
    const assignment = ASSIGNMENT.exec(line.text);
    if (!assignment) {
      return { valid: false, error: `unsupported or malformed TOML assignment at byte ${line.start}` };
    }
    const value = valueBeforeComment(line.text, assignment[0].length);
    if (!value) {
      return { valid: false, error: `TOML assignment has no value at byte ${line.start}` };
    }
    if (!supportedValue(value)) {
      return { valid: false, error: `unsupported or malformed TOML value at byte ${line.start}` };
    }
  }
  return { valid: true, error: null };
}

function scanBasic(state, source, index, lineStart) {
  const char = source[index];
  if (char === '\n') return { ...state, error: `unterminated basic string at byte ${lineStart}` };
  if (state.escape) {
    let error = null;
    if (!/["\\btnfruU]/.test(char)) error = `invalid basic-string escape at byte ${index}`;
    else if (char === 'u' && !/^[0-9A-Fa-f]{4}/.test(source.slice(index + 1))) {
      error = `invalid unicode escape at byte ${index}`;
    } else if (char === 'U' && !/^[0-9A-Fa-f]{8}/.test(source.slice(index + 1))) {
      error = `invalid unicode escape at byte ${index}`;
    }
    return { ...state, escape: false, error };
  }
  if (char === '\\') return { ...state, escape: true };
  if (char === '"') return { ...state, mode: 'normal' };
  return state;
}

function scanLiteral(state, char, lineStart) {
  if (char === '\n') return { ...state, error: `unterminated literal string at byte ${lineStart}` };
  return char === "'" ? { ...state, mode: 'normal' } : state;
}

function scanMultiBasic(state, source, index) {
  const char = source[index];
  if (state.escape) {
    const error = char !== '\n' && !/["\\btnfruU]/.test(char)
      ? `invalid multiline-string escape at byte ${index}` : null;
    return { ...state, escape: false, error };
  }
  if (char === '\\') return { ...state, escape: true };
  if (source.slice(index, index + 3) === '"""') {
    return { ...state, mode: 'normal', advance: 2 };
  }
  return state;
}

function scanMultiLiteral(state, source, index) {
  return source.slice(index, index + 3) === "'''"
    ? { ...state, mode: 'normal', advance: 2 } : state;
}

function scanNormal(state, source, index) {
  const char = source[index];
  const triple = source.slice(index, index + 3);
  if (triple === '"""') return { ...state, mode: 'multi-basic', advance: 2 };
  if (triple === "'''") return { ...state, mode: 'multi-literal', advance: 2 };
  if (char === '"') return { ...state, mode: 'basic' };
  if (char === "'") return { ...state, mode: 'literal' };
  if (char === '#') return { ...state, mode: 'comment' };
  if (char === '[') return { ...state, square: state.square + 1 };
  if (char === ']') {
    const square = state.square - 1;
    return { ...state, square, error: square < 0 ? `unexpected ] at byte ${index}` : null };
  }
  if (char === '{') return { ...state, curly: state.curly + 1 };
  if (char === '}') {
    const curly = state.curly - 1;
    return { ...state, curly, error: curly < 0 ? `unexpected } at byte ${index}` : null };
  }
  return state;
}

function scanCharacter(state, source, index, lineStart) {
  if (state.mode === 'comment') {
    return source[index] === '\n' ? { ...state, mode: 'normal' } : state;
  }
  if (state.mode === 'basic') return scanBasic(state, source, index, lineStart);
  if (state.mode === 'literal') return scanLiteral(state, source[index], lineStart);
  if (state.mode === 'multi-basic') return scanMultiBasic(state, source, index);
  if (state.mode === 'multi-literal') return scanMultiLiteral(state, source, index);
  return scanNormal(state, source, index);
}

/**
 * Return physical lines that began outside strings, comments, arrays, and
 * inline tables, plus a conservative document-structure verdict.
 */
export function inspectCodexTomlStructure(source) {
  const lines = physicalLines(source);
  let state = { mode: 'normal', square: 0, curly: 0, escape: false, advance: 0, error: null };
  let scanError = null;
  let lineIndex = 0;
  let lineStart = 0;

  const markLine = () => {
    if (lines[lineIndex]) {
      lines[lineIndex].live = state.mode === 'normal' && state.square === 0 && state.curly === 0;
    }
  };
  markLine();

  for (let index = 0; index < source.length && !scanError; index += 1) {
    const char = source[index];
    if (char === '\r' && source[index + 1] !== '\n') {
      scanError = `bare carriage return at byte ${index}`;
      break;
    }
    if ((char < ' ' && !['\t', '\n', '\r'].includes(char)) || char.charCodeAt(0) === 0x7f) {
      scanError = `disallowed control character at byte ${index}`;
      break;
    }
    state = scanCharacter({ ...state, advance: 0, error: null }, source, index, lineStart);
    if (state.error) scanError = state.error;
    index += state.advance;

    if (char === '\n') {
      lineIndex += 1;
      lineStart = index + 1;
      markLine();
    }
  }

  if (!scanError && !['normal', 'comment'].includes(state.mode)) scanError = `unterminated ${state.mode} value`;
  if (!scanError && (state.square !== 0 || state.curly !== 0)) scanError = 'unbalanced TOML array or inline table';
  const structure = structurallyValid(lines, scanError);
  return { ...structure, lines };
}

export const isTomlTableLine = (line) => TABLE.test(line) || ARRAY_TABLE.test(line);
