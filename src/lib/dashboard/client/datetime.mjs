// @ts-nocheck — browser bundle source (client.mjs reads it as text). These
// pure helpers are also imported directly by unit tests.

function dateTimeInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  var at = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(at) ? new Date(at) : null;
}

function dateTimeOptions(options) {
  var supplied = options && typeof options === 'object' ? options : {};
  return {
    locale: supplied.locale || undefined,
    timeZone: supplied.timeZone || undefined,
  };
}

/** Compact instant in the reader's browser locale and timezone. */
export function formatLocalDateTime(value, options) {
  var instant = dateTimeInstant(value);
  if (!instant) return null;
  var settings = dateTimeOptions(options);
  try {
    var date = new Intl.DateTimeFormat(settings.locale, {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: settings.timeZone,
    }).format(instant);
    var time = new Intl.DateTimeFormat(settings.locale, {
      hour: 'numeric', minute: '2-digit', timeZone: settings.timeZone,
    }).format(instant);
    return date + ' · ' + time;
  } catch (_) { return null; }
}

/** Detail/rollover instant with seconds and an explicit timezone. */
export function formatLocalDateTimeLong(value, options) {
  var instant = dateTimeInstant(value);
  if (!instant) return null;
  var settings = dateTimeOptions(options);
  try {
    var date = new Intl.DateTimeFormat(settings.locale, {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: settings.timeZone,
    }).format(instant);
    var time = new Intl.DateTimeFormat(settings.locale, {
      hour: 'numeric', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short', timeZone: settings.timeZone,
    }).format(instant);
    return date + ' · ' + time;
  } catch (_) { return null; }
}

/** Native host ids remain opaque; only their presentation is shortened. */
export function shortSessionId(value) {
  var id = String(value == null ? '' : value);
  return id.length > 12 ? '…' + id.slice(-12) : id;
}
