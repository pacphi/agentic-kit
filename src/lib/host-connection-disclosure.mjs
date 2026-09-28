// The one sentence shown before a paid host connection check is ever sent
// (ADR-0053): the dashboard's host-health dialog and `ak host
// check-connection` render this exact string. A tiny module on purpose —
// neither surface needs the host-readiness stack just to show one string.
export const CONNECTION_CHECK_DISCLOSURE = 'Sends one short request using your selected host and provider. Normal provider billing and native context usage apply. Native startup may initialize dependencies and update local cache or session files. Agent tools are restricted; this check does not repair your setup.';
