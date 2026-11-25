import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getSection, parseChecklist, parseFrontMatter, serializeFrontMatter, setChecklist, setSection, tickChecklist,
} from '../js/frontmatter.js';

const fixtures = new URL('../fixtures/lab/', import.meta.url);
const project = await readFile(new URL('projects/project-20300101-sample-app.md', fixtures), 'utf8');

test('all Markdown fixtures round-trip byte-for-byte', async t => {
  const paths = (await readdir(fixtures, { recursive: true })).filter(path => path.endsWith('.md'));
  assert.ok(paths.length >= 3);
  for (const path of paths) {
    await t.test(path, async () => {
      const bytes = await readFile(new URL(path.replaceAll('\\', '/'), fixtures));
      const doc = parseFrontMatter(bytes.toString('utf8'));
      assert.ok(doc.attributes.id);
      assert.deepEqual(Buffer.from(serializeFrontMatter(doc)), bytes);
    });
  }
});

test('parses documented scalars and lists and preserves unrelated lines on edit', () => {
  const input = [
    '\uFEFF---', '# Metadata', 'created: 2030-01-15', 'title: "Суть: \\"Тест\\" #1"  # keep this',
    "links: ['item, one', 'it''s two', \"# note\"]", 'tags:', '  - one', '# between items', '  - two',
    'resume: false', 'budget_usd: 0', 'rate: +1.5e-1', 'nothing: null', 'empty: []', '---', 'Body without a final newline',
  ].join('\r\n');
  const doc = parseFrontMatter(input);
  assert.deepEqual(doc.attributes, {
    created: '2030-01-15', title: 'Суть: "Тест" #1', links: ['item, one', "it's two", '# note'],
    tags: ['one', 'two'], resume: false, budget_usd: 0, rate: 0.15, nothing: null, empty: [],
  });
  assert.equal(serializeFrontMatter(doc), input);
  doc.attributes.title = 'Что дальше?';
  assert.equal(serializeFrontMatter(doc), input.replace('"Суть: \\"Тест\\" #1"', '"Что дальше?"'));
  doc.attributes.tags.push('три');
  const edited = serializeFrontMatter(doc);
  assert.ok(edited.includes('tags: ["one", "two", "три"]\r\n# between items\r\nresume: false'));
  assert.deepEqual(parseFrontMatter(edited).attributes, doc.attributes);
});

test('updates one section and appends a missing section without altering neighbors', () => {
  const title = 'Где остановился';
  assert.equal(getSection(project, title), 'Name chosen.');
  const updated = setSection(project, title, 'Черновик готов.');
  assert.equal(updated, project.replace('Name chosen.', 'Черновик готов.'));
  assert.equal(setSection(updated, title, 'Черновик готов.'), updated);
  const appended = setSection(project, 'Лог сессий', '- Черновик готов.');
  assert.equal(getSection(appended, 'Лог сессий'), '- Черновик готов.');
  assert.ok(appended.startsWith(project));
});

test('fenced headings and tasks are examples, and trailing line endings stay intact', () => {
  const input = '~~~md\r\n## Задачи\r\n- [ ] Example\r\n~~~\r\n## Задачи\r\n\r\n- [X] Keep\r\n- [ ] Tick\r\n\r\n## Лог\r\nLast';
  assert.deepEqual(parseChecklist(input), [{ text: 'Keep', done: true }, { text: 'Tick', done: false }]);
  assert.equal(tickChecklist(input, 1), input.replace('[ ] Tick', '[x] Tick'));
  assert.equal(setSection(input, 'Лог', 'New'), input.replace(/Last$/, 'New'));
});

test('ticks a fixture task without changing any other lines and supports checklist edits', () => {
  const checklist = parseChecklist(project);
  assert.deepEqual(checklist, [
    { text: 'Pick a name', done: true },
    { text: 'Draft landing copy', done: false },
    { text: 'Show to 3 people', done: false },
  ]);
  const ticked = tickChecklist(project, 1);
  assert.equal(ticked, project.replace('- [ ] Draft landing copy', '- [x] Draft landing copy'));
  assert.equal(tickChecklist(ticked, 1, false), project);
  const next = [checklist[2], { text: 'Добавить задачу', done: false }];
  const edited = setChecklist(project, next);
  assert.deepEqual(parseChecklist(edited), next);
  assert.equal(getSection(edited, 'Где остановился'), getSection(project, 'Где остановился'));
});

test('inline JSON lists of objects (agent-written sources) parse and round-trip', () => {
  const text = '---\nid: "idea-20300115-x"\nstatus: "new"\nsources: [{"url":"https://example.org/a","title":"A, b","date":"2030-01-10"}]\n---\nBody\n';
  const doc = parseFrontMatter(text);
  assert.equal(doc.attributes.sources[0].title, 'A, b');
  assert.equal(serializeFrontMatter(doc), text);
  doc.attributes.status = 'dropped';
  assert.match(serializeFrontMatter(doc), /sources: \[\{"url":"https:\/\/example.org\/a"/);
});
