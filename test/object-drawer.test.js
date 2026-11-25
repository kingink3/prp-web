import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { parseFrontMatter, serializeFrontMatter } from '../js/frontmatter.js';
import { editObject, objectTypes, statusOptions, typeObjectFields } from '../js/objects.js';

const fixtures = new URL('../fixtures/lab/', import.meta.url);
const date = '2030-02-01';
const extension = 'extra-list: [one, "two, three"] # keep this spelling\nx-note: custom\n';

test('every object fixture round-trips and can edit fields and body around unknown front matter', async t => {
  for (const [folder, type] of Object.entries(objectTypes)) {
    const directory = new URL(folder + '/', fixtures);
    const files = (await readdir(directory)).filter(file => file.endsWith('.md'));
    assert.ok(files.length);
    for (const file of files) {
      await t.test(file, async () => {
        const nested = 'vendor:\n  status: archived\n  next_step: unrelated\n';
        const markdown = (await readFile(new URL(file, directory), 'utf8'))
          .replace('---\n', '---\n' + extension).replace('\n---\n', '\n' + nested + '---\n');
        const initial = parseFrontMatter(markdown);
        assert.equal(serializeFrontMatter(initial), markdown);
        const fields = { title: 'Revised title', area: 'custom', purpose: 'useful',
          status: statusOptions[type].at(-1), next_step: 'Check results' };
        for (const key of typeObjectFields[type]) fields[key] = 'Edited ' + key;
        const body = initial.body + '\n## Browser notes\n\n<b>Literal Markdown</b>\n';
        const saved = editObject(markdown, type, { fields, body, previousBody: initial.body }, date);
        const document = parseFrontMatter(saved);
        assert.equal(document.body, body);
        assert.deepEqual(document.attributes, { ...initial.attributes, ...fields, last_touched: date });
        assert.deepEqual(Object.keys(document.attributes).slice(0, Object.keys(initial.attributes).length),
          Object.keys(initial.attributes));
        assert.ok(saved.startsWith('---\n' + extension));
        assert.ok(saved.includes(nested));
      });
    }
  }
});

test('object editor uses the documented lifecycle for each type', () => {
  assert.deepEqual(statusOptions, {
    project: ['active', 'paused', 'blocked', 'done', 'dropped'],
    learning: ['active', 'paused', 'done', 'dropped'],
    idea: ['new', 'liked', 'testing', 'parked', 'done', 'killed'],
    experiment: ['planned', 'running', 'done', 'abandoned'],
  });
  const draft = fields => ({ fields });
  assert.throws(() => editObject('', 'learning', draft({ status: 'blocked' }), date), RangeError);
  assert.throws(() => editObject('', 'project', draft({ id: 'replacement' }), date), TypeError);
  assert.throws(() => editObject('', 'idea', draft({ title: ' ' }), date), RangeError);
});

test('an unchanged textarea preserves body bytes and a changed textarea cannot overwrite a concurrent body edit', () => {
  const markdown = '---\r\ntitle: Test\r\nstatus: active\r\n---\r\n\r\nExisting\r\n';
  assert.equal(parseFrontMatter(editObject(markdown, 'learning', { fields: { next_step: 'Read' } }, date)).body,
    '\r\nExisting\r\n');
  const edited = editObject(markdown, 'learning', { fields: {}, previousBody: '\nExisting\n', body: '\nUpdated\n' }, date);
  assert.equal(parseFrontMatter(edited).body, '\r\nUpdated\r\n');
  assert.throws(() => editObject(edited, 'learning', {
    fields: { next_step: 'Read' }, previousBody: '\nExisting\n', body: '\nConcurrent\n',
  }, date), /body changed/);
});
