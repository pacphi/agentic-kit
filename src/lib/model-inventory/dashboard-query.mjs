import { immutable } from '../adapters/schema.mjs';

const DIMENSIONS = Object.freeze([
  'configured', 'effective', 'observed', 'discoverable',
  'entitled', 'policyAllowed', 'routable',
]);
const SORTS = new Set(['displayName', 'host', 'provider', 'publisher', 'lifecycle', ...DIMENSIONS]);
const QUERY_KEYS = new Set([
  'view', 'offset', 'limit', 'sort', 'direction', 'search', 'host', 'provider',
  'publisher', 'lifecycle', 'relevance', 'evidenceField', 'evidenceValue',
  'snapshotId', 'days', ...DIMENSIONS, 'token',
]);
const LIFECYCLE_ORDER = new Map([
  ['removed', 0], ['retiring', 1], ['deprecated', 2], ['hidden', 3],
  ['preview', 4], ['active', 5],
]);

function invalidQuery() {
  return Object.assign(new TypeError('invalid model inventory query'), {
    code: 'INVALID_MODEL_INVENTORY_QUERY',
  });
}

function snapshotChanged() {
  return Object.assign(new Error('model inventory snapshot changed'), {
    code: 'MODEL_INVENTORY_SNAPSHOT_CHANGED',
  });
}

function one(query, name) {
  const values = query.getAll(name);
  if (values.length > 1) throw invalidQuery();
  return values[0] ?? null;
}

function validText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && ![...value].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);
}

function queryText(query, name, max = 128) {
  const value = one(query, name);
  if (value == null || value === '') return null;
  if (!validText(value, max)) throw invalidQuery();
  return value;
}

function dimensionFilter(value) {
  if (value == null || value === '' || value === 'all') return null;
  if (value === 'true') return 'yes';
  if (value === 'false') return 'no';
  if (!['yes', 'no', 'unknown'].includes(value)) throw invalidQuery();
  return value;
}

function parseNonInventoryQuery(query, view) {
  for (const key of query.keys()) if (!['view', 'token', 'days'].includes(key)) throw invalidQuery();
  const rawDays = one(query, 'days');
  if (view !== 'summary' && rawDays != null) throw invalidQuery();
  if (rawDays != null && (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 365)) {
    throw invalidQuery();
  }
  return { view, days: rawDays == null ? null : Number(rawDays) };
}

function queryInteger(query, name, fallback) {
  const rawValue = one(query, name);
  if (rawValue == null || rawValue === '') return fallback;
  if (!/^\d+$/.test(rawValue)) throw invalidQuery();
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value > 10_000_000) throw invalidQuery();
  return value;
}

function inventorySortSelection(query) {
  const sort = one(query, 'sort') ?? 'displayName';
  const direction = one(query, 'direction') ?? 'asc';
  const relevance = one(query, 'relevance') ?? 'relevant';
  if (!SORTS.has(sort) || !['asc', 'desc'].includes(direction)
    || !['relevant', 'catalog', 'all'].includes(relevance)) throw invalidQuery();
  return { sort, direction, relevance };
}

function inventoryEvidenceFilter(query) {
  const evidenceField = one(query, 'evidenceField');
  const evidenceValue = dimensionFilter(one(query, 'evidenceValue'));
  if ((evidenceField == null) !== (evidenceValue == null)
    || (evidenceField != null && !DIMENSIONS.includes(evidenceField))) throw invalidQuery();
  return { evidenceField, evidenceValue };
}

function parseInventoryQuery(query, view) {
  if (one(query, 'days') != null) throw invalidQuery();
  const { sort, direction, relevance } = inventorySortSelection(query);
  const { evidenceField, evidenceValue } = inventoryEvidenceFilter(query);
  const dimensions = Object.fromEntries(DIMENSIONS.map((name) => (
    [name, dimensionFilter(one(query, name))]
  )));
  return {
    view, offset: queryInteger(query, 'offset', 0),
    limit: Math.min(100, Math.max(1, queryInteger(query, 'limit', 50))),
    sort, direction, relevance, search: queryText(query, 'search'),
    host: queryText(query, 'host'), provider: queryText(query, 'provider'),
    publisher: queryText(query, 'publisher'), lifecycle: queryText(query, 'lifecycle', 64),
    snapshotId: queryText(query, 'snapshotId', 128),
    evidenceField, evidenceValue, dimensions,
  };
}

function parseQuery(raw) {
  const query = raw instanceof URLSearchParams ? raw : new URLSearchParams(raw ?? '');
  for (const key of query.keys()) if (!QUERY_KEYS.has(key)) throw invalidQuery();
  const view = one(query, 'view') ?? 'full';
  if (!['full', 'summary', 'inventory'].includes(view)) throw invalidQuery();
  return view === 'inventory' ? parseInventoryQuery(query, view) : parseNonInventoryQuery(query, view);
}

function isRelevant(model) {
  return ['configured', 'effective', 'observed'].some((name) => model.dimensions[name]?.value === true)
    || (model.dimensions.discoverable?.value === true
      && ['retiring', 'deprecated', 'hidden'].includes(model.lifecycle.state));
}

