// styles.mjs — the dashboard's inline stylesheet, embedded at page.mjs via
// `<style>${CSS}</style>` (one HTML response, no external stylesheet, no new
// routes). Split per area alongside the client.mjs split (2026-08 complexity
// audit, Finding 2/4): each area's rules are a real, plain data module under
// ./styles/ — pure CSS text, no interpolation, so unlike client.mjs's browser
// modules these need no import-stripping or placeholder mechanism at all.
// This file just concatenates them in the SAME order the pre-split stylesheet
// always declared them in (base → Usage → About/footer → System), so
// selector specificity and cascade order are unchanged.
import { BASE_CSS } from './styles/base.mjs';
import { USAGE_CSS } from './styles/usage.mjs';
import { ABOUT_CSS } from './styles/about.mjs';
import { SYSTEM_CSS } from './styles/system.mjs';

export const CSS = `${BASE_CSS}${USAGE_CSS}${ABOUT_CSS}${SYSTEM_CSS}`;

// ── Client script ────────────────────────────────────────────────────────────
// No backticks and no ${ } anywhere below — this whole string is embedded inside
// a server-side template literal, so those tokens would be misparsed. Plain
// string concatenation only.
