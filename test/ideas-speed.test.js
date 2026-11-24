import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getSection, parseFrontMatter } from '../js/frontmatter.js';
import { createGitHubClient } from '../js/github.js';
import { ideaList } from '../js/ideas.js';
import { areasPath, createLabData, indexPath } from '../js/lab-data.js';
import { editIdeaComment, editStatus, objectList, parseAreas, parseObjectIndex } from '../js/objects.js';
import { addIdeaToPlan, ideaInPlan, planPath, reminderPath, todoPath } from '../js/today-data.js';

const fixture = path => readFileSync(new URL('../fixtures/lab/' + path, import.meta.url), 'utf8');
const day = '2030-01-15';
const config = parseAreas(fixture(areasPath));
const entries = parseObjectIndex(fixture(indexPath));
const cards = objectList(entries, config, day);
const project = cards.find(card => card.type === 'project');
const tool = cards.find(card => card.title === 'Pocket price checker');
const notebook = cards.find(card => card.title === 'Recipe notebook');

test('the generated fixture index supplies list metadata and checklist counts without Markdown', () => {
  assert.equal(cards.length, 5);
  assert.deepEqual(project.progress, [1, 3]);
  assert.equal(project.age, 1);
  assert.equal(project.nextStep, 'Draft landing copy');
  assert.equal(project.body, undefined);
  assert.equal(notebook.area, 'hobby');
  assert.equal(tool.attributes.origin, 'agent');
  assert.equal(tool.attributes.main_risk, 'Prices may differ from shelf labels.');
});

test('idea pills count within the area, exclude dropped ideas from all and order newest first', () => {
  const dropped = { ...tool, id: 'dropped', status: 'dropped' };
  const paused = { ...notebook, status: 'paused' };
  const input = [project, paused, tool, dropped];
  const { counts, visible } = ideaList(input, '', 'all');
  assert.deepEqual(counts, { all: 2, new: 1, liked: 0, testing: 0, parked: 1, done: 0, killed: 1 });
  assert.deepEqual(visible, [tool, paused]);
  assert.deepEqual(ideaList(input, '', 'killed').visible, [dropped]);
  assert.deepEqual(ideaList(input, 'hobby', 'parked').visible, [paused]);
  assert.equal(ideaList(input, 'hobby', 'all').counts.new, 0);
});

test('idea status and owner comment edit the Markdown and bump last_touched', () => {
  const markdown = fixture(tool.path);
  const changed = editStatus(markdown, 'idea', 'testing', '2030-01-16');
  assert.equal(parseFrontMatter(changed).attributes.status, 'testing');
  assert.equal(parseFrontMatter(changed).attributes.last_touched, '2030-01-16');
  assert.equal(editStatus(changed, 'idea', 'testing', '2030-01-17'), changed);
  assert.throws(() => editStatus(changed, 'idea', 'active', day), RangeError);
  const commented = editIdeaComment(changed, '  <b>Try two stores</b>   ', '2030-01-17');
  const updated = editIdeaComment(commented, 'Try on a weekday', '2030-01-18');
  assert.equal(parseFrontMatter(updated).attributes.last_touched, '2030-01-18');
  assert.equal(getSection(updated, 'Комментарии владельца'),
    '- 2030-01-18: Try on a weekday\n- 2030-01-17: <b>Try two stores</b>');
  assert.equal(getSection(updated, 'Суть'), getSection(markdown, 'Суть'));
  assert.equal(editIdeaComment(updated, ' ', day), updated);
});

test('only an open reference counts as in the plan and adding an idea is idempotent', () => {
  const at = new Date(day + 'T10:30');
  const plan = JSON.parse(fixture(planPath));
  const before = { ...plan, items: [...plan.items, { ref: tool.id, done: true }] };
  assert.equal(ideaInPlan(before, tool.id), false);
  const after = addIdeaToPlan(before, tool, at);
  assert.equal(ideaInPlan(after, tool.id), true);
  assert.equal(ideaInPlan(after, notebook.id), false);
  assert.deepEqual(after.items.at(-1), {
    id: 'p-' + at.getTime() / 1000, title: tool.title, kind: 'idea', ref: tool.id,
    minutes: 25, done: false, done_at: null,
  });
  assert.equal(addIdeaToPlan(after, tool, at), after);
});

