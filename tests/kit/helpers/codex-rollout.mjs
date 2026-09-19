// Synthetic Codex rollout builders that mirror the REAL wire structure (an
// `ordinal` on every envelope, `session_meta.subagent_history_start_ordinal`,
// `turn_context`, cumulative `token_count`, `external-import-turn-N` ids).
// Pure string builders: nothing here touches ~/.codex, ~/.claude or ~/.config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A cumulative usage snapshot, `gross` input INCLUDING `cached`. */
export function usage({ input = 0, cached = 0, output = 0, reasoning = 0 } = {}) {
  return {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
    output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
  };
}

const sum = (a, b) => usage({
  input: a.input_tokens + b.input_tokens, cached: a.cached_input_tokens + b.cached_input_tokens,
  output: a.output_tokens + b.output_tokens, reasoning: a.reasoning_output_tokens + b.reasoning_output_tokens,
});

/**
 * Builds one rollout line-by-line, stamping the envelope `ordinal` the way the
 * host does. `tokenCount(last)` keeps the running cumulative total for you;
 * `resetTotal()` makes the next snapshot restart from zero (the mid-file
 * counter reset seen on real data).
 */
export class Rollout {
  constructor({ id, ts = '2026-07-24T09:00:00.000Z' } = {}) {
    this.id = id;
    this.lines = [];
    this.ordinal = 0;
    this.ts = ts;
    this.total = usage();
  }

  at(ts) { this.ts = ts; return this; }

  raw(type, payload) {
    this.lines.push(JSON.stringify({ timestamp: this.ts, ordinal: this.ordinal++, type, payload }));
    return this;
  }

  meta(extra = {}) {
    return this.raw('session_meta', { id: this.id, cwd: '/Users/me/proj', thread_source: 'user', ...extra });
  }

  turn(model = 'gpt-5.6', extra = {}) {
    return this.raw('turn_context', { model, cwd: '/Users/me/proj', ...extra });
  }

  taskStarted(turnId = 't1') { return this.raw('event_msg', { type: 'task_started', turn_id: turnId }); }

  user(text = 'do the thing') { return this.raw('event_msg', { type: 'user_message', message: text }); }

  agent(text = 'done') { return this.raw('event_msg', { type: 'agent_message', message: text }); }

  item(type, extra = {}) {
    return this.raw('event_msg', { type: 'item_completed', item: { type, ...extra } });
  }

  /** Append a token_count whose `last` usage is `last`; cumulative advances. */
  tokenCount(last, { window = null } = {}) {
    this.total = sum(this.total, last);
    return this.raw('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: this.total, last_token_usage: last,
        ...(window ? { model_context_window: window } : {}),
      },
    });
  }

  /** The next token_count restarts the cumulative counter from zero. */
  resetTotal() { this.total = usage(); return this; }

  /** Splice another rollout's already-built lines in as replayed history,
   *  re-stamping ordinals so they continue this file's sequence. */
  replay(other) {
    for (const l of other.lines) {
      const o = JSON.parse(l);
      this.lines.push(JSON.stringify({ ...o, ordinal: this.ordinal++, timestamp: this.ts }));
    }
    this.total = other.total;
    return this;
  }

  toString() { return `${this.lines.join('\n')}\n`; }
}

/** A temp sandbox with claude/ and codex/YYYY/MM/DD rollout dirs. */
export function codexSandbox(files, { day = ['2026', '07', '24'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-codex-attr-'));
  const dayDir = path.join(dir, 'codex', ...day);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dayDir, name), String(body));
  return {
    dir,
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
  };
}

export const stubDeps = () => ({
  costOf: () => 1,
  pricesAsOf: '2026-07-01',
  classify: () => ({ category: 'Build', confidence: 0.9, basis: 'stub' }),
  detectInsights: () => [],
});
