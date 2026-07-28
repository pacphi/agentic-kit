/**
 * Validate the browser-facing HTTP boundary for the loopback dashboard.
 * Returns the response body for a rejected request, or null when allowed.
 *
 * The socket binding alone does not prevent DNS rebinding, and a cross-site
 * browser GET can still trigger expensive local work even when SOP prevents
 * the attacker from reading the response.
 */
export function requestRejection(headers = {}) {
  const host = String(headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    return 'forbidden (unexpected Host)';
  }

  const fetchSite = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return 'forbidden (cross-site request)';
  }

  const origin = String(headers.origin || '').toLowerCase();
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return 'forbidden (foreign Origin)';
    }
    // This server is plain HTTP and same-origin browser traffic necessarily
    // carries the exact Host (including the ephemeral port). Merely accepting
    // any loopback origin would allow another local web app to trigger work.
    if (parsed.protocol !== 'http:' || parsed.host !== host) {
      return 'forbidden (foreign Origin)';
    }
  }

  return null;
}
