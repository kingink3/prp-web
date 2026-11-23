import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const profile = await mkdtemp(join(tmpdir(), 'prp-browser-'));
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const prefix = '/prp-web/';
const server = createServer(async (request, response) => {
  const path = request.url.startsWith(prefix) ? request.url.slice(prefix.length) || 'index.html' : '';
  const allowed = /^(?:index\.html|manifest\.webmanifest|(?:css|js|icons)\/[\w.-]+)$/.test(path);
  const type = contentTypes[extname(path)];
  if (allowed && type) {
    try {
      const data = await readFile(new URL(path, root));
      response.writeHead(200, { 'Content-Type': type }).end(data);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  response.writeHead(404).end();
});

async function waitFor(fn) {
  for (let attempt = 0; attempt < 100; attempt++) {
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
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(17, 24, 32)');

  await evaluate("location.hash = '#more'");
  await waitFor(() => evaluate("document.title === 'Ещё · PRP'"));
  await evaluate("document.querySelector('.menu-link').click()");
  await waitFor(() => evaluate("document.title === 'Настройки · PRP'"));
  await evaluate("document.querySelector('#theme').value = 'light'; document.querySelector('#theme').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(243, 245, 247)');
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
  console.log('Browser Settings smoke test passed');
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
