// sse.mjs — shared Server-Sent-Events transport for the dashboard's two
// long-lived streaming routes (/api/live/events,
// /api/live/transcripts/:host/:id/events).
//
// Owns exactly the backpressure/queue/overflow/heartbeat machinery that used
// to be duplicated ~120 lines apart in dashboard-server.mjs (code-quality
// Finding 4). Route-specific logic — subscribe timing, snapshot/replay
// reconciliation, event shaping — stays in the caller: the two routes'
// sequencing genuinely differs and forcing them into one function would risk
// the carefully-reasoned event-ordering guarantees each route documents.

/**
 * A backpressure-aware SSE writer: buffers frames while the socket is blocked
 * (`res.write` returned false), drops to a caller-supplied overflow frame
 * (never silently truncates) once the buffer exceeds `limit`, and resumes on
 * 'drain'. `cleanup` is idempotent — safe to call from close/error/shutdown
 * paths without tracking whether it already ran.
 * @param {import('node:http').ServerResponse} res
 * @param {{ limit: number, onOverflow: () => (string | Promise<string>), heartbeatMs: number }} options
 */
export function sseChannel(res, { limit, onOverflow, heartbeatMs }) {
  let closed = false;
  let blocked = false;
  let overflowed = false;
  const queue = [];
  let heartbeat = null;

  const write = (frame) => {
    if (closed) return;
    if (blocked) {
      if (queue.length < limit) queue.push(frame);
      else overflowed = true;
      return;
    }
    blocked = !res.write(frame);
  };

  // async so the live route's overflow recovery (fetch a FRESH snapshot before
  // resuming) can await it; the transcript route's onOverflow returns a plain
  // string and `await` on a non-promise just resolves in the same microtask.
  // Deliberately not awaited by the 'drain' listener below — Node does not
  // await event handlers, and the original code had this same shape.
  const flush = async () => {
    if (closed) return;
    blocked = false;
    if (overflowed) {
      overflowed = false;
      queue.length = 0;
      try { write(await onOverflow()); } catch { /* caller's overflow frame is best-effort */ }
    }
    while (!blocked && queue.length) write(queue.shift());
  };
  res.on('drain', flush);

  const startHeartbeat = () => {
    heartbeat = setInterval(() => write(': heartbeat\n\n'), Math.max(100, Number(heartbeatMs) || 15_000));
    heartbeat.unref?.();
  };

  const cleanup = (terminate = false) => {
    if (closed) return;
    closed = true;
    if (heartbeat != null) clearInterval(heartbeat);
    queue.length = 0;
    res.off('drain', flush);
    if (terminate && !res.writableEnded) res.end();
  };

  return { write, startHeartbeat, cleanup, isClosed: () => closed };
}

/**
 * Reserve a client-cap slot BEFORE any await in the caller. Concurrent
 * requests arriving during async setup (dynamic import, service.start(),
 * replay/snapshot) must not all observe the same pre-registration `size` and
 * all pass the cap — that TOCTOU (code-quality Finding 1) is what let the cap
 * become decorative. The reservation is a placeholder identity; swap it for
 * the real cleanup callback once one exists (`clients.delete(slot);
 * clients.add(cleanup)`), and delete it on every early-return path in between.
 * Returns null when the cap is already full.
 */
export function reserveClientSlot(clients, maxClients) {
  if (clients.size >= maxClients) return null;
  const slot = () => {};
  clients.add(slot);
  return slot;
}

/**
 * True once the client has gone away — checked after every await in a route
 * that reserved a slot before that await, so a close during async setup
 * (which fires 'close' before `req.once('close', cleanup)` can even attach)
 * is still noticed instead of leaking the reservation and the subscription
 * that gets wired up after it.
 */
export function clientGone(req, res) {
  return req.destroyed || res.writableEnded || res.destroyed;
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/**
 * Own the reserve-slot / early-close-forwarding / channel-open lifecycle
 * every long-lived SSE route in dashboard-server.mjs used to repeat almost
 * verbatim (three copies — the 2026-08 complexity audit's Finding 1). What
 * genuinely differs per route — opening a service/stream/watch, then its own
 * subscribe/replay/snapshot sequencing, INCLUDING exactly when a connection
 * stops being counted as "just a reservation" and starts being counted as "a
 * real client" (this differs by route: two do it the instant the channel
 * opens, one defers it until its subscribe succeeds) — stays with the
 * caller via `afterOpen`; this owns only the shared scaffolding around it.
 *
 * `setup()` performs the route's own async prep. Two outcomes:
 *   - it already sent its own error response and returns a falsy value —
 *     sseRoute releases the reservation and stops, matching every route's
 *     original `await x() catch { …sendJson…; return; }` shape;
 *   - it returns `{ headers, onOverflow, onClose }` — `headers` merge onto
 *     the shared SSE header set, `onOverflow` feeds sseChannel, and the
 *     optional `onClose` is this route's OWN teardown for a client already
 *     gone by the time setup() resolves (e.g. release an opened transcript).
 *
 * On success, `afterOpen({ channel, write, cleanup, isGone, activate,
 * setOnClose })` runs the route's own sequencing:
 *   - `activate()` swaps the cap reservation for the real per-connection
 *     cleanup, at whatever point this route originally did that swap;
 *   - `setOnClose(fn)` REPLACES the teardown `cleanup`/shutdown runs for the
 *     rest of this connection's life (e.g. once a subscription exists,
 *     cleanup must also unsubscribe) — mirroring how each original route
 *     only assigned its full `realCleanup` once subscribe/watch succeeded.
 */
export async function sseRoute({
  req, res, clients, maxClients, tooManyPayload, limit, heartbeatMs, setup, afterOpen,
}) {
  const slot = reserveClientSlot(clients, maxClients);
  if (!slot) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(tooManyPayload));
    return;
  }

  let earlyClosed = false;
  let realCleanup = null;
  const cleanup = (terminate) => {
    if (realCleanup) { realCleanup(terminate); return; }
    earlyClosed = true;
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
  const isGone = () => earlyClosed || clientGone(req, res);

  const ctx = await setup();
  if (!ctx) { clients.delete(slot); return; }
  if (isGone()) {
    clients.delete(slot);
    await ctx.onClose?.(false);
    return;
  }

  res.writeHead(200, { ...SSE_HEADERS, ...ctx.headers });
  res.flushHeaders?.();

  const channel = sseChannel(res, { limit, heartbeatMs, onOverflow: ctx.onOverflow });
  const write = channel.write;
  let activated = false;

  realCleanup = (terminate = false) => {
    if (channel.isClosed()) return;
    channel.cleanup(terminate);
    clients.delete(activated ? cleanup : slot);
    clients.delete(cleanup);
    ctx.onClose?.(terminate);
  };
  const activate = () => {
    if (activated) return;
    activated = true;
    clients.delete(slot);
    clients.add(cleanup);
  };

  await afterOpen({
    channel, write, cleanup, isGone, activate,
    setOnClose: (fn) => { ctx.onClose = fn; },
  });
}
