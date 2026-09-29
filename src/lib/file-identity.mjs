// Persisted file IDs are decimal strings. A legacy Number is comparable only
// when it was a safe integer; an unsafe Number has already lost information.
export function fileId(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  return null;
}

export function sameFileId(left, right) {
  const a = fileId(left);
  return a !== null && a === fileId(right);
}

export function statMtimeMs(stat) {
  if (typeof stat.mtimeNs !== 'bigint') return stat.mtimeMs;
  return Number(stat.mtimeNs / 1_000_000n) + Number(stat.mtimeNs % 1_000_000n) / 1_000_000;
}
