// admin-collect.mjs — the server-side stats fan-out for `ak x admin`.
//
// Resolves a GitHub credential (env → `gh auth token`), then fires ONE Promise.all
// of GitHub + npm reads and assembles the typed /api/admin-stats payload
// (ADR-0007 §0, pseudocode §3). Every sub-fetch is internally try/caught so no
// single failure rejects the batch (EC-3) and no failure removes a sibling key.
//
// The credential is read at runtime, kept local, and NEVER placed in the payload
// (NFR-3). Fetchers are injectable (fetchImpl / execFileImpl) so tests run
// network-free (NFR-6).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ── GitHub credential resolution (FR-4, EC-7) ─────────────────────────────────

/** GITHUB_TOKEN → GH_TOKEN → `gh auth token`. Best-effort: an absent/logged-out
 *  `gh` must not crash or prompt — it falls through to the empty (unconfigured)
 *  result, which degrades the traffic panels honestly (AC-2). `execFileImpl` is
 *  injectable for tests. */
export async function resolveGhToken(env = process.env, execFileImpl = execFileP) {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: 'GH_TOKEN' };
  try {
    const { stdout } = await execFileImpl('gh', ['auth', 'token'], { timeout: 5000, env });
    const t = String(stdout || '').trim();     // arg vector, no shell — no injection surface
    if (t) return { token: t, source: 'gh auth token' };
  } catch { /* gh missing / not logged in — no prompt, no throw */ }
  return { token: '', source: null };
}

// ── repository.url → owner/repo (EC-8) ────────────────────────────────────────

/** Parse a GitHub "owner/repo" slug from a package.json repository.url. Handles
 *  git+https, ssh, scp-shorthand, and bare https shapes. Returns null on anything
 *  unparseable — the caller (startAdmin) then refuses to start rather than query
 *  the wrong repository (fail-closed). */
export function parseRepoSlug(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let s = rawUrl.trim();
  if (s.startsWith('git+')) s = s.slice(4);
  if (s.endsWith('.git')) s = s.slice(0, -4);
  let pathPart;
  const scp = s.match(/^[^@/]+@[^:/]+:(.+)$/); // git@github.com:owner/repo
  if (scp) {
    pathPart = scp[1];
  } else {
    try { pathPart = new URL(s).pathname; } catch { return null; }
  }
  const parts = pathPart.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] && parts[1]) return parts[0] + '/' + parts[1];
  return null;
}

// ── fetch helpers (injectable — NFR-6) ────────────────────────────────────────

/** One GitHub GET → parsed JSON, or null on any non-2xx / network error (EC-3,
 *  EC-4). Never throws — the collector depends on that to keep Promise.all whole. */
