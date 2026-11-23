import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createGitHubClient, GitHubError } from '../js/github.js';

const today = await readFile(new URL('../fixtures/lab/today.json', import.meta.url), 'utf8');
const projectPath = 'projects/project-20300101-sample-app.md';
const project = await readFile(new URL('../fixtures/lab/' + projectPath, import.meta.url), 'utf8');
const encode = text => Buffer.from(text, 'utf8').toString('base64');
const file = (text, sha, headers) => Response.json({
  type: 'file', encoding: 'base64', sha, content: encode(text).replace(/.{60}/g, '$&\n'),
}, { headers });

function mockedClient(handler, branch) {
  const calls = [];
  const client = createGitHubClient({
    repository: 'owner/repo', branch, token: 'test-only',
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return handler(calls.at(-1), calls.length - 1);
    },
  });
  return { client, calls };
}

test('Contents API preserves UTF-8 and sends token only in headers', async () => {
  assert.match(project, /Задачи/);
  const { client, calls } = mockedClient(({ method }) =>
    method === 'GET' ? file(project, 'old') : Response.json({ content: { sha: 'new' } }, { status: 200 }),
  'work/next');
  assert.deepEqual(await client.getFile(projectPath), { text: project, sha: 'old' });
  await client.putFile(projectPath, project, 'old', 'lab: web — update project');
  for (const { url, headers, redirect } of calls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(parsed.pathname, '/repos/owner/repo/contents/' + projectPath);
    assert.equal(headers.Authorization, 'Bearer test-only');
    assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(redirect, 'error');
    assert.ok(!url.includes('test-only'));
  }
  assert.equal(new URL(calls[0].url).searchParams.get('ref'), 'work/next');
  assert.deepEqual(JSON.parse(calls[1].body), {
    branch: 'work/next', content: encode(project), sha: 'old', message: 'lab: web — update project',
  });
  await assert.rejects(client.getFile('../today.json'), TypeError);
  assert.equal(calls.length, 2);
});

test('409 and 422 trigger fresh reads and reapply the mutation to the latest SHA', async () => {
  const concurrent = today.replace('"budget_minutes"', '"other_budget_minutes"');
  assert.notEqual(concurrent, today);
  const responses = [
    file(today, 'v1', { etag: '"v1"' }),
    new Response(null, { status: 409 }),
    file(concurrent, 'v2', { etag: '"v2"' }),
    new Response(null, { status: 422 }),
    file(concurrent, 'v3'),
    Response.json({ content: { sha: 'v4' } }),
  ];
  const { client, calls } = mockedClient((_, index) => responses[index]);
  const mutate = text => text.trimEnd() + '\n\n';
  const result = await client.update('today.json', mutate, 'lab: web — update plan');
  assert.deepEqual(result, { text: mutate(concurrent), sha: 'v4' });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT', 'GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(calls.filter(call => call.method === 'PUT').map(call => JSON.parse(call.body).sha), ['v1', 'v2', 'v3']);
  for (const index of [2, 4]) assert.equal(calls[index].headers['If-None-Match'], undefined);
  assert.equal(JSON.parse(calls[5].body).content, encode(mutate(concurrent)));
});

test('a persistent conflict stops after three attempts', async () => {
  const { client, calls } = mockedClient(({ method }) =>
    method === 'GET' ? file(today, 'old') : new Response(null, { status: 422 }));
  await assert.rejects(client.update('today.json', text => text + '\n', 'lab: web — update plan'),
    { name: 'GitHubError', status: 422 });
  assert.equal(calls.length, 6);
});

test('ETag revalidation reuses the cached file on 304 and invalidates it after a write', async () => {
  const expiration = '2030-01-20 10:00:00 UTC';
  const responses = [
    file(today, 'old', { etag: '"today-1"', 'github-authentication-token-expiration': expiration }),
    new Response(null, { status: 304 }),
    Response.json({ content: { sha: 'new' } }),
    file(today, 'new', { etag: '"today-2"' }),
  ];
  const { client, calls } = mockedClient((_, index) => responses[index]);
  const first = await client.getFile('today.json');
  assert.equal(new URL(calls[0].url).searchParams.get('ref'), 'main');
  assert.deepEqual(await client.getFile('today.json'), first);
  assert.equal(client.tokenExpiration, expiration);
  assert.equal(calls[1].headers['If-None-Match'], '"today-1"');
  await client.putFile('today.json', today, 'old', 'lab: web — update plan');
  assert.equal((await client.getFile('today.json')).sha, 'new');
  assert.equal(calls[3].headers['If-None-Match'], undefined);
});

test('directory reads are cached and a caller cannot change cached data', async () => {
  const entries = [{ name: 'today.json', type: 'file', sha: 'old' }];
  const { client, calls } = mockedClient((_, index) => index === 0
    ? Response.json(entries, { headers: { etag: '"root"' } })
    : new Response(null, { status: 304 }));
  const result = await client.listDir();
  result[0].sha = 'modified';
  assert.deepEqual(await client.listDir(), entries);
  assert.equal(calls[1].headers['If-None-Match'], '"root"');
});

test('failed reads preserve status for the Settings screen', async () => {
  for (const status of [401, 403, 404]) {
    const { client } = mockedClient(() => new Response(null, { status }));
    await assert.rejects(client.getFile('today.json'), error => error instanceof GitHubError && error.status === status);
  }
});
