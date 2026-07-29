const segments = (path) => String(path).split('.').filter(Boolean);

function readAt(value, path) {
  let cursor = value;
  for (const key of segments(path)) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function restoreAt(value, path, prior) {
  const keys = segments(path);
  let cursor = value;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  const leaf = keys.at(-1);
  if (prior === undefined) delete cursor[leaf];
  else cursor[leaf] = structuredClone(prior);
}

export function undoOwnedValues(current, operations = []) {
  const value = structuredClone(current);
  const preserved = [];
  let changed = false;
  for (const operation of operations) {
    if (!Object.is(readAt(value, operation.path), operation.written)) {
      preserved.push(operation.path);
      continue;
    }
    restoreAt(value, operation.path, operation.prior);
    changed = true;
  }
  return { value, changed, preserved };
}