async function ghJson(fetchImpl, path, token) {
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'agentic-kit-admin' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetchImpl('https://api.github.com' + path, { headers });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** npm last-month daily range → object, or null on 404 / network failure (EC-2).
 *  Scoped names are percent-encoded so `@scope/name` becomes `%40scope%2Fname`. */
async function npmRange(fetchImpl, pkg) {
  try {
    const url = 'https://api.npmjs.org/downloads/range/last-month/' + encodeURIComponent(pkg);
    const r = await fetchImpl(url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ── the fan-out (FR-2, AC-2/3) ────────────────────────────────────────────────

/** Fan out to GitHub + npm and assemble the typed payload. `fetchImpl` and
 *  `ghToken` are injected; the credential never leaves this scope. */
export async function collectAdminStats({ fetchImpl = fetch, ghToken = '', repoSlug, npmPkg }) {
  const owner = repoSlug.split('/')[0];
  const configured = Boolean(ghToken);
  const gh = (path) => ghJson(fetchImpl, path, ghToken);

  // Single Promise.all. Auth-gated calls resolve to null when unconfigured so we
  // never issue a doomed request; each fetch is internally try/caught (EC-3).
  const [repoRaw, releasesRaw, clonesRaw, viewsRaw, referrersRaw, npmRaw, issuesRaw, starsRaw, forksRaw] = await Promise.all([
    gh('/repos/' + repoSlug),
    gh('/repos/' + repoSlug + '/releases?per_page=20'),
    configured ? gh('/repos/' + repoSlug + '/traffic/clones') : null,
    configured ? gh('/repos/' + repoSlug + '/traffic/views') : null,
    configured ? gh('/repos/' + repoSlug + '/traffic/popular/referrers') : null,
    npmRange(fetchImpl, npmPkg),
    gh('/repos/' + repoSlug + '/issues?state=all&per_page=100&sort=created&direction=desc'),
    gh('/repos/' + repoSlug + '/stargazers?per_page=100'),
    gh('/repos/' + repoSlug + '/forks?per_page=100&sort=newest'),
  ]);

  const releases = mapReleases(releasesRaw);
  return {
    generatedAt: new Date().toISOString(),
    repoSlug,
    repo: repoRaw
      ? { stars: repoRaw.stargazers_count, forks: repoRaw.forks_count, watchers: repoRaw.subscribers_count, openIssues: repoRaw.open_issues_count }
      : null,
    releases,
    totalAssetDownloads: sumAssetDownloads(releases),
    traffic: {
      configured,
      note: configured ? null
        : 'No GitHub credential resolved (GITHUB_TOKEN / GH_TOKEN / `gh auth token`). '
          + 'Clones, views, and referrers need push access — those panels stay dark, not zero.',
      clones: clonesRaw ? { count: clonesRaw.count, uniques: clonesRaw.uniques, daily: clonesRaw.clones || [] } : null,
      views: viewsRaw ? { count: viewsRaw.count, uniques: viewsRaw.uniques, daily: viewsRaw.views || [] } : null,
      referrers: Array.isArray(referrersRaw)
        ? referrersRaw.map((x) => ({ referrer: x.referrer, count: x.count, uniques: x.uniques })) : null,
    },
    npm: npmToBlock(npmRaw),
    people: buildPeople(issuesRaw, starsRaw, forksRaw, owner),
    feedback: doors(repoSlug),
  };
}

/** The collector the server runs when none is injected: resolve the credential,
 *  then fan out. `resolveToken`/`fetchImpl` are injectable. On any thrown error it
 *  returns a still-valid, honestly-degraded payload (never an error page).
 *  @param {{ repoSlug: string, npmPkg?: string, fetchImpl?: typeof fetch,
 *            resolveToken?: () => Promise<{ token: string }> }} o */
export function defaultCollect({ repoSlug, npmPkg, fetchImpl = fetch, resolveToken = resolveGhToken }) {
  return async () => {
    try {
      const { token } = await resolveToken();
      return await collectAdminStats({ fetchImpl, ghToken: token, repoSlug, npmPkg });
    } catch (e) {
      return {
        generatedAt: new Date().toISOString(), repoSlug, repo: null, releases: [], totalAssetDownloads: 0,
        traffic: { configured: false, note: String((e && e.message) || e), clones: null, views: null, referrers: null },
        npm: null, people: emptyPeople(), feedback: doors(repoSlug), error: String((e && e.message) || e),
      };
    }
  };
}

// ── payload shapers (server-side; not embedded in the page) ───────────────────

const slice10 = (s) => String(s || '').slice(0, 10);

/** Group issues+PRs by EXTERNAL author (owner excluded), plus stargazer + fork
 *  logins (owner excluded). An empty stargazer list while stars>0 is a credential
 *  gap the client narrates (EC-4) — the collector faithfully returns [] here. */
function buildPeople(issuesRaw, starsRaw, forksRaw, owner) {
  const issues = Array.isArray(issuesRaw) ? issuesRaw : [];
  const byAuthor = new Map();
  for (const it of issues) {
    const login = it.user && it.user.login;
    if (!login || login === owner) continue; // exclude the owner's own threads
    const isPR = Boolean(it.pull_request);
    const e = byAuthor.get(login) || { login, issues: 0, prs: 0, association: 'NONE', items: [] };
    if (isPR) e.prs++; else e.issues++;
    if (/CONTRIBUTOR|MEMBER|COLLABORATOR/.test(it.author_association || '')) e.association = it.author_association;
    e.items.push({ number: it.number, title: it.title, state: it.state, isPR, url: it.html_url, at: slice10(it.created_at) });
    byAuthor.set(login, e);
  }
  const contributors = [...byAuthor.values()].sort((a, b) => (b.issues + b.prs) - (a.issues + a.prs));
  const stargazers = (Array.isArray(starsRaw) ? starsRaw : []).map((s) => s.login).filter((l) => l && l !== owner);
  const forks = (Array.isArray(forksRaw) ? forksRaw : [])
    .map((f) => ({ login: f.owner && f.owner.login, at: slice10(f.created_at) }))
    .filter((f) => f.login && f.login !== owner);
  const engagers = new Set([...contributors.map((c) => c.login), ...stargazers, ...forks.map((f) => f.login)]);
  return {
    externalEngagers: engagers.size,
    totalIssues: issues.filter((i) => !i.pull_request).length,
    totalPRs: issues.filter((i) => i.pull_request).length,
    contributors, stargazers, forks,
  };
}

/** An empty People, used by the fail-soft path in defaultCollect. */
function emptyPeople() {
  return { externalEngagers: 0, totalIssues: 0, totalPRs: 0, contributors: [], stargazers: [], forks: [] };
}

/** Releases → {tag,name,publishedAt,assets[]}. No releases → [] (never null), so
 *  the client's newest-release tile reads "unknown", not a fabricated 0 (EC-1). */
function mapReleases(releasesRaw) {
  if (!Array.isArray(releasesRaw)) return [];
  return releasesRaw.map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    publishedAt: r.published_at,
    assets: (r.assets || []).map((a) => ({ name: a.name, downloads: a.download_count || 0, sizeMB: Math.round((a.size || 0) / 1048576) })),
  }));
}

/** Σ asset downloads. 0 ONLY when releases exist and truly sum to 0; "no
 *  releases" is releases===[] → the client tile reads unknown, not 0 (EC-1). */
function sumAssetDownloads(releases) {
  return releases.reduce((sum, r) => sum + r.assets.reduce((s, a) => s + a.downloads, 0), 0);
}

/** npm range → {lastWeek,lastMonth,daily}, or null on 404 / network (EC-2). */
function npmToBlock(npmRaw) {
  if (!npmRaw) return null;
  const daily = Array.isArray(npmRaw.downloads) ? npmRaw.downloads : [];
  return {
    lastWeek: daily.slice(-7).reduce((a, d) => a + d.downloads, 0),
    lastMonth: daily.reduce((a, d) => a + d.downloads, 0),
    daily, // full month, oldest-first, for the sparkline
  };
}

/** The two "doors" — issues + discussions URLs — built from the slug, never the
 *  network. */
function doors(repoSlug) {
  return {
    issues: 'https://github.com/' + repoSlug + '/issues',
    discussions: 'https://github.com/' + repoSlug + '/discussions',
  };
}
