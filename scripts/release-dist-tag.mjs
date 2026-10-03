// Which npm dist-tag a version publishes to. The release workflow calls this so the choice is testable:
// betas go to `beta` (older installs follow `next` and `latest`, so they never update into the
// project-scoped line), other prereleases to `next`, stable releases to `latest`.
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BETA = /^beta(?:\.|$)/;

export function distTag(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`${JSON.stringify(version)} is not a semantic version`);
  const prerelease = version.split('+')[0].split('-').slice(1).join('-');
  if (!prerelease) return 'latest';
  return BETA.test(prerelease) ? 'beta' : 'next';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${distTag(process.argv[2])}\n`); } catch (error) { console.error(error.message); process.exit(1); }
}
