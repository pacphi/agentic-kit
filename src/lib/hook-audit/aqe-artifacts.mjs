// Content-bound compatibility migration for the reviewed AQE 3.14.1 artifacts.
// Version labels and generated banners alone never establish ownership.
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile, sha256, stableJson } from './common.mjs';

const templateRoot = new URL('../../templates/aqe-lifecycle/', import.meta.url);
const profiles = [
  { name: 'aqe-hook.cjs', directory: 'hooks', digests: ['ece4b5d16bf66bc1e2ca0fc92f250283d17471650bf3e6525884b16b629a80f2'], code: 'aqe-stale-lifecycle-runner' },
  { name: 'brain-checkpoint.cjs', directory: 'helpers', digests: ['d3ad855092bfce36955791fb140bbeab0eab97e92dc8a169b05b6bf3658aab54', 'a9275829b95bed1a10a19a093806bd57cea9d6bdad1795d3c698abe35d710dca'], code: 'aqe-destructive-checkpoint-helper' },
];
const legacyHandlers = JSON.parse(fs.readFileSync(new URL('legacy-handlers.json', templateRoot), 'utf8'));

export function aqeArtifactCandidate(source) {
  const profile = profiles.find((item) => item.digests.includes(source.digest)
    && path.basename(source.file) === item.name);
  return profile ? fs.readFileSync(new URL(profile.name, templateRoot)) : null;
}

export function auditAqeArtifacts(projectRoots) {
  const sources = [];
  const plan = [];
  for (const root of [...new Set(projectRoots.map((item) => path.resolve(item)))]) {
    for (const profile of profiles) {
      const file = path.join(root, '.claude', profile.directory, profile.name);
      const read = readBoundedFile(file, root);
      if (read.status === 'absent') continue;
      const candidate = fs.readFileSync(new URL(profile.name, templateRoot));
      const recognized = profile.digests.includes(read.digest);
      const fixed = read.digest === sha256(candidate);
      sources.push({ file, baseDir: root, kind: 'aqe-generated-artifact', authority: 'project-owner',
        generatedStatus: recognized || fixed ? 'generated' : 'unknown', status: read.status,
        digest: read.digest, error: read.error });
      if (fixed) continue;
      plan.push({ id: `aqe-artifact-${sha256(file).slice(0, 16)}`, host: 'claude',
        target: file, diagnostic: recognized ? profile.code : 'aqe-artifact-provenance-unverified',
        classification: recognized ? 'approval-required' : 'never-automatic',
        reason: recognized ? 'Reviewed full-file preimage permits a backed-up project compatibility migration; upstream cache remains untouched'
          : 'Artifact differs from reviewed preimages; preserve user modifications and inspect manually' });
    }
  }
  return { sources, plan };
}

export function migrateAqeTimeouts(document) {
  const result = structuredClone(document);
  const pointers = [];
  for (const [event, groups] of Object.entries(result.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const [gi, group] of groups.entries()) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const [hi, hook] of group.hooks.entries()) {
        const signature = { event, matcher: group.matcher ?? '', hook };
        if (!legacyHandlers.some((item) => stableJson(item) === stableJson(signature))) continue;
        // Match released host seconds; the runner uses 2500/4500ms internally.
        hook.timeout /= 1000;
        pointers.push(`/hooks/${event}/${gi}/hooks/${hi}/timeout`);
      }
    }
  }
  return { document: result, pointers };
}
