// Minimal JSON location parser for byte-preserving numeric replacements. The
// native JSON parser proves semantics; this parser adds exact source spans so a
// remediation can change one approved scalar without reformatting other bytes.

function pointerPart(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function syntax(message, index) {
  throw new SyntaxError(`${message} at JSON offset ${index}`);
}

function numberSpans(text) {
  let index = 0;
  const spans = new Map();
  const whitespace = () => { while (/\s/.test(text[index] ?? '')) index += 1; };

  function stringValue() {
    if (text[index] !== '"') syntax('expected string', index);
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character < ' ') syntax('control character in string', index);
      index += 1;
    }
    syntax('unterminated string', start);
  }

  function value(pointer) {
    whitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      whitespace();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const key = stringValue();
        whitespace();
        if (text[index] !== ':') syntax('expected colon', index);
        index += 1;
        value(`${pointer}/${pointerPart(key)}`);
        whitespace();
        if (text[index] === '}') { index += 1; return; }
        if (text[index] !== ',') syntax('expected object comma', index);
        index += 1;
      }
      syntax('unterminated object', index);
    }
    if (character === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      let item = 0;
      while (index < text.length) {
        value(`${pointer}/${item}`);
        item += 1;
        whitespace();
        if (text[index] === ']') { index += 1; return; }
        if (text[index] !== ',') syntax('expected array comma', index);
        index += 1;
      }
      syntax('unterminated array', index);
    }
    if (character === '"') { stringValue(); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) { index += literal.length; return; }
    }
    const start = index;
    const token = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (!token) syntax('expected JSON value', index);
    index += token.length;
    spans.set(pointer, { start, end: index, value: Number(token) });
  }

  value('');
  whitespace();
  if (index !== text.length) syntax('unexpected trailing content', index);
  return spans;
}

/**
 * @param {Buffer} bytes
 * @param {{pointer:string,before:number,after:number}[]} replacements
 */
export function replaceJsonNumbers(bytes, replacements) {
  const text = bytes.toString('utf8');
  const spans = numberSpans(text);
  const edits = replacements.map((replacement) => {
    const span = spans.get(replacement.pointer);
    if (!span || span.value !== replacement.before) {
      throw new Error(`JSON numeric preimage changed at ${replacement.pointer}`);
    }
    if (!Number.isFinite(replacement.after)) throw new TypeError('JSON replacement must be finite');
    return {
      start: Buffer.byteLength(text.slice(0, span.start)),
      end: Buffer.byteLength(text.slice(0, span.end)),
      bytes: Buffer.from(String(replacement.after)),
    };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i += 1) {
    if (edits[i].start < edits[i - 1].end) throw new Error('overlapping JSON replacements');
  }
  const chunks = [];
  let cursor = 0;
  for (const edit of edits) {
    chunks.push(bytes.subarray(cursor, edit.start), edit.bytes);
    cursor = edit.end;
  }
  chunks.push(bytes.subarray(cursor));
  return Buffer.concat(chunks);
}