function matchesDimension(model, name, filter) {
  if (!filter) return true;
  const value = model.dimensions[name]?.value;
  return filter === 'unknown' ? value == null : filter === 'yes' ? value === true : value === false;
}

function sortValue(model, field) {
  if (DIMENSIONS.includes(field)) return model.dimensions[field]?.value ?? null;
  if (field === 'provider') return model.servingProvider;
  if (field === 'lifecycle') return LIFECYCLE_ORDER.get(model.lifecycle.state) ?? null;
  return field === 'displayName' ? model.displayName : model[field] ?? null;
}

function compareKnown(a, b) {
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a).toLocaleLowerCase('en-US');
  const right = String(b).toLocaleLowerCase('en-US');
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareModels(a, b, sort, direction) {
  const left = sortValue(a, sort);
  const right = sortValue(b, sort);
  if (left == null && right != null) return 1;
  if (left != null && right == null) return -1;
  if (left != null && right != null) {
    const compared = compareKnown(left, right);
    if (compared) return direction === 'desc' ? -compared : compared;
  }
  return compareKnown(a.displayName, b.displayName) || compareKnown(a.identity, b.identity);
}

function facets(models) {
  const values = (pick, max = 100) => {
    const counts = new Map();
    for (const model of models) {
      const value = pick(model);
      if (value != null && value !== '') counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort(([left], [right]) => compareKnown(left, right)).slice(0, max)
      .map(([value, count]) => ({ value, count }));
  };
  const dimensions = Object.fromEntries(DIMENSIONS.map((name) => [name, values((model) => {
    const value = model.dimensions[name]?.value;
    return value == null ? 'unknown' : value ? 'yes' : 'no';
  }, 3)]));
  return {
    hosts: values((model) => model.host, 32),
    providers: values((model) => model.servingProvider),
    publishers: values((model) => model.publisher),
    lifecycles: values((model) => model.lifecycle.state, 16),
    dimensions,
  };
}

function activeFilters(parsed) {
  const filters = { relevance: parsed.relevance };
  for (const name of ['search', 'host', 'provider', 'publisher', 'lifecycle', 'evidenceField', 'evidenceValue']) {
    if (parsed[name] != null) filters[name] = parsed[name];
  }
  for (const [name, value] of Object.entries(parsed.dimensions)) if (value) filters[name] = value;
  return filters;
}

/** Apply validated, privacy-safe query views to an already-projected payload. */
export function dashboardModelView(projected, rawQuery) {
  const parsed = parseQuery(rawQuery);
  if (parsed.view === 'full' || !projected || projected.status === 'empty' || !projected.snapshot) {
    return projected;
  }
  const models = projected.snapshot.models;
  if (parsed.view === 'inventory' && parsed.snapshotId != null
    && parsed.snapshotId !== projected.snapshot.snapshotId) throw snapshotChanged();
  const relevantTotal = models.filter(isRelevant).length;
  if (parsed.view === 'summary') {
    const { models: _models, ...snapshot } = projected.snapshot;
    return immutable({ ...projected, snapshot, inventory: { total: models.length, relevantTotal } });
  }
  const lower = (value) => String(value).toLocaleLowerCase('en-US');
  const search = parsed.search == null ? null : lower(parsed.search);
  const exact = (actual, expected) => expected == null || lower(actual ?? '') === lower(expected);
  const filtered = models.filter((model) => {
    const relevant = isRelevant(model);
    if (parsed.relevance === 'relevant' && !relevant) return false;
    if (parsed.relevance === 'catalog' && (relevant || model.dimensions.discoverable.value !== true)) return false;
    if (!exact(model.host, parsed.host) || !exact(model.servingProvider, parsed.provider)
      || !exact(model.publisher, parsed.publisher) || !exact(model.lifecycle.state, parsed.lifecycle)) return false;
    if (search && ![
      model.displayName, model.humanName, model.selector, model.host,
      model.servingProvider, model.publisher, model.family, model.lifecycle.state,
    ].some((value) => value != null && lower(value).includes(search))) return false;
    if (parsed.evidenceField
      && !matchesDimension(model, parsed.evidenceField, parsed.evidenceValue)) return false;
    return Object.entries(parsed.dimensions).every(([name, filter]) => matchesDimension(model, name, filter));
  }).sort((a, b) => compareModels(a, b, parsed.sort, parsed.direction));
  const items = filtered.slice(parsed.offset, parsed.offset + parsed.limit);
  const nextOffset = parsed.offset + items.length < filtered.length ? parsed.offset + items.length : null;
  return immutable({
    status: projected.status,
    snapshot: {
      snapshotId: projected.snapshot.snapshotId, capturedAt: projected.snapshot.capturedAt,
      privacy: projected.snapshot.privacy,
    },
    inventory: {
      items, total: models.length, filteredTotal: filtered.length, relevantTotal,
      offset: parsed.offset, limit: parsed.limit, nextOffset, hasMore: nextOffset != null,
      sort: parsed.sort, direction: parsed.direction, filters: activeFilters(parsed), facets: facets(models),
    },
  });
}
