import { createGitHubClient, GitHubError, isRepository } from './github.js';
import { strings } from './strings.js';
import { createFixtureClient, fixtureMode } from './fixtures.js';
import { createTodayView } from './today-view.js';

const SETTINGS_KEY = 'prp.settings';
const TOKEN_KEY = 'prp.githubToken';
const THEME_KEY = 'prp.theme';
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const byId = id => document.getElementById(id);

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readSettings() {
  try {
    return JSON.parse(readStorage(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

const form = byId('settings-form');
const repositoryField = byId('repository');
const branchField = byId('branch');
const tokenField = byId('token');
const checkButton = byId('check');
const forgetButton = byId('forget');
const status = byId('connection-status');
const warning = byId('expiry-warning');
const themeField = byId('theme');
const tabs = [...document.querySelectorAll('[data-tab]')];
const routes = new Set([...tabs.map(tab => tab.dataset.tab), 'settings']);
let settings = readSettings();
let savedToken = fixtureMode ? null : readStorage(TOKEN_KEY);
let activeCheck;
let connection;
const fixtureClient = fixtureMode ? createFixtureClient() : null;
const todayPanel = byId('today-panel');
const todayView = createTodayView(todayPanel, { fixture: fixtureMode, onResponse: updateExpiration });

for (const element of document.querySelectorAll('[data-string]')) {
  element.textContent = strings[element.dataset.string];
}
for (const element of document.querySelectorAll('[data-label]')) {
  element.setAttribute('aria-label', strings[element.dataset.label]);
}

function showRoute() {
  const requested = location.hash.slice(1);
  const connected = isRepository(settings.repository ?? '') && savedToken;
  const initial = fixtureMode || connected ? 'today' : 'settings';
  const route = routes.has(requested) ? requested : initial;
  const selected = route === 'settings' ? 'more' : route;
  for (const tab of tabs) {
    if (tab.dataset.tab === selected) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  todayPanel.hidden = route !== 'today';
  if (route === 'today') {
    const branch = settings.branch || 'main';
    todayView.show(fixtureClient || (connected && connectionFor(settings.repository, branch, savedToken)),
      fixtureMode ? 'fixtures' : JSON.stringify([settings.repository, branch]));
  } else todayView.hide();
  const overview = route !== 'today' && route !== 'more' && route !== 'settings';
  byId('overview').hidden = !overview;
  byId('more-panel').hidden = route !== 'more';
  byId('settings-panel').hidden = route !== 'settings';
  if (overview) byId('overview-title').textContent = strings[route];
  document.title = `${strings[route]} · ${strings.appName}`;
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  themeField.value = document.documentElement.dataset.theme ?? 'system';
}

function showStatus(message, kind = '') {
  status.textContent = message;
  status.className = kind ? `notice ${kind}` : 'notice';
  status.hidden = !message;
}

function showExpiration() {
  const expiration = savedToken && settings.expiration;
  const remaining = typeof expiration === 'number' ? expiration - Date.now() : Infinity;
  warning.hidden = remaining > ONE_WEEK;
  if (warning.hidden) warning.textContent = '';
  else if (remaining <= 0) warning.textContent = strings.expired;
  else warning.textContent = strings.expires(new Intl.DateTimeFormat('ru', { dateStyle: 'long' }).format(expiration));
}

function parseExpiration(header) {
  if (!header) return null;
  const iso = header.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (UTC|[+-]\d{4})$/, (_, date, time, zone) =>
    `${date}T${time}${zone === 'UTC' ? 'Z' : zone.slice(0, 3) + ':' + zone.slice(3)}`);
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function connectionError(error) {
  if (!(error instanceof GitHubError)) return error instanceof TypeError ? strings.network : strings.invalidResponse;
  if (error.rateLimited) return strings.rateLimited;
  switch (error.status) {
    case 401: return strings.unauthorized;
    case 403: return strings.forbidden;
    case 404: return strings.notFound;
    default: return strings.requestFailed(error.status);
  }
}

function refreshTokenField() {
  tokenField.placeholder = savedToken ? strings.tokenStored : '';
  forgetButton.disabled = !savedToken && !tokenField.value && !activeCheck;
}

function connectionFor(repository, branch, token) {
  if (connection?.repository !== repository || connection.branch !== branch || connection.token !== token) {
    connection = { repository, branch, token, client: createGitHubClient({ repository, branch, token }) };
  }
  return connection.client;
}

function updateExpiration(client) {
  const expiration = parseExpiration(client.tokenExpiration);
  if (expiration === null || expiration === settings.expiration || !savedToken) return;
  settings = { ...settings, expiration };
  showExpiration();
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Keep the current warning. */ }
}

async function checkConnection(event) {
  event.preventDefault();
  if (activeCheck || fixtureMode) return;
  const repository = repositoryField.value.trim();
  const branch = branchField.value.trim() || 'main';
  const token = tokenField.value.trim() || savedToken;
  if (!isRepository(repository)) return showStatus(strings.invalidRepository, 'error');
  if (!token) return showStatus(strings.missingToken, 'error');

  const controller = new AbortController();
  activeCheck = controller;
  checkButton.disabled = true;
  repositoryField.readOnly = branchField.readOnly = tokenField.readOnly = true;
  refreshTokenField();
  showStatus(strings.checking);
  try {
    const client = connectionFor(repository, branch, token);
    await client.getFile('today.json', { signal: controller.signal });
    if (activeCheck !== controller) return;
    const expiration = parseExpiration(client.tokenExpiration) ?? (savedToken === token ? settings.expiration : null);
    settings = { repository, branch, expiration };
    savedToken = token;
    repositoryField.value = repository;
    branchField.value = branch;
    tokenField.value = '';
    showExpiration();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem(TOKEN_KEY, token);
      showStatus(strings.connected, 'success');
    } catch {
      showStatus(strings.storageUnavailable, 'error');
    }
  } catch (error) {
    if (activeCheck === controller) showStatus(connectionError(error), 'error');
  } finally {
    if (activeCheck === controller) finishCheck();
  }
}

function finishCheck() {
  activeCheck = undefined;
  checkButton.disabled = fixtureMode;
  repositoryField.readOnly = branchField.readOnly = tokenField.readOnly = false;
  refreshTokenField();
}

function forgetToken() {
  activeCheck?.abort();
  connection = undefined;
  savedToken = null;
  tokenField.value = '';
  showExpiration();
  finishCheck();
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    showStatus(strings.forgetFailed, 'error');
    return;
  }
  showStatus(strings.forgotten);
}

repositoryField.value = settings.repository ?? '';
branchField.value = settings.branch || 'main';
refreshTokenField();
checkButton.disabled = fixtureMode;
applyTheme(readStorage(THEME_KEY));
showExpiration();
showRoute();

window.addEventListener('hashchange', showRoute);
form.addEventListener('submit', checkConnection);
tokenField.addEventListener('input', refreshTokenField);
forgetButton.addEventListener('click', forgetToken);
themeField.addEventListener('change', () => {
  applyTheme(themeField.value);
  try { localStorage.setItem(THEME_KEY, themeField.value); } catch { /* Keep the current selection. */ }
});