function mockedLab() {
  const snapshots = new Map();
  const storage = {
    getItem: key => snapshots.get(key),
    setItem: (key, value) => snapshots.set(key, value),
    removeItem: key => snapshots.delete(key),
  };
  const files = new Map([indexPath, areasPath, planPath, todoPath, reminderPath]
    .map(path => [path, { text: fixture(path), etag: '"fixture-initial"' }]));
  const requests = [];
  let now = 0;
  const open = (namespace = 'owner/repo:main') => {
    const client = createGitHubClient({ repository: 'owner/repo', token: 'fixture', fetchImpl: async (url, options) => {
      const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
      requests.push({ path, etag: options.headers['If-None-Match'] });
      const file = files.get(path);
      if (!file) return new Response(null, { status: 404 });
      if (file.status) return new Response(null, { status: file.status });
      if (file.wait) await file.wait;
      const headers = { etag: file.etag };
      if (file.etag === options.headers['If-None-Match']) return new Response(null, { status: 304, headers });
      const content = Buffer.from(file.text, 'utf8').toString('base64');
      return Response.json({ type: 'file', encoding: 'base64', sha: file.etag, content }, { headers });
    } });
    return createLabData(client, { namespace, storage, now: () => now });
  };
  return { open, files, requests, advance: ms => { now += ms; } };
}

test('cold Today uses four reads and cold Ideas uses two before the plan; reload reuses persisted ETags', async () => {
  const { open, files, requests } = mockedLab();
  const today = open();
  assert.equal(today.peekObjects(), undefined);
  const firstObjects = today.refreshObjects();
  assert.equal(today.refreshObjects(), firstObjects);
  await Promise.all([firstObjects, ...[planPath, todoPath, reminderPath].map(path => today.refresh(path))]);
  assert.deepEqual(requests.map(request => request.path), [indexPath, planPath, todoPath, reminderPath]);

  const reloaded = open();
  assert.equal(reloaded.peekObjects().find(entry => entry.id === tool.id).status, 'new');
  assert.equal(reloaded.peek(planPath).text, fixture(planPath));
  assert.equal(requests.length, 4);
  const unchanged = await reloaded.refreshObjects();
  assert.deepEqual(unchanged, entries);
  assert.deepEqual(requests.at(-1), { path: indexPath, etag: '"fixture-initial"' });

  files.set(indexPath, { etag: '"fixture-next"', text: JSON.stringify({
    objects: entries.map(entry => entry.id === tool.id ? { ...entry, status: 'liked' } : entry),
  }) });
  const refreshing = reloaded.refreshObjects();
  assert.equal(reloaded.peekObjects().find(entry => entry.id === tool.id).status, 'new');
  const fresh = await refreshing;
  assert.equal(fresh.find(entry => entry.id === tool.id).status, 'liked');
  assert.equal(requests.length, 6);

  const ideas = open('owner/other:main');
  assert.equal(ideas.peekObjects(), undefined);
  await Promise.all([ideas.refreshObjects(), ideas.refresh(areasPath)]);
  assert.deepEqual(requests.slice(6).map(request => request.path), [indexPath, areasPath]);
  await ideas.refresh(planPath);
  assert.equal(requests.length, 9);
});

test('a local object patch survives stale index responses and reload until the index catches up', async () => {
  const { open, files, requests, advance } = mockedLab();
  const lab = open();
  await lab.refreshObjects();
  const markdown = fixture(tool.path);
  lab.patchObject(tool.path, editStatus(markdown, 'idea', 'testing', day));
  const status = data => data.find(entry => entry.id === tool.id).status;
  assert.equal(status(lab.peekObjects()), 'testing');
  assert.equal(status(await lab.refreshObjects()), 'testing');
  const reloaded = open();
  assert.equal(status(reloaded.peekObjects()), 'testing');
  files.set(indexPath, { etag: '"still-stale"', text: fixture(indexPath) });
  assert.equal(status(await reloaded.refreshObjects()), 'testing');
  advance(30_000);
  const generated = next => JSON.stringify({ objects: entries.map(entry =>
    entry.id === tool.id ? { ...entry, status: next } : entry) });
  files.set(indexPath, { etag: '"caught-up"', text: generated('testing') });
  assert.equal(status(await reloaded.refreshObjects()), 'testing');
  files.set(indexPath, { etag: '"external-edit"', text: generated('liked') });
  assert.equal(status(await reloaded.refreshObjects()), 'liked');
  assert.equal(requests.length, 5);
  assert.ok(requests.every(request => request.path === indexPath));
});

test('fallback lists Markdown folders only for a missing index', async () => {
  const { open, files, requests } = mockedLab();
  files.set(indexPath, { status: 403 });
  await assert.rejects(open().refreshObjects(), { status: 403 });
  assert.deepEqual(requests.map(request => request.path), [indexPath]);
  files.delete(indexPath);
  const entries = await open().refreshObjects();
  assert.deepEqual(entries, []);
  assert.deepEqual(requests.slice(1).map(request => request.path), [indexPath, 'projects', 'learning', 'ideas', 'experiments']);
});
