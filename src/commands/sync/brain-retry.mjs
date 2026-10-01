/** One-shot Brain retry policy, validated before version lookups or repairs. */
export function brainRetryError({ flags, skip, cfg }) {
  if (!flags['retry-brain']) return null;
  if (flags['no-upgrade']) return '--retry-brain cannot be combined with --no-upgrade';
  if (skip.has('ruvnet-brain')) return '--retry-brain cannot bypass --skip ruvnet-brain';
  if (!cfg?.ruvnetBrain) return '--retry-brain requires managed Brain intent in kit.json';
  return null;
}
