// Browser-side theme controller embedded into the admin's single module.
// Sharing the dashboard key makes the two local consoles honor one preference.
export const ADMIN_THEME_JS = `
const ADMIN_THEME_STORE = 'ak-dash-theme';
function adminApplyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', value);
  const button = document.querySelector('[data-theme-toggle]');
  if (button) {
    button.textContent = value === 'dark' ? '☾' : '☀';
    button.setAttribute('aria-label', value === 'dark' ? 'switch to light theme' : 'switch to dark theme');
  }
}
let adminTheme = '';
try { adminTheme = localStorage.getItem(ADMIN_THEME_STORE) || ''; } catch { /* private mode */ }
if (adminTheme !== 'dark' && adminTheme !== 'light') {
  adminTheme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
adminApplyTheme(adminTheme);
const adminThemeButton = document.querySelector('[data-theme-toggle]');
if (adminThemeButton) adminThemeButton.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(ADMIN_THEME_STORE, next); } catch { /* private mode */ }
  adminApplyTheme(next);
});
`;
