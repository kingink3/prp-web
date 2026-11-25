import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureServer } from './serve.js';
import { comparisonHtml, consoleMarkup } from './design-reference.js';

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
  const ready = "document.querySelector('[data-id=t4]') && document.querySelector('.today-timer .today-time:not(:disabled)')";
  const screenshots = process.env.PRP_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  async function capture(name, width, height, viewportOnly = false) {
    if (!screenshots) return;
    const options = { format: 'png', fromSurface: true };
    if (!viewportOnly) {
      const { cssContentSize } = await send('Page.getLayoutMetrics');
      options.captureBeyondViewport = true;
      options.clip = { x: 0, y: 0, width, height: Math.max(height, cssContentSize.height), scale: 1 };
    }
    const { data } = await send('Page.captureScreenshot', options);
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
    assert.equal(await evaluate("document.querySelector('.today-count').textContent"), 'Сделано 2/6');
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
  await menu('t4', '💬 Комментарий / блокер');
  await evaluate("document.querySelector('.today-dialog textarea').value = '<b>Fixture note</b>'");
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
  // Rows are dragged as a whole: on touch, hold ~0.3 s and move.
  const points = await evaluate("[...document.querySelectorAll(" + JSON.stringify(todoSelector + " .today-row-title") +
    ")].map(title => { const r = title.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })");
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[1]] });
  await delay(450);
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: points[1].x, y: (points[1].y + points[0].y) / 2 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [points[0]] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await idle();
  assert.equal(await evaluate("document.querySelector(" + JSON.stringify(todoSelector) + ").textContent.includes('Browser fixture to-do')"), true);
  // ⭐ important: right click (mouse); on touch it lives in the «⋯» menu.
  await evaluate("document.querySelector('[data-path=\"todo.json\"] .today-row-title').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))");
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

  const focusTitle = () => evaluate("document.querySelector('.focus-view[open] h1')?.textContent");
  const focusIdle = () => waitFor(() => visible('.focus-view[open][aria-busy=false]'));
  async function setTimerLength(value) {
    await click('.focus-timer .today-time');
    await evaluate("document.querySelector('.focus-timer input').value = " + JSON.stringify(value));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(() => visible('.focus-timer input[hidden]'));
  }
  async function waitForFocusClose() {
    await waitFor(() => evaluate("!document.querySelector('.focus-view[open]') && !history.state?.prpFocus"));
  }

  await click('[data-id=t1] .today-time');
  assert.equal(await focusTitle(), 'Read chapter 3');
  await setTimerLength('1');
  await click('.focus-close');
  await waitForFocusClose();
  assert.equal(await evaluate("document.querySelector('[data-id=t1] .today-time').textContent"), '1 мин');
  await evaluate("window.chimes = 0; const oscillator = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.chimes++; return oscillator.call(this); }");
  const startPoint = await evaluate("(() => { const button = document.querySelector('[data-id=t1] .today-timer .today-icon'); button.scrollIntoView({ block: 'center' }); const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [startPoint] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(() => visible('[data-id=t1] .timer.run'));
  assert.equal(await evaluate("document.querySelector('[data-id=t1] .today-timer .today-icon').textContent"), '⏸');
  await click('[data-id=t1] .today-time');
  assert.equal(await visible('.focus-timer .timer.run'), true);
  await click('.focus-timer .tbtn');
  assert.equal(await visible('.focus-timer .timer.run'), false);
  assert.match(await evaluate("document.querySelector('.focus-timer .today-time').textContent"), /^\d+:\d{2}$/);
  await click('.focus-timer .tbtn');
  assert.equal(await visible('.focus-timer .timer.run'), true);
  await click('.focus-close');
  await waitForFocusClose();
  await evaluate("const realNow = Date.now; Date.now = () => realNow() + 61_000");
  await waitFor(() => evaluate("document.querySelector('dialog[open] h2')?.textContent === 'Отметить выполненным?'"));
  assert.equal(await evaluate('window.chimes'), 2); // the item chime is two short tones
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

  const todoId = 'td-1900000001';
  await click('[data-id=' + todoId + '] summary');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-id=" + todoId + "] .rowmenu button')].map(button => button.textContent)"),
    ['✎ Редактировать', '⤢ Фокус', '💬 Комментарий / блокер', '⭐ Важное']);
  await menu('t4', '⤢ Фокус');
  assert.equal(await focusTitle(), 'Call the plumber');
  await evaluate("document.querySelector('.focus-notes textarea').value = '<b>Saved with completion</b>'");
  await click('.focus-actions .primary');
  await focusIdle();
  assert.equal(await focusTitle(), 'Return library book');
  assert.equal(await visible('.focus-actions button:nth-child(2)[hidden]'), true);
  await click('.focus-actions button:last-child');
  assert.equal(await focusTitle(), 'Read chapter 3');
  assert.equal(await evaluate("document.querySelector('.focus-subtitle').textContent"), 'Read the chapter and write a short summary.');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.focus-links a')].map(link => [link.textContent, link.protocol, link.rel])"),
    [['Chapter notes', 'https:', 'noopener noreferrer']]);
  await click('.focus-actions button:last-child');
  assert.equal(await focusTitle(), 'Draft landing copy');
  await click('.focus-actions button:last-child');
  assert.equal(await focusTitle(), 'Return library book');
  await evaluate("document.querySelector('.focus-notes textarea').value = 'Saved on Back'");
  await evaluate('history.back()');
  await waitForFocusClose();
  assert.equal(await evaluate("document.querySelector('[data-id=" + todoId + "]').textContent.includes('Saved on Back')"), true);
  assert.equal(await evaluate("document.querySelector('[data-id=t4]').textContent.includes('<b>Saved with completion</b>')"), true);
  assert.equal(await visible('[data-id=t4] b'), false);

  await click('[data-id=t2] .today-time');
  await click('.focus-actions button:nth-child(2)');
  await focusIdle();
  assert.equal(await focusTitle(), 'Return library book');
  await click('.focus-actions .primary');
  await focusIdle();
  assert.equal(await focusTitle(), 'Read chapter 3');
  await click('.focus-actions .primary');
  await focusIdle();
  assert.equal(await focusTitle(), 'На сегодня всё');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitForFocusClose();
  await send('Page.reload');
  await waitFor(() => evaluate(ready));

  // Run the new sections through the loopback fixture client, including returning to Today.
  const workIdle = () => waitFor(() => evaluate("document.querySelector('#objects-panel .work-content')?.getAttribute('aria-busy') === 'false'"));
  async function workCapture(name) {
    assert.equal(await evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth'), true);
    await evaluate('document.activeElement.blur(); window.scrollTo(0, 0)');
    await capture('work-' + name, 390, 844);
  }
  const drawer = '.object-drawer';
  const editor = drawer + ' .drawer-editor';
  const field = name => drawer + ' [name=' + name + ']';
  const value = name => evaluate('document.querySelector(' + JSON.stringify(field(name)) + ')?.value');
  const drawerIdle = () => waitFor(() => evaluate(
    "document.querySelector('.object-drawer[open] .drawer-content')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('.drawer-editor textarea')"));
  const escapeDrawer = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(async () => !await visible(drawer + '[open]'));
  };
  const setField = (name, content) => evaluate(
    'document.querySelector(' + JSON.stringify(field(name)) + ').value = ' + JSON.stringify(content));
  const learningLink = '[data-id=t1] a.today-ref';
  await evaluate("localStorage.setItem('prp.theme', 'dark')");
  await send('Page.reload');
  await waitFor(() => evaluate(ready));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`window.drawerOpener = document.querySelector('${learningLink}'); window.scrollTo(0, 160); window.drawerScroll = scrollY`);
  await click(learningLink);
  await drawerIdle();
  assert.match(await evaluate('location.hash'), /^#today\/learning%2F/);
  assert.equal(await visible('#today-panel:not([hidden])'), true);
  assert.equal(await value('title'), 'Sample course');
  await waitFor(() => evaluate("document.querySelector('.object-drawer').getBoundingClientRect().left === 0"));
  assert.deepEqual(await evaluate("(() => { const r = document.querySelector('.object-drawer').getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; })()"),
    [390, 844, 390, 844]);
  assert.equal(await evaluate("Boolean(document.elementFromPoint(10, 10).closest('.object-drawer'))"), true);
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(23, 24, 27)');
  await capture('object-drawer-390-dark', 390, 844, true);
  await setField('next_step', 'Review the next unit');
  await setField('body', (await value('body')) + '\n<b>Learning body update</b>\n');
  await click(editor + ' button[type=submit]');
  await drawerIdle();
  assert.equal(await visible(drawer + ' b'), false);
  await escapeDrawer();
  assert.equal(await evaluate('location.hash'), '#today');
  assert.equal(await evaluate("document.querySelector('[data-id=t1] a.today-ref') === window.drawerOpener"), true);
  assert.equal(await evaluate('document.activeElement === window.drawerOpener'), true, 'focus returns to the original link');
  await waitFor(() => evaluate('scrollY === window.drawerScroll'));
  assert.equal(await evaluate("window.drawerOpener.textContent"), 'Read chapter 3');
  await evaluate('history.forward()');
  await drawerIdle();
  assert.equal(await value('next_step'), 'Review the next unit');
  assert.match(await value('body'), /<b>Learning body update<\/b>/);
  await evaluate(`navigator.clipboard.writeText = async value => { window.drawerClipboard = value; };
    window.open = (url, target, features) => { window.drawerWindow = { url, target, features }; }`);
  await click('.drawer-actions button:nth-child(4)');
  assert.match(await evaluate('window.drawerClipboard'), /learning-20300101-sample-course.*course-builder$/);
  assert.deepEqual(await evaluate('window.drawerWindow'), {
    url: 'https://claude.ai/code', target: '_blank', features: 'noopener,noreferrer',
  });
  await click('.drawer-actions button:nth-child(5)');
  assert.equal(await evaluate('window.drawerClipboard'), 'продолжим learning-20300101-sample-course');
  await evaluate('history.back()');
  await waitFor(async () => !await visible(drawer + '[open]'));

  await click('[data-tab=directions]');
  await waitFor(async () => await evaluate("document.querySelectorAll('.work-tabs button').length") === 5);
  await evaluate("[...document.querySelectorAll('.work-tabs button')].find(button => button.textContent === 'Проекты').click()");
  assert.match(await evaluate("document.querySelector('.work-object').textContent"), /Sample app.*Draft landing copy.*1\/3.*1 дн\. назад/);
  assert.equal(await evaluate("document.querySelector('.work-object progress').value"), 1);
  await workCapture('directions');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await click('.work-object');
  await drawerIdle();
  await waitFor(() => evaluate("document.querySelector('.object-drawer').getBoundingClientRect().left === 620"));
  assert.equal(await evaluate("document.querySelector('.object-drawer').getBoundingClientRect().width"), 660);
  assert.equal(await visible('#objects-panel:not([hidden]) .work-grid'), true);
  assert.equal(await evaluate("document.querySelectorAll('.ptask').length"), 3);
  await capture('object-drawer-1280-dark', 1280, 960, true);
  await setField('goal', 'Draft goal survives checklist changes');
  await evaluate(`(() => {
    const input = document.querySelector('.drawer-tasks > input');
    input.value = '<b>Browser project task</b>';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await drawerIdle();
  assert.equal(await visible('.ptask b'), false);
  assert.equal(await evaluate("document.querySelector('.ptask:last-child label').textContent"), '<b>Browser project task</b>');
  await click('.ptask:last-child button:nth-of-type(2)');
  await drawerIdle();
  assert.equal(await evaluate("document.querySelector('.ptask:nth-child(3) label').textContent"), '<b>Browser project task</b>');
  await click('.ptask:nth-child(2) input');
  await drawerIdle();
  assert.equal(await value('next_step'), '<b>Browser project task</b>');
  assert.equal(await value('goal'), 'Draft goal survives checklist changes');
  await click('.ptask:nth-child(3) button:last-of-type');
  await drawerIdle();
  assert.equal(await value('next_step'), 'Show to 3 people');
  await setField('status', 'paused');
  await click(editor + ' button[type=submit]');
  await drawerIdle();
  await setField('status', 'active');
  await click(editor + ' button[type=submit]');
  await drawerIdle();
  await click('.ptask:nth-child(3) button:first-of-type');
  await drawerIdle();
  await click('.drawer-actions button:nth-child(2)');
  await drawerIdle();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 180, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 180, button: 'left', clickCount: 1 });
  await waitFor(async () => await evaluate("location.hash === '#directions'") && !await visible(drawer + '[open]'));
  assert.equal(await evaluate("document.querySelector('.work-object progress').value"), 2);
  await click('[data-tab=today]');
  await waitFor(() => visible('[data-id^=p-]'));
  assert.match(await evaluate("document.querySelector('[data-id^=p-]').textContent"), /Show to 3 people.*25/);

  await click(learningLink);
  await drawerIdle();
  await click('.drawer-actions button:nth-child(3)');
  await waitFor(() => visible('.codex-draft'));
  assert.equal(await evaluate("document.querySelector('.codex-draft [name=ref]').value"), 'learning-20300101-sample-course');
  await evaluate(`(() => {
    const form = document.querySelector('.codex-draft');
    form.elements.text.value = 'Add a fixture exercise';
    form.elements.done_when.value = 'The fixture exercise is visible';
  })()`);
  await waitFor(() => evaluate("!document.querySelector('.codex-draft .primary').disabled"));
  await click('.codex-draft .primary');
  await waitFor(() => evaluate("document.querySelectorAll('#codex-list [data-codex-id]').length === 2 && document.querySelector('.codex-draft').hidden"));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: url + '?fixtures=1#today/learning%2Flearning-20300101-sample-course.md' });
  await drawerIdle();
  await send('Page.reload');
  await drawerIdle();
  assert.equal(await value('title'), 'Sample course');
  await click('.drawer-close');
  await waitFor(async () => await evaluate("location.hash === '#today'") && !await visible(drawer + '[open]'));

  const fixtureRequests = count => evaluate("document.querySelector('#fixture-requests:not([hidden])')?.dataset.count === '" + count + "'");
  await send('Page.navigate', { url: url + '?fixtures=1&cold=today#today' });
  await waitFor(() => fixtureRequests(4));
  // ideas of the day are not on «Сегодня» any more — they open the «Идеи» tab
  assert.equal(await visible('#today-panel:not([hidden]) .today-daily-ideas:not([hidden])'), false);

  await send('Page.navigate', { url: url + '?fixtures=1&cold=ideas#ideas' });
  await waitFor(() => fixtureRequests(2));
  await waitFor(() => visible('.idea-list .work-idea'));
  await waitFor(() => visible('.daily-ideas .work-daily-idea'));
  await evaluate("const c = document.querySelector('.daily-idea-comment'); c.value = 'Daily owner note'; c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await workIdle();
  await click('.daily-ideas .work-reactions button:nth-child(2)');
  await workIdle();
  assert.equal(await visible('.daily-ideas'), false);
  assert.equal(await evaluate("document.querySelectorAll('.idea-list .work-idea').length"), 2);
  assert.equal(await visible('#today-panel:not([hidden]) .today-daily-ideas:not([hidden])'), false);
  assert.equal(await visible('.idea-list .work-comment'), false);
  assert.match(await evaluate("document.querySelector('.idea-list .work-idea').textContent"), /деньги · Идеи и тесты · новая · от агента.*Риск: Prices/);
  await waitFor(() => evaluate("!document.querySelector('.idea-plan').disabled"));
  await workCapture('ideas');

  await click('.idea-filters [data-status=parked]');
  assert.equal(await evaluate("document.querySelector('.work-idea .work-reactions [aria-pressed=true]').textContent"), '⏸');
  await evaluate(`(() => {
    const select = document.querySelector('.idea-filters select');
    select.value = 'projects';
    select.dispatchEvent(new Event('change'));
  })()`);
  assert.equal(await visible('.work-idea'), false);
  assert.equal(await evaluate("document.querySelector('.idea-filters [data-status=all]').textContent"), 'все (0)');
  await evaluate(`(() => {
    const select = document.querySelector('.idea-filters select');
    select.value = '';
    select.dispatchEvent(new Event('change'));
  })()`);
  await click('.idea-filters [data-status=all]');
  await click('.work-idea .work-reactions button:nth-child(3)');
  await workIdle();
  assert.equal(await evaluate("document.querySelectorAll('.idea-list .work-idea').length"), 1);
  await click('.idea-filters [data-status=killed]');
  assert.equal(await evaluate("document.querySelector('.work-idea .work-reactions [aria-pressed=true]').textContent"), '✕');
  await click('.work-idea .work-reactions button:nth-child(2)');
  await workIdle();
  await click('.idea-filters [data-status=testing]');
  assert.equal(await evaluate("document.querySelector('.work-idea .work-reactions [aria-pressed=true]').textContent"), '🧪');
  await evaluate(`(() => {
    const input = document.querySelector('.idea-edit input');
    input.value = '<b>Owner fixture note</b>';
    input.form.requestSubmit();
  })()`);
  await workIdle();
  await click('.idea-plan');
  await workIdle();
  assert.equal(await evaluate("document.querySelector('.idea-plan').textContent"), 'в плане ✓');
  assert.equal(await evaluate("document.querySelector('.idea-plan').disabled"), true);
  await click('.work-idea h3 a');
  await drawerIdle();
  assert.equal(await value('title'), 'Pocket price checker');
  assert.match(await value('body'), /Комментарии владельца[\s\S]*<b>Owner fixture note<\/b>/);
  assert.equal(await visible(drawer + ' b'), false);
  await click('.drawer-close');
  await waitFor(() => visible('.idea-plan'));
  assert.equal(await evaluate("document.querySelector('.idea-plan').textContent"), 'в плане ✓');
  assert.equal(await evaluate("document.querySelector('.work-idea .work-reactions [aria-pressed=true]').textContent"), '🧪');
  await click('[data-tab=calendar]');
  await waitFor(() => visible('.calendar-detail'));
  assert.match(await evaluate("document.querySelector('.calendar-detail').textContent"), /Buy batteries.*Sort photos.*Water plants/);
  assert.equal(await evaluate("performance.getEntriesByType('resource').some(entry => entry.name.includes('/history/2030-01-14.json.js'))"), false);
  await click('.calendar-day.has-data:not([aria-current])');
  await waitFor(() => evaluate("document.querySelector('.calendar-detail').textContent.includes('Old task')"));
  assert.match(await evaluate("document.querySelector('.calendar-detail').textContent"), /Old task.*Review the draft.*Return a library book/);
  assert.equal(await evaluate("document.querySelector('.calendar-day[aria-pressed=true]').classList.contains('lvl2')"), true);
  await workCapture('calendar');
  await click('.calendar-detail a[href^="#calendar/"]');
  await drawerIdle();
  assert.equal(await value('title'), 'Sample app');
  await escapeDrawer();
  assert.equal(await evaluate("document.querySelector('.calendar-day[aria-pressed=true]').dataset.date"), '2030-01-14');
  await evaluate("const search = document.querySelector('.calendar-search input'); search.value = 'review'; search.dispatchEvent(new Event('input'))");
  await waitFor(() => evaluate("document.querySelector('.calendar-search').textContent.includes('Review December')"));
  assert.match(await evaluate("document.querySelector('.calendar-search').textContent"), /Review the draft.*Review December/);
  await click('[data-tab=ideas]');
  await waitFor(() => visible('.idea-plan'));
  assert.equal(await evaluate("document.querySelector('.idea-plan').textContent"), 'в плане ✓');
  assert.equal(await evaluate('window.lastGitHubRequest'), undefined);

  // Mock real API writes to verify optimistic rendering and rollback without a token or network.
  const files = {};
  for (const file of ['today.json', 'todo.json', 'reminders.json', 'objects.json']) {
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

  await click('[data-id=t1] .today-time');
  await setTimerLength('9');
  await evaluate("document.querySelector('.focus-notes textarea').value = 'One fixture commit'");
  await click('.focus-actions .primary');
  await waitFor(() => evaluate('window.puts.length === 2'));
  assert.deepEqual(await evaluate(`(() => {
    const write = window.puts[1];
    const item = JSON.parse(atob(write.content)).items.find(item => item.id === 't1');
    return [write.message, item.done, item.comment];
  })()`), ['lab: web — complete item', true, 'One fixture commit']);
  await evaluate('window.finishWrite(false)');
  await focusIdle();
  assert.equal(await focusTitle(), 'Read chapter 3');
  assert.equal(await evaluate("document.querySelector('.focus-notes textarea').value"), 'One fixture commit');
  assert.equal(await visible('.focus-view .notice.error:not([hidden])'), true);
  await click('.focus-actions .primary');
  await waitFor(() => evaluate('window.puts.length === 3'));
  await evaluate('window.finishWrite(true)');
  await focusIdle();
  assert.equal(await focusTitle(), 'Draft landing copy');
  await click('.focus-close');
  await waitForFocusClose();
  await send('Page.reload');
  await waitFor(() => evaluate(ready));
  assert.equal(await evaluate("document.querySelector('[data-id=t1] .today-time').textContent"), '9 мин');

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
  assert.equal(await evaluate("document.querySelector('.instant-help p').getClientRects().length"), 0);
  await click('.instant-help summary');
  assert.equal(await evaluate("document.querySelector('.instant-help p').getClientRects().length > 0"), true);
  await click('.instant-help summary');
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
  // Keep the plan day fixed and exercise the actual clock-based tab switch.
  const checkInClock = hour => {
    const RealDate = Date;
    window.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [2030, 0, 15, hour, 30]));
      }
    };
    navigator.clipboard.writeText = async text => { window.checkInClipboard = text; };
  };
  const step = () => evaluate("document.querySelector('.msteps [aria-current=step]')?.textContent");
  const stepButton = index => '.msteps button:nth-child(' + (index + 1) + ')';
  const checkInIdle = () => waitFor(() => evaluate("document.querySelector('.mbody')?.getAttribute('aria-busy') === 'false'"));
  const checkInText = () => evaluate("document.querySelector('.checkin-content').textContent");
  const checkInAction = text => evaluate(`[...document.querySelectorAll('.checkin-content button')]
    .find(button => button.textContent === ${JSON.stringify(text)}).click()`);
  for (const [hour, title, labels] of [
    [10, '☀ Утро', ['Сводка', 'Хвосты', 'Идеи', 'Сборка дня', 'Старт']],
    [22, '🌙 Итоги', ['Итог дня', 'Несделанное', 'Где остановился', 'Тесты', 'Завтра']],
  ]) {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: '(' + checkInClock.toString() + ')(' + hour + ')',
    });
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 });
      await send('Page.navigate', { url: url + '?fixtures=1&checkin=' + hour + '-' + width + '#morning' });
      await waitFor(async () => (await step()) === labels[0]);
      assert.equal(await evaluate("document.querySelector('.tabs a:first-child').textContent"), title);
      assert.equal(await evaluate("document.querySelector('.tabs a:first-child').getAttribute('aria-current')"), 'page');
      assert.equal(await evaluate('document.title'), title + ' · PRP');
      assert.match(await checkInText(), hour === 10 ? /Вчера1 из 1/ : /Сделано1 из 4/);
      if (hour === 10) {
        assert.equal(await evaluate("document.querySelector('.checkin-content a').href"), 'https://example.com/sample-brief');
      }
      await capture(`checkin-${hour === 10 ? 'morning' : 'evening'}-summary-${width}`, width, height);
      for (let index = 1; index < labels.length; index++) {
        await click('.checkin-navigation .primary');
        assert.equal(await step(), labels[index]);
        assert.equal(await evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth'), true);
        if (hour === 10 && index === 2) {
          await click('.checkin-content a[href^="#morning/"]');
          await drawerIdle();
          assert.equal(await value('title'), 'Pocket price checker');
          await escapeDrawer();
          assert.equal(await step(), labels[index]);
          assert.match(await checkInText(), /Pocket price checker/);
          await evaluate("document.querySelector('.checkin-entry input').value = 'Try two shops'; document.querySelector('.checkin-entry').requestSubmit()");
          await checkInIdle();
          assert.equal(await evaluate("document.querySelector('.checkin-entry input').value"), 'Try two shops');
        }
        if (hour === 10 && index === 3) {
          await evaluate('document.activeElement.blur(); window.scrollTo(0, 0)');
          await capture(`checkin-morning-plan-${width}`, width, height);
          await checkInAction('＋ 45 мин');
          await checkInIdle();
          assert.match(await checkInText(), /120 из 180 мин/);
          await checkInAction('📋 скопировать');
          await checkInIdle();
          assert.match(await evaluate('window.checkInClipboard'), /PRP task cx-1900000003/);
          assert.doesNotMatch(await checkInText(), /Add tests/);
        }
        if (hour === 22 && index === 2) {
          await evaluate("document.querySelector('.checkin-entry input').value = 'Continue at chapter four'; document.querySelector('.checkin-entry').requestSubmit()");
          await checkInIdle();
          assert.equal(await evaluate("document.querySelector('.checkin-entry input').value"), 'Continue at chapter four');
          assert.match(await evaluate("document.querySelector('.mbody .notice').textContent"), /Сохранено/);
        }
        if (hour === 22 && index === 3) {
          await checkInAction('＋ завтра · 45 мин');
          await checkInIdle();
        }
        if (hour === 22 && index === 4) {
          assert.match(await checkInText(), /45 из 180 мин.*Sample interviews/);
          await evaluate('document.activeElement.blur(); window.scrollTo(0, 0)');
          await capture(`checkin-evening-tomorrow-${width}`, width, height);
          await checkInAction('✓ Итоги подведены');
          await checkInIdle();
          assert.match(await checkInText(), /Итоги подведены · 22:30/);
        }
      }
      await click('.checkin-navigation button');
      assert.equal(await step(), labels[3]);
      await click(stepButton(0));
      assert.equal(await step(), labels[0]);
      if (hour === 10) {
        await click(stepButton(4));
        await click('.checkin-content a[href="#today/focus"]');
        await waitFor(() => visible('.focus-view[open]'));
        assert.equal(await evaluate("document.querySelector('#focus-title').textContent"), 'Call the plumber');
        await click('.focus-close');
        await waitForFocusClose();
        await click('.tabs a:first-child');
        await waitFor(async () => (await step()) === labels[0]);
        await click(stepButton(4));
        await click('.checkin-content a[href="#today"]');
        await waitFor(() => visible('#today-panel:not([hidden])'));
      }
    }
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
  assert.deepEqual(errors, []);
  if (screenshots) {
    const reference = await readFile(new URL('docs/console-reference.css', root), 'utf8');
    const images = [];
    await send('DOM.enable');
    await send('CSS.enable');
    const routes = [
      ['today', '[data-id=t4]'],
      ['directions', '.work-object'],
      ['ideas', '.idea-list .work-idea'],
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
          assert.equal(await evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth'), true);
          assert.equal(await evaluate(tabInView), true);
          if (route === 'ideas') {
            await waitFor(() => evaluate("!document.querySelector('.idea-plan').disabled"));
            await click('.idea-plan');
            await workIdle();
            await evaluate('document.activeElement.blur(); window.scrollTo(0, 0)');
          }
          const name = 'design-' + route + '-' + width + '-' + theme;
          await capture(name, width, height);
          const html = await evaluate('(' + consoleMarkup.toString() + ')(' + JSON.stringify(route) + ',' + JSON.stringify(theme) + ')');
          if (route === 'today') {
            await click('[data-id=t4] .today-menu summary');
            await waitFor(() => visible('[data-id=t4] .today-menu[open]'));
            await capture('focus-menu-' + width + '-' + theme, width, height);
            await click('[data-id=t4] .today-menu summary');
            await click('[data-id=t1] .today-time');
            await click('.focus-timer .tbtn');
            await waitFor(() => visible('.focus-timer .timer.run'));
            await capture('focus-timer-' + width + '-' + theme, width, height, true);
            await click('.focus-close');
            await waitForFocusClose();
          }
          await send('Page.navigate', { url: 'about:blank' });
          await waitFor(() => evaluate("location.href === 'about:blank'"));
          const { frameTree } = await send('Page.getFrameTree');
          const frameId = frameTree.frame.id;
          await send('Page.setDocumentContent', { frameId, html });
          const { styleSheetId } = await send('CSS.createStyleSheet', { frameId });
          await send('CSS.setStyleSheetText', { styleSheetId, text: reference });
          await capture(name + '-reference', width, height);
          images.push({ route, width, theme, name });
        }
      }
    }
    await writeFile(join(screenshots, 'design-comparison.html'), comparisonHtml(images));
  }
  assert.deepEqual(errors, []);
  console.log('Browser Settings, Today, Directions, Ideas, Calendar, More and Check-in checks passed');
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
