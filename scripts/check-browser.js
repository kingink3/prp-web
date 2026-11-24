import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureServer } from './serve.js';

const root = new URL('../', import.meta.url);
const profile = await mkdtemp(join(tmpdir(), 'prp-browser-'));
const prefix = '/prp-web/';
const server = createFixtureServer(prefix);

async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Timed out waiting for Chrome');
}

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless', '--disable-background-networking', '--no-first-run', '--remote-debugging-port=0',
  '--user-data-dir=' + profile, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let launchError;
let launchLog = '';
chrome.on('error', error => { launchError = error; });
chrome.stderr.on('data', data => { launchLog += data; });
let socket;

try {
  const port = await waitFor(async () => {
    if (launchError) throw launchError;
    if (chrome.exitCode !== null) throw new Error(launchLog);
    const info = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    return info.split('\n')[0];
  }, 20000).catch(error => {
    throw new Error(launchLog || error.message, { cause: error });
  });
  const [tab] = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json());
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await once(socket, 'open');

  const errors = [];
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown' ||
      (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') ||
      (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')) {
      errors.push(message.params);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, expression);
    return result.result.value;
  }

  await Promise.all(['Runtime.enable', 'Log.enable', 'Page.enable'].map(method => send(method)));
  const fixture = await readFile(new URL('fixtures/lab/today.json', root), 'base64');
  const fixtureFetch = content => {
    const fetchLive = window.fetch;
    window.fetch = (url, options) => {
      if (new URL(url).origin !== 'https://api.github.com') return fetchLive(url, options);
      window.lastGitHubRequest = { url, headers: options.headers };
      if (window.mockStatus !== 200) return Promise.resolve(new Response(null, { status: window.mockStatus }));
      const expires = new Date(Date.now() + 6 * 86400000).toISOString();
      return Promise.resolve(Response.json({ type: 'file', encoding: 'base64', content, sha: 'fixture' }, {
        headers: { etag: '"fixture"', 'github-authentication-token-expiration': expires },
      }));
    };
  };
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(' + fixtureFetch.toString() + ')(' + JSON.stringify(fixture) + ')',
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + prefix });
  await waitFor(() => evaluate("document.title === 'Настройки · PRP'"));
  assert.equal(await evaluate("document.querySelector('#token').type"), 'password');
  assert.equal(await evaluate("document.querySelector('#branch').value"), 'main');
  assert.equal(await evaluate('document.documentElement.scrollWidth === innerWidth'), true);
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(23, 24, 27)');

  await evaluate("location.hash = '#more'");
  await waitFor(() => evaluate("document.title === 'Ещё · PRP'"));
  await evaluate("document.querySelector('.menu-link').click()");
  await waitFor(() => evaluate("document.title === 'Настройки · PRP'"));
  await evaluate("document.querySelector('#theme').value = 'light'; document.querySelector('#theme').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(246, 247, 249)');
  await evaluate("document.querySelector('#repository').value = 'owner/repo'; document.querySelector('#token').value = 'test-only'");
  for (const status of [401, 403, 404, 200, 304]) {
    await evaluate('window.mockStatus = ' + status + "; document.querySelector('#check').click()");
    const expected = status >= 400 ? String(status) : 'OK';
    await waitFor(() => evaluate("document.querySelector('#connection-status').textContent.startsWith(" + JSON.stringify(expected) + ')'));
  }
  assert.equal(await evaluate("window.lastGitHubRequest.headers['If-None-Match']"), '"fixture"');
  assert.equal(await evaluate("document.querySelector('#expiry-warning').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#token').value"), '');
  await send('Page.reload');
  await waitFor(() => evaluate("!window.lastGitHubRequest && document.querySelector('#theme')?.value === 'light' && !document.querySelector('#expiry-warning').hidden"));
  await evaluate("document.querySelector('#forget').click()");
  assert.equal(await evaluate("localStorage.getItem('prp.githubToken')"), null);
  assert.equal(await evaluate("document.querySelector('#expiry-warning').hidden"), true);
  for (const [width, height] of [[320, 640], [768, 1024]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth === innerWidth'), true);
  }
  assert.deepEqual(errors, []);

  const url = 'http://127.0.0.1:' + server.address().port + prefix;
  const ready = "document.querySelector('[data-id=t4]') && !document.querySelector('.today-timer .today-time').disabled";
  const screenshots = process.env.PRP_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  async function capture(name, width, height) {
    if (!screenshots) return;
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: Math.max(height, cssContentSize.height), scale: 1 },
    });
    await writeFile(join(screenshots, name + '.png'), Buffer.from(data, 'base64'));
  }

  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: url + '?fixtures=1#settings' });
  await waitFor(() => evaluate("document.title === 'Настройки · PRP'"));
  assert.ok(await evaluate("document.querySelector('.tabs').scrollLeft > 0"));
  const tabInView = `(() => {
    const active = document.querySelector('.tabs [aria-current]');
    const tab = active.getBoundingClientRect();
    const track = active.parentElement.getBoundingClientRect();
    return tab.left >= track.left && tab.right <= track.right;
  })()`;
  assert.equal(await evaluate(tabInView), true);
  await evaluate("location.hash = '#today'");
  await waitFor(() => evaluate(ready));
  assert.equal(await evaluate(tabInView), true);

  for (const [width, height] of [[390, 844], [1280, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 });
    await send('Page.navigate', { url: url + '?fixtures=1#today' });
    await waitFor(() => evaluate(ready));
    const viewport = await evaluate('({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth })');
    assert.equal(viewport.content, viewport.viewport, width + ' px viewport has no horizontal page overflow');
    assert.equal(await evaluate("new Set([...document.querySelectorAll('.tabs a')].map(tab => tab.offsetTop)).size"), 1);
    assert.equal(await evaluate(tabInView), true);
    assert.equal(await evaluate("document.querySelector('.today-count').textContent"), 'Сделано 1/4 · 0/75 мин');
    assert.equal(await evaluate("document.body.textContent.includes('позже: 1')"), true);
    assert.equal(await evaluate("document.querySelector('[data-id=t4] .today-star').textContent"), '★');
    assert.equal(await evaluate('window.lastGitHubRequest'), undefined);
    if (width === 390) {
      assert.ok(await evaluate("document.querySelector('[data-id=t4] .today-menu summary').offsetHeight >= 40"));
      assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-id=t4]')).borderLeftWidth"), '4px');
      const duration = await evaluate(`(() => {
        const duration = document.querySelector('[data-id=t4] .today-time');
        const range = document.createRange();
        range.selectNodeContents(duration);
        return { text: duration.textContent, lines: range.getClientRects().length,
          width: range.getBoundingClientRect().width, controlWidth: duration.clientWidth };
      })()`);
      assert.equal(duration.text, '20 мин');
      assert.equal(duration.lines, 1);
      assert.ok(duration.width <= duration.controlWidth);
    }
    await capture('today-' + width, width, height);
  }

  const click = async selector => {
    const expression = 'document.querySelector(' + JSON.stringify(selector) + ')?.click()';
    await evaluate(expression);
  };
  const visible = selector => evaluate('Boolean(document.querySelector(' + JSON.stringify(selector) + '))');
  const idle = () => waitFor(() => evaluate("document.querySelector('.today-grid')?.getAttribute('aria-busy') === 'false'"));
  async function menu(id, text) {
    const row = '[data-id="' + id + '"]';
    await click(row + ' summary');
    await evaluate('[...document.querySelectorAll(' + JSON.stringify(row + ' .today-menu button') +
      ')].find(button => button.textContent === ' + JSON.stringify(text) + ').click()');
  }

  await click('[data-id=t4] .today-check');
  await idle();
  assert.equal(await visible('[data-id=t4].is-done'), true);
  await click('[data-id=t4] .today-check');
  await idle();
  await menu('t4', 'Комментарий / блокер');
  await evaluate("document.querySelector('textarea').value = '<b>Fixture note</b>'");
  await click('dialog button[type=submit], dialog .primary');
  await idle();
  assert.equal(await evaluate("document.querySelector('[data-id=t4]').textContent.includes('<b>Fixture note</b>')"), true);
  assert.equal(await visible('[data-id=t4] b'), false);
  await menu('t4', '→ Завтра');
  await idle();
  assert.equal(await visible('[data-id=t4]'), false);
  await click('.today-column details.today-card > summary');
  assert.equal(await evaluate("document.querySelector('.today-postponed').textContent.includes('Sort photos')"), true);
  await evaluate("[...document.querySelectorAll('.today-postponed button')].at(-1).click()");
  await idle();
  assert.equal(await evaluate("document.querySelector('.today-rows').textContent.includes('Call the plumber')"), true);

  await evaluate("document.querySelector('.todo-form input').value = 'Browser fixture to-do'");
  await click('.todo-form button[type=submit]');
  await idle();
  const todoSelector = '[data-path="todo.json"]:not(.is-done)';
  assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(todoSelector) + ").length"), 2);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const points = await evaluate("[...document.querySelectorAll(" + JSON.stringify(todoSelector + " .today-drag") +
    ")].map(button => { const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })");
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[1]] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [points[0]] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await idle();
  assert.equal(await evaluate("document.querySelector(" + JSON.stringify(todoSelector) + ").textContent.includes('Browser fixture to-do')"), true);
  const importantPoint = await evaluate("(() => { const r = document.querySelector('[data-path=\"todo.json\"] .today-row-title').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [importantPoint] });
  await delay(600);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await idle();
  assert.equal(await visible('[data-path="todo.json"] .today-star'), true);
  await click('.todo-form + button');
  await idle();
  assert.equal(await visible('[data-path="todo.json"].is-done'), false);

  await click('.today-reminder-actions button:first-child');
  await idle();
  assert.equal(await evaluate("document.querySelector('.today-reminder').textContent.includes('10:40')"), true);
  await click('.today-reminder > .today-check');
  await idle();
  assert.equal(await evaluate("document.querySelector('.today-muted:last-of-type') !== null && !document.querySelector('.today-reminder')"), true);
  await evaluate("document.querySelector('.reminder-form input').value = 'One-off browser reminder'");
  await click('.reminder-form button[type=submit]');
  await idle();
  assert.equal(await evaluate("document.querySelector('.today-reminder').textContent.includes('One-off browser reminder')"), true);

  await click('[data-id=t1] .today-time');
  await evaluate("document.querySelector('dialog input').value = '1'");
  await click('dialog .primary');
  await evaluate("window.chimes = 0; const oscillator = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.chimes++; return oscillator.call(this); }");
  const startPoint = await evaluate("(() => { const button = document.querySelector('[data-id=t1] .today-timer .today-icon'); button.scrollIntoView({ block: 'center' }); const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [startPoint] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(() => evaluate("document.querySelector('[data-id=t1] .today-timer .today-icon').textContent === '■'"));
  await evaluate("const realNow = Date.now; Date.now = () => realNow() + 61_000");
  await waitFor(() => evaluate("document.querySelector('dialog[open] h2')?.textContent === 'Отметить выполненным?'"));
  assert.equal(await evaluate('window.chimes'), 1);
  await click('dialog .primary');
  await idle();
  assert.equal(await visible('[data-id=t1].is-done'), true);
  await click('.today-heading button');
  await idle();
  assert.equal(await visible('[data-id=t1].is-done'), true);
  assert.equal(await evaluate("window.lastGitHubRequest === undefined && localStorage.getItem('prp.timers') === null"), true);
  await send('Page.reload');
  await waitFor(() => evaluate(ready));
  assert.equal(await visible('[data-id=t1].is-done'), false);

  // Run the new sections through the loopback fixture client, including returning to Today.
  const workIdle = () => waitFor(() => evaluate("document.querySelector('#objects-panel .work-content')?.getAttribute('aria-busy') === 'false'"));
  async function workCapture(name) {
    assert.equal(await evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth'), true);
    await evaluate('document.activeElement.blur(); window.scrollTo(0, 0)');
    await capture('work-' + name, 390, 844);
  }
  await click('[data-tab=directions]');
  await waitFor(() => visible('.work-tabs button'));
  assert.equal(await evaluate("document.querySelectorAll('.work-tabs button').length"), 5);
  await evaluate("[...document.querySelectorAll('.work-tabs button')].find(button => button.textContent === 'Проекты').click()");
  assert.match(await evaluate("document.querySelector('.work-object').textContent"), /Sample app.*Draft landing copy.*1\/3.*1 дн\. назад/);
  assert.equal(await evaluate("document.querySelector('.work-object progress').value"), 1);
  await workCapture('directions');
  await click('.work-object');
  await waitFor(() => visible('.work-tasks'));
  assert.equal(await evaluate("document.querySelectorAll('.work-task').length"), 3);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.work-text a'), a => [a.protocol, a.rel])`),
    [['https:', 'noopener noreferrer'], ['https:', 'noopener noreferrer']]);
  await click('.work-fields summary');
  await workCapture('project');
  await evaluate("document.querySelector('.work-form input').value = '<b>Browser project task</b>'");
  await click('.work-form button');
  await workIdle();
  assert.equal(await visible('.work-task b'), false);
  assert.equal(await evaluate("document.querySelector('.work-task:last-child label').textContent"), '<b>Browser project task</b>');
  await click('.work-task:last-child button:first-of-type');
  await workIdle();
  assert.equal(await evaluate("document.querySelector('.work-task:nth-child(3) label').textContent"), '<b>Browser project task</b>');
  await click('.work-task:nth-child(2) input');
  await workIdle();
  assert.equal(await evaluate("document.querySelector('.work-content section .work-text').textContent"), '<b>Browser project task</b>');
  await click('.work-task:nth-child(3) button:last-of-type');
  await workIdle();
  assert.equal(await evaluate("document.querySelector('.work-content section .work-text').textContent"), 'Show to 3 people');
  for (const value of ['paused', 'active']) {
    await evaluate(`(() => {
      const select = document.querySelector('.work-content select');
      select.value = '${value}';
      select.dispatchEvent(new Event('change'));
    })()`);
    await workIdle();
    assert.equal(await evaluate("document.querySelector('.work-content select').value"), value);
  }
  await click('.work-content button.primary');
  await workIdle();
  await click('[data-tab=today]');
  await waitFor(() => visible('[data-id^=p-]'));
  assert.match(await evaluate("document.querySelector('[data-id^=p-]').textContent"), /Show to 3 people/);

  await click('[data-tab=ideas]');
  await waitFor(() => visible('.work-comment'));
  assert.equal(await evaluate("document.querySelectorAll('.work-object').length"), 2);
  await workCapture('ideas');
  await click('.work-reactions button:nth-child(2)');
  await workIdle();
  assert.equal(await evaluate("document.querySelector('.work-reactions [aria-pressed=true]').textContent"), '🧪');
  await evaluate("document.querySelector('.work-comment textarea').value = 'Owner fixture note'");
  await click('.work-comment button');
  await workIdle();
  await click('[data-tab=calendar]');
  await waitFor(() => visible('.calendar-detail'));
  assert.match(await evaluate("document.querySelector('.calendar-detail').textContent"), /Buy batteries.*Sort photos.*Water plants/);
  assert.equal(await evaluate("performance.getEntriesByType('resource').some(entry => entry.name.includes('/history/2030-01-14.json.js'))"), false);
  await click('.calendar-day.has-data:not([aria-current])');
  await waitFor(() => evaluate("document.querySelector('.calendar-detail').textContent.includes('Old task')"));
  assert.match(await evaluate("document.querySelector('.calendar-detail').textContent"), /Old task.*Review the draft.*Return a library book/);
  assert.equal(await evaluate("document.querySelector('.calendar-day[aria-pressed=true]').classList.contains('lvl2')"), true);
  await workCapture('calendar');
  await evaluate("const search = document.querySelector('.calendar-search input'); search.value = 'review'; search.dispatchEvent(new Event('input'))");
  await waitFor(() => evaluate("document.querySelector('.calendar-search').textContent.includes('Review December')"));
  assert.match(await evaluate("document.querySelector('.calendar-search').textContent"), /Review the draft.*Review December/);
  await click('[data-tab=ideas]');
  await waitFor(() => visible('.work-comment'));
  assert.equal(await evaluate("document.querySelector('.work-comment textarea').value"), 'Owner fixture note');
  assert.equal(await evaluate('window.lastGitHubRequest'), undefined);

  // Mock real API writes to verify optimistic rendering and rollback without a token or network.
  const files = {};
  for (const file of ['today.json', 'todo.json', 'reminders.json',
    'learning/learning-20300101-sample-course.md', 'projects/project-20300101-sample-app.md']) {
    files[file] = await readFile(new URL('fixtures/lab/' + file, root), 'base64');
  }
  const mockWrites = files => {
    if (location.search !== '?rollback=1') return;
    localStorage.setItem('prp.settings', JSON.stringify({ repository: 'owner/repo', branch: 'main' }));
    localStorage.setItem('prp.githubToken', 'test-only');
    window.getCount = 0;
    window.puts = [];
    window.fetch = async (url, options) => {
      if (options.method === 'PUT') {
        window.puts.push(JSON.parse(options.body));
        return new Promise(resolve => {
          window.finishWrite = ok => resolve(ok ? Response.json({ content: { sha: 'new' } }) : new Response(null, { status: 500 }));
        });
      }
      window.getCount++;
      const name = new URL(url).pathname.split('/contents/')[1];
      if (!(name in files)) return new Response(null, { status: 404 });
      return Response.json({ type: 'file', encoding: 'base64', content: files[name], sha: 'before' });
    };
  };
  await send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + mockWrites.toString() + ')(' + JSON.stringify(files) + ')' });
  await send('Page.navigate', { url: url + '?rollback=1#today' });
  await waitFor(() => evaluate(ready));
  await click('[data-id=t1] .today-check');
  await waitFor(() => evaluate("window.puts.length === 1"));
  assert.equal(await visible('[data-id=t1].is-done'), true);
  assert.equal(await evaluate("window.puts[0].message"), 'lab: web — complete item');
  assert.equal(await evaluate("window.puts[0].sha"), 'before');
  await evaluate('window.finishWrite(false)');
  await idle();
  assert.equal(await visible('[data-id=t1].is-done'), false);
  assert.equal(await visible('.today-toast.error:not([hidden])'), true);
  await evaluate("window.beforeRefresh = window.getCount; document.dispatchEvent(new Event('visibilitychange'))");
  await waitFor(() => evaluate('window.getCount > window.beforeRefresh'));
  await idle();
  await evaluate("window.scrollTo(0, 0); window.beforeRefresh = window.getCount");
  const pullPoint = await evaluate("(() => { const r = document.querySelector('.today-heading h1').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pullPoint] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...pullPoint, y: pullPoint.y + 100 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(() => evaluate('window.getCount > window.beforeRefresh'));
  await idle();

  // Exercise both integrations using fixture tasks and independent GitHub and routine responses.
  const codexFixture = JSON.parse(await readFile(new URL('fixtures/lab/codex.json', root), 'utf8'));
  const mockMore = data => {
    if (location.search !== '?more=1') return;
    const task = data.tasks[0];
    data.tasks.push(
      { ...task, id: 'cx-2', title: '<b>Review fixture</b>', repo: 'owner/other', pr: 42, status: 'review' },
      { ...task, id: 'cx-3', repo: 'owner/repo', pr: 7, status: 'review' },
      { ...task, id: 'cx-4', status: 'changes', fix: 'Fixture follow-up' },
    );
    localStorage.setItem('prp.settings', JSON.stringify({ repository: 'owner/repo', branch: 'main' }));
    localStorage.setItem('prp.githubToken', 'fixture-github-token');
    window.moreWrites = [];
    window.routineRequests = [];
    window.confirm = prompt => {
      window.lastConfirmation = prompt;
      return Boolean(window.allowApproval);
    };
    window.routineStatus = 202;
    navigator.clipboard.writeText = async text => {
      if (window.failClipboard) throw new Error('Fixture clipboard denied');
      window.copiedCodexText = text;
    };
    window.fetch = async (url, options) => {
      const parsed = new URL(url);
      if (parsed.origin === 'https://api.anthropic.com') {
        window.routineRequests.push({ url, ...options });
        return new Response('fixture-routine-token', { status: window.routineStatus });
      }
      if (parsed.origin !== 'https://api.github.com' || !parsed.pathname.endsWith('/contents/codex.json')) {
        return new Response(null, { status: 404 });
      }
      const sha = 'codex-' + window.moreWrites.length;
      if (options.method === 'PUT') {
        const write = JSON.parse(options.body);
        if (write.sha !== sha) return new Response(null, { status: 409 });
        window.moreWrites.push({ ...write, clipboard: window.copiedCodexText });
        const bytes = Uint8Array.from(atob(write.content), char => char.charCodeAt(0));
        data = JSON.parse(new TextDecoder().decode(bytes));
        return Response.json({ content: { sha: 'codex-' + window.moreWrites.length } });
      }
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      const content = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      return Response.json({ type: 'file', encoding: 'base64', content, sha });
    };
  };
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(' + mockMore.toString() + ')(' + JSON.stringify(codexFixture) + ')',
  });
  await send('Page.navigate', { url: url + '?more=1#settings' });
  const moreSettingsReady = "location.search === '?more=1' && document.title === 'Настройки · PRP'";
  await waitFor(() => evaluate(moreSettingsReady));
  assert.equal(await evaluate("document.querySelector('#routine-token').type"), 'password');
  await evaluate(`document.querySelector('#routine-url').value = 'https://api.anthropic.com.evil/fire';
    document.querySelector('#routine-token').value = 'fixture-routine-token'`);
  await click('#routine-save');
  assert.equal(await evaluate("document.querySelector('#routine-notice').classList.contains('error')"), true);
  await evaluate("document.querySelector('#routine-url').value = 'https://api.anthropic.com/routines/fixture/fire'");
  await click('#routine-save');
  assert.equal(await evaluate("document.querySelector('#routine-token').value"), '');
  await evaluate('window.waitingForReload = true');
  await send('Page.reload');
  await waitFor(() => evaluate(moreSettingsReady + " && !window.waitingForReload"));
  assert.equal(await evaluate("document.querySelector('#routine-url').value.endsWith('/fixture/fire')"), true);
  assert.equal(await evaluate("document.querySelector('#routine-token').value"), '');
  await click('[data-tab=more]');
  await waitFor(() => visible('[data-codex-status=ready]'));
  assert.equal(await visible('[data-codex-id=cx-2] b'), false);
  assert.match(await evaluate("document.querySelector('[data-codex-id=cx-2]').textContent"), /<b>Review fixture<\/b>/);
  assert.equal(await evaluate("document.querySelector('[data-codex-id=cx-2] a').href"), 'https://github.com/owner/other/pull/42');
  assert.equal(await evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth'), true);

  await click('[data-payload="ideas: "]');
  assert.equal(await evaluate("document.querySelector('#instant-text').value"), 'ideas: ');
  await click('#instant-send');
  assert.equal(await evaluate('window.routineRequests.length'), 0);
  assert.equal(await evaluate("document.querySelector('#instant-notice').classList.contains('error')"), true);
  await click('[data-payload="critic: "]');
  assert.equal(await evaluate("document.querySelector('#instant-text').value"), 'critic: ');
  await click('[data-payload=extra_lesson]');
  for (const status of [401, 404, 429, 202]) {
    await evaluate('window.routineStatus = ' + status);
    await click('#instant-send');
    const expected = status === 202 ? 'Запрос принят.' : String(status);
    await waitFor(() => evaluate("document.querySelector('#instant-notice').textContent.startsWith(" + JSON.stringify(expected) + ')'));
  }
  assert.equal(await evaluate('window.routineRequests.length'), 4);
  assert.equal(await evaluate("window.routineRequests[0].body"), '{"text":"extra_lesson"}');
  assert.equal(await evaluate('window.routineRequests[0].headers.Authorization'), 'Bearer fixture-routine-token');
  assert.equal(await evaluate("document.body.textContent.includes('fixture-routine-token')"), false);

  const codexIdle = () => waitFor(() => evaluate("document.querySelector('#codex-list').getAttribute('aria-busy') === 'false'"));
  const row = '[data-codex-id=cx-1900000003]';
  await evaluate('window.failClipboard = true');
  await click(row + ' button:first-child');
  await codexIdle();
  assert.equal(await evaluate('window.moreWrites.length'), 0);
  assert.equal(await visible('[data-codex-status=ready] ' + row), true);
  await evaluate('window.failClipboard = false');
  await click(row + ' button:first-child');
  await codexIdle();
  assert.equal(await visible('[data-codex-status=sent] ' + row), true);
  assert.match(await evaluate('window.moreWrites[0].clipboard'), /PRP task cx-1900000003 — Add tests/);
  assert.equal(await evaluate('window.moreWrites[0].message'), 'lab: web — send Codex task cx-1900000003');
  await click(row + ' button');
  await codexIdle();
  assert.equal(await visible('[data-codex-status=cancelled] ' + row), true);
  await click(row + ' button');
  await codexIdle();
  assert.equal(await visible('[data-codex-status=ready] ' + row), true);
  await click('[data-codex-id=cx-4] button:first-child');
  await codexIdle();
  assert.equal(await evaluate('window.moreWrites[3].clipboard'), 'Fixture follow-up');

  await click('[data-codex-id=cx-2] button:first-child');
  assert.match(await evaluate('window.lastConfirmation'), /42.*owner\/other/);
  assert.equal(await evaluate('window.routineRequests.length'), 4);
  await evaluate('window.allowApproval = true');
  for (const [id, payload] of [['cx-2', 'ок: owner/other#42'], ['cx-3', 'ок: 7']]) {
    await click('[data-codex-id=' + id + '] button:first-child');
    await codexIdle();
    assert.equal(await evaluate('JSON.parse(window.routineRequests.at(-1).body).text'), payload);
    assert.equal(await visible('[data-codex-status=review] [data-codex-id=' + id + ']'), true);
  }
  assert.equal(await evaluate('window.moreWrites.length'), 4);
  await click('.menu-link');
  await waitFor(() => evaluate("document.title === 'Настройки · PRP'"));
  await click('#routine-forget');
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('prp.routine')).token"), undefined);
  assert.equal(await evaluate("localStorage.getItem('prp.githubToken')"), 'fixture-github-token');
  assert.deepEqual(errors, []);
  if (screenshots) {
    const routes = [
      ['today', '[data-id=t4]'],
      ['directions', '.work-object'],
      ['calendar', '.calendar-day.lvl2'],
      ['settings', '#settings-panel:not([hidden]) #theme'],
    ];
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 });
      for (const theme of ['light', 'dark']) {
        for (const [route, selector] of routes) {
          await send('Page.navigate', { url: url + '?fixtures=1#settings' });
          await waitFor(() => evaluate("document.title === 'Настройки · PRP'"));
          await evaluate(`(() => {
            const field = document.querySelector('#theme');
            field.value = '${theme}';
            field.dispatchEvent(new Event('change'));
            location.hash = '#${route}';
          })()`);
          await waitFor(() => visible(selector));
          assert.equal(await evaluate('document.documentElement.scrollWidth'), width);
          assert.equal(await evaluate(tabInView), true);
          await capture('design-' + route + '-' + width + '-' + theme, width, height);
        }
      }
    }
  }
  console.log('Browser Settings, Today, Directions, Ideas, Calendar and More checks passed');
} finally {
  socket?.close();
  if (chrome.pid && chrome.exitCode === null) {
    const closed = once(chrome, 'close');
    chrome.kill();
    await closed;
  }
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
