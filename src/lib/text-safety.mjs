// text-safety.mjs — ONE definition of the character classes that must never
// survive into a terminal, a store, or the DOM. Three unrelated layers need
// the same answer (output.mjs renders to a TTY, usage-label-store.mjs and
// usage-outcome-ledger.mjs guard data at rest, the dashboard's `esc` guards
// the DOM), and a regex copied into three places is a regex that drifts.
//
// WHY THIS EXISTS (security review SEC-2, HIGH). The only text invariants the
// stores held were "no CR/LF" and "at most 48 chars". ESC, BEL, NUL and
// backspace all passed, and the print helpers interpolated them straight into
// console.log. The review demonstrated, by running it: a fabricated red
// "ak: SECURITY ALERT - run curl ... | sh" banner painted over a CLEARED
// screen (ED + CUP), text concealed from view but not from the copy buffer
// (SGR 8), an OSC-0 window-title rewrite, and an OSC-52 clipboard write that
// fits inside the 48-character label-name budget. Every one of those
// observations was captured with stdout redirected to a FILE — the bytes are
// in the file and fire when it is later `cat`'d, so "only a TTY is affected"
// was never true.
//
// TWO POSTURES, deliberately different:
//   - AT REST the stores REJECT (drop the whole entry). A store that holds one
//     of these bytes is already a store whose invariant is broken, and
//     silently rewriting an operator-visible name is its own dishonesty.
//   - AT RENDER output.mjs and the dashboard's `esc` STRIP. A renderer has no
//     entry to drop; it has one string and must print something safe. This is
//     defense in depth, and it is not redundant: `--deep` prints raw
//     transcript text that no store gate ever sees.
//
// Bidi is included because U+202E reverses the rest of a line, so a row can be
// made to read as a different label than the one it is — spoofing, not
// execution, which is why the review ranked it LOW (SEC-9) and why it is
// nonetheless closed here rather than left as a known-good-looking lie.

/** The unsafe codepoint ranges, written as NUMBERS so this file stays free of
 *  the very bytes it exists to reject — a source file carrying a raw ESC is
 *  unreviewable in a diff, and an editor that helpfully normalizes one away
 *  would silently widen what this module lets through.
 *
 *  - 0x00–0x08, 0x0b–0x1f: C0 controls, keeping only TAB (0x09) and LF (0x0a).
 *    CR (0x0d) is deliberately NOT kept: a carriage return rewrites the line
 *    already printed, which is the same overwrite primitive the demonstrated
 *    banner used, and no message here needs one (interpolated child output
 *    carrying CR LF simply becomes LF).
 *  - 0x7f–0x9f: DEL plus the whole C1 range. The review's own regex named only
 *    U+009B (CSI); the range is taken whole because every codepoint in it is a
 *    control and none of them is legitimate prose.
 *  - 0x200b–0x200f, 0x202a–0x202e, 0x2066–0x2069: zero-width and directional
 *    marks, bidi overrides/embeddings, and bidi isolates.
 *  - 0x2028-0x2029: LINE SEPARATOR and PARAGRAPH SEPARATOR. Added in the
 *    re-verification round (security seat, alongside SEC-16): every
 *    single-line check in this codebase tests for CR/LF, which these two pass,
 *    so a Unicode line separator could sit inside a stored label name. Inert
 *    in a terminal and in HTML, but "single-line" should mean single-line.
 *
 *  EXPORTED because five hand-written copies of this list exist and cannot
 *  import it: every function in the dashboard's client modules is
 *  re-serialized into the browser bundle by its own source text, so each
 *  carries its own copy. `tests/kit/text-safety.test.mjs` asserts every copy
 *  against this array, and that test is the only thing standing between five
 *  copies and five different answers. */
export const UNSAFE_RANGES = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f],
  [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069],
];

const UNSAFE_CLASS = `[${UNSAFE_RANGES
  .map(([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`)
  .join('')}]`;

const UNSAFE_ONE_RE = new RegExp(UNSAFE_CLASS);
const UNSAFE_GLOBAL_RE = new RegExp(UNSAFE_CLASS, 'g');


/**
 * Does this value carry a character no store entry may hold? The rejection
 * half of the posture above — callers DROP the entry rather than repair it.
 *
 * @param {unknown} value
 * @returns {boolean} true when `value` is a string carrying such a character
 */
export function hasUnsafeChars(value) {
  return typeof value === 'string' && UNSAFE_ONE_RE.test(value);
}

/**
 * Remove every such character. The render half of the posture above.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripUnsafeChars(value) {
  return String(value ?? '').replace(UNSAFE_GLOBAL_RE, '');
}
