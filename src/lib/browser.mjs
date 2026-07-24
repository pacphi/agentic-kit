// browser.mjs — open a URL in the OS default browser, best-effort.
//
// Extracted from x/dashboard.mjs so both the dashboard and admin commands share
// one implementation (ADR-0007 IP-4). Behaviour-preserving: zero-dep spawn of
// the platform opener, never throws — a headless box just gets the printed URL.
import { spawn } from 'node:child_process';

/** Open a URL in the OS default browser, best-effort (never throws). Zero-dep:
 *  macOS `open`, Windows `cmd /c start`, else `xdg-open`. */
export function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser / headless — URL is already printed */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
