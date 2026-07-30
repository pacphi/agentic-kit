// Explicit provider-account analytics refresh + offline cache status.
import { heading, info, ok, warn, dim } from '../lib/output.mjs';
import {
  openRouterActivityFile,
  readOpenRouterActivity,
  refreshOpenRouterActivity,
} from '../lib/usage-openrouter.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
};

export const help = `ak usage — provider account analytics cache

The local transcript scorecard remains automatic and offline in \`ak dashboard\`.
This command manages separately fetched provider-account metadata. Provider
analytics are never merged into transcript-derived sessions, host totals,
projects, or task attribution.

Usage:
  ak usage status
  ak usage refresh openrouter

Environment:
  OPENROUTER_MANAGEMENT_KEY   required only for refresh; an inference key is
                              intentionally not accepted

Options:
  --json      emit machine-readable cache status/result
  --dry-run   describe an OpenRouter refresh without network or writes

Examples:
  ak usage status                  inspect the offline cache; no network
  ak usage refresh openrouter      explicitly fetch the last 30 completed UTC days
  ak usage status --json           print the normalized credential-free cache`;

function summary(value) {
  if (!value) return null;
  return {
    provider: value.provider,
    source: value.source,
    fetchedAt: value.fetchedAt,
    coverage: value.coverage,
    totals: value.totals,
    models: value.byModel?.length ?? 0,
    upstreamProviders: value.byProvider?.length ?? 0,
  };
}

/**
 * @param {{ flags: Record<string, any>, positionals: string[],
 *           deps?: { cacheFile?: string, read?: typeof readOpenRouterActivity,
 *                    refresh?: typeof refreshOpenRouterActivity } }} input
 */
export async function run({ flags, positionals, deps = {} }) {
  const action = positionals[0] ?? 'status';
  const provider = positionals[1];
  const cacheFile = deps.cacheFile ?? openRouterActivityFile();
  const read = deps.read ?? readOpenRouterActivity;
  const refresh = deps.refresh ?? refreshOpenRouterActivity;

  if (action === 'status' && provider === undefined) {
    const value = read({ cacheFile });
    if (flags.json) {
      console.log(JSON.stringify({ cacheFile, openrouter: value }, null, 2));
      return 0;
    }
    heading('ak usage — offline provider analytics');
    if (!value) {
      info('OpenRouter: no local activity cache.');
      info('Refresh explicitly: ak usage refresh openrouter');
      return 0;
    }
    const t = value.totals;
    ok(`OpenRouter cache: ${value.fetchedAt}`);
    info(`${t.requests} requests · ${t.promptTokens + t.completionTokens} tokens · `
      + `${value.byModel.length} model(s) · ${value.byProvider.length} upstream provider(s)`);
    info(dim('account-level only · never merged into local session or host totals'));
    return 0;
  }

  if (action === 'refresh' && provider === 'openrouter' && positionals.length === 2) {
    if (flags['dry-run']) {
      const plan = {
        dryRun: true,
        action: 'refresh',
        provider: 'openrouter',
        cacheFile,
        network: false,
        writes: false,
      };
      if (flags.json) console.log(JSON.stringify(plan, null, 2));
      else {
        heading('ak usage — refresh plan (dry-run)');
        info('Would fetch OpenRouter account activity with OPENROUTER_MANAGEMENT_KEY.');
        info(`Would replace the private normalized cache: ${cacheFile}`);
        info(dim('No network request or file write was performed.'));
      }
      return 0;
    }
    try {
      const value = await refresh({ cacheFile });
      if (flags.json) {
        console.log(JSON.stringify({ cacheFile, openrouter: value }, null, 2));
        return 0;
      }
      const s = summary(value);
      ok(`OpenRouter activity cached: ${s.totals.requests} requests · ${s.models} model(s)`);
      info(`${s.coverage.from ?? 'no activity'} → ${s.coverage.through ?? 'no activity'} `
        + dim('· completed UTC days only'));
      info(dim('cache contains no key, endpoint id, user id, session id, project, or prompt data'));
      return 0;
    } catch (error) {
      if (flags.json) {
        console.log(JSON.stringify({ cacheFile, error: String(error?.message ?? error) }, null, 2));
      } else {
        warn(String(error?.message ?? error));
      }
      return 1;
    }
  }

  warn('usage: ak usage status | ak usage refresh openrouter');
  return 2;
}
