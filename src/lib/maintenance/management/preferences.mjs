// ADR-0048 owner-private view/shell/retention preferences (MNT-PRV-006/007).
//
// Preferences live in owner-private state, never project configuration.
// `resolveViewState` is the pure rule "a valid URL state overrides the
// remembered view"; the store persists what gets remembered next.
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import { SCOPE_LENSES, CURATED_VIEWS, SHELLS, SORT_ORDERS, SCAN_HISTORY_FLOORS } from './model.mjs';

const PREFERENCES_STORE_SCHEMA = 'maintenance-preferences/v1';
const MAX_STORE_BYTES = 256 * 1024;

const DEFAULT_PREFERENCES = Object.freeze({
  lastView: Object.freeze({ scope: 'across', view: 'all', sort: 'guidance-first', facets: {}, search: '' }),
  preferredShellByEnvironment: Object.freeze({}),
  retention: Object.freeze({ maxSummaries: null, maxAgeDays: null }),
});

function storeFile(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('preferences store root must be a dedicated absolute directory');
  }
  return path.join(path.normalize(root), 'preferences.json');
}

function readAll(root, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(storeFile(root), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return clonePreferences(DEFAULT_PREFERENCES);
    throw error;
  }
  const envelope = JSON.parse(raw);
  if (envelope.schemaVersion !== PREFERENCES_STORE_SCHEMA) throw new Error('preferences store schema mismatch');
  return envelope.preferences;
}

function writeAll(root, preferences, fsImpl) {
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const envelope = { schemaVersion: PREFERENCES_STORE_SCHEMA, preferences };
  const bytes = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new Error('preferences store exceeds size limit');
  writePrivateFileAtomic(storeFile(root), bytes, { fsImpl });
}

function clonePreferences(preferences) {
  return JSON.parse(JSON.stringify(preferences));
}

function assertRetention(retention) {
  if (retention == null) return;
  const { maxSummaries, maxAgeDays } = retention;
  if (maxSummaries != null && (!Number.isInteger(maxSummaries) || maxSummaries < SCAN_HISTORY_FLOORS.minSummaries)) {
    throw new TypeError(`retention.maxSummaries must be at least ${SCAN_HISTORY_FLOORS.minSummaries}`);
  }
  if (maxAgeDays != null && (!Number.isInteger(maxAgeDays) || maxAgeDays < SCAN_HISTORY_FLOORS.minAgeDays)) {
    throw new TypeError(`retention.maxAgeDays must be at least ${SCAN_HISTORY_FLOORS.minAgeDays}`);
  }
}

function assertLastView(lastView) {
  if (lastView == null) return;
  if (lastView.scope != null && !SCOPE_LENSES.includes(lastView.scope)) throw new TypeError('lastView.scope is invalid');
  if (lastView.view != null && !CURATED_VIEWS.includes(lastView.view)) throw new TypeError('lastView.view is invalid');
  if (lastView.sort != null && !SORT_ORDERS.includes(lastView.sort)) throw new TypeError('lastView.sort is invalid');
}

/** Owner-private preferences rooted at `root`
 *  (`<maintenanceControlDir()>/management`).
 * @param {{ root: string, fsImpl?: any }} options */
export function createPreferencesStore({ root, fsImpl = fs } = /** @type {any} */ ({})) {
  function getPreferences() {
    return readAll(root, fsImpl);
  }

  function savePreferences(partial = {}) {
    assertLastView(partial.lastView);
    assertRetention(partial.retention);
    const current = readAll(root, fsImpl);
    const next = {
      lastView: { ...current.lastView, ...(partial.lastView ?? {}) },
      preferredShellByEnvironment: { ...current.preferredShellByEnvironment, ...(partial.preferredShellByEnvironment ?? {}) },
      retention: { ...current.retention, ...(partial.retention ?? {}) },
    };
    writeAll(root, next, fsImpl);
    return next;
  }

  function setPreferredShell(environmentId, shell) {
    if (typeof environmentId !== 'string' || !environmentId) throw new TypeError('environmentId is required');
    if (!SHELLS.includes(shell)) throw new TypeError(`shell must be one of ${SHELLS.join(', ')}`);
    return savePreferences({ preferredShellByEnvironment: { [environmentId]: shell } });
  }

  return { getPreferences, savePreferences, setPreferredShell };
}

/**
 * A valid URL-decoded view state overrides the remembered one (MNT-PRV-006).
 * `url` is the object `query.decodeQueryState` returned (or null/undefined
 * when the URL carried none); `remembered` is `getPreferences().lastView`.
 * @param {{ url?: any, remembered?: any }} options
 */
export function resolveViewState({ url, remembered } = /** @type {any} */ ({})) {
  const isValidUrlState = url && typeof url === 'object'
    && (url.scope == null || SCOPE_LENSES.includes(url.scope))
    && (url.view == null || CURATED_VIEWS.includes(url.view))
    && (url.sort == null || SORT_ORDERS.includes(url.sort))
    && Object.keys(url).length > 0;
  if (isValidUrlState) return { ...DEFAULT_PREFERENCES.lastView, ...url };
  return { ...DEFAULT_PREFERENCES.lastView, ...(remembered ?? {}) };
}

export const DEFAULT_MANAGEMENT_PREFERENCES = DEFAULT_PREFERENCES;
