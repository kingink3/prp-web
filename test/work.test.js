import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bodySections, getSection, parseChecklist, parseFrontMatter, serializeFrontMatter } from '../js/frontmatter.js';
import { adjacentMonth, currentHistoryDay, historyDates, monthCells, parseHistoryDay, searchHistory } from '../js/history.js';
import { appendJournal, editChecklist, editStatus, journalLine, loadObjects, objectCard, parseAreas,
  saveObjectEdit, taskReference } from '../js/objects.js';
import { addObjectToPlan, editDailyIdea } from '../js/today-data.js';

const fixture = path => readFile(new URL('../fixtures/lab/' + path, import.meta.url), 'utf8');
const projectPath = 'projects/project-20300101-sample-app.md';
const experimentPath = 'experiments/experiment-20300115-sample-interview.md';
const day = '2030-01-15';
const now = new Date(day + 'T10:30');
const project = await fixture(projectPath);
const config = parseAreas(await fixture('config/areas.yaml'));

test('builds cards from fixture front matter, areas and checklist', async () => {
  assert.deepEqual(config.areas.map(area => area.id), ['learning', 'projects', 'ideas', 'content', 'hobby']);
  const card = objectCard(projectPath, project, config, day);
  assert.equal(card.title, 'Sample app');
  assert.equal(card.status, 'active');
  assert.equal(card.nextStep, 'Draft landing copy');
  assert.deepEqual(card.progress, [1, 3]);
  assert.equal(card.age, 1);
  assert.equal(card.area, 'projects');
  assert.equal(bodySections(card.body)[0].title, 'Цель');
  const client = {
    listDir: async folder => folder === 'experiments' ? [
      { type: 'file', name: experimentPath.split('/')[1] }, { type: 'dir', name: 'nested.md' },
      { type: 'file', name: 'README.txt' }, { type: 'file', name: '../unsafe.md' },
    ] : Promise.reject({ status: 404 }),
    getFile: async path => ({ text: await fixture(path) }),
  };
  const [experiment] = await loadObjects(client, ['experiments', 'ideas'], config, day);
  assert.equal(experiment.area, 'ideas');
  assert.equal(experiment.age, 0);
  assert.equal(experiment.progress, null);
  const block = parseAreas('areas:\n- id: example\n  title: "Example, with a comma" # note\ndefaults:\n  project: example\n');
  assert.deepEqual(block.areas, [{ id: 'example', title: 'Example, with a comma' }]);
  assert.equal(block.defaults.project, 'example');
});

test('adds, raises, ticks and removes project tasks while preserving other Markdown', () => {
  const added = editChecklist(project, { kind: 'add', text: '  Check examples  ' }, day);
  const reference = (text, index) => taskReference(parseChecklist(text), index);
  const raised = editChecklist(added, { kind: 'up', task: reference(added, 3), previous: reference(added, 2) }, day);
  assert.deepEqual(parseChecklist(raised).map(task => task.text),
    ['Pick a name', 'Draft landing copy', 'Check examples', 'Show to 3 people']);
  const ticked = editChecklist(raised, { kind: 'tick', task: reference(raised, 1), done: true }, day);
  assert.equal(parseFrontMatter(ticked).attributes.next_step, 'Check examples');
  const removed = editChecklist(ticked, { kind: 'remove', task: reference(ticked, 2) }, day);
  let final = editChecklist(removed, { kind: 'tick', task: reference(removed, 2), done: true }, day);
  assert.equal(parseFrontMatter(final).attributes.next_step, '');
  final = editChecklist(final, { kind: 'tick', task: reference(final, 0), done: false }, day);
  assert.equal(parseFrontMatter(final).attributes.next_step, 'Pick a name');
  assert.equal(parseFrontMatter(final).attributes.last_touched, day);
  assert.equal(getSection(final, 'Цель'), getSection(project, 'Цель'));
  assert.equal(getSection(final, 'Где остановился'), getSection(project, 'Где остановился'));
  assert.equal(serializeFrontMatter(parseFrontMatter(final)), final);
  assert.throws(() => editChecklist(removed, { kind: 'remove', task: reference(ticked, 2) }, day), RangeError);
  const paused = editStatus(final, 'project', 'paused', day);
  assert.equal(parseFrontMatter(paused).attributes.status, 'paused');
  assert.equal(editStatus(paused, 'project', 'paused', day), paused);
});

test('appends one journal line and preserves the original line endings', () => {
  const line = journalLine(now, 'Edited a\nchecklist', 'project-fixture');
  assert.equal(line, '- 10:30 [owner] Edited a checklist (project-fixture)');
  assert.equal(appendJournal('', line), line + '\n');
  assert.equal(appendJournal('# Journal\r\n- Existing', line), '# Journal\r\n- Existing\r\n' + line + '\r\n');
  assert.equal(appendJournal('- Existing\n', line), '- Existing\n' + line + '\n');
});

test('saves the object before journalling, then retries only the journal after a failure', async () => {
  const card = objectCard(projectPath, project, config, day);
  const path = 'journal/' + day + '.md';
  const files = new Map([[projectPath, project]]);
  const writes = [];
  let failJournal = true;
  const client = { async update(path, mutate, message, { initial } = {}) {
    const before = files.get(path) ?? initial;
    const text = mutate(before);
    if (text !== before) {
      files.set(path, text);
      writes.push([path, message]);
    }
    if (path.startsWith('journal/') && failJournal) throw new Error('Lost response after commit');
    return { text };
  } };
  const options = { at: now, description: 'Paused', commit: 'object status' };
  const result = await saveObjectEdit(client, card, (text, date) => editStatus(text, 'project', 'paused', date), options);
  assert.deepEqual(writes, [[projectPath, 'lab: web — object status'], [path, 'lab: web — journal object status']]);
  failJournal = false;
  await result.saveJournal();
  assert.equal(writes.length, 2);
  assert.equal(files.get(path), journalLine(now, 'Paused', card.id) + '\n');
  await saveObjectEdit(client, card, (text, date) => editStatus(text, 'project', 'paused', date), options);
  assert.equal(writes.length, 2);
});

test('updates only the selected idea and adds a typed 30-minute plan item with the exact next step', async () => {
  const plan = JSON.parse(await fixture('today.json'));
  const idea = plan.ideas[0];
  const reacted = editDailyIdea(plan, idea, { reaction: 'test' });
  const commented = editDailyIdea(reacted, idea, { comment: '<b>Owner note</b>' });
  assert.deepEqual(commented.ideas[0], { ...idea, reaction: 'test', comment: '<b>Owner note</b>' });
  assert.equal(editDailyIdea(commented, idea, { comment: '' }).ideas[0].comment, undefined);
  assert.equal(commented.items, plan.items);
  const card = objectCard(projectPath, project, config, day);
  const updated = addObjectToPlan(commented, card, now);
  assert.deepEqual(updated.items.at(-1), { id: 'p-' + Math.floor(now / 1000), title: card.nextStep,
    kind: 'project', ref: card.id, minutes: 30, task: card.nextStep, done: false, done_at: null });
  assert.notEqual(addObjectToPlan(updated, card, now).items.at(-1).id, updated.items.at(-1).id);
});

test('parses archived and current days, searches visible rows newest first and handles month boundaries', async () => {
  const oldDay = '2029-12-31';
  const otherDay = '2030-01-14';
  const paths = [otherDay, oldDay].map(date => date + '.json');
  assert.deepEqual(historyDates([...paths, '2030-02-30.json', 'README.md', ...paths]), [otherDay, oldDay]);
  const archive = await Promise.all([oldDay, otherDay].map(async date =>
    parseHistoryDay(await fixture('history/' + date + '.json'), date)));
  assert.equal(archive[1].done[0].title, 'Old task');
  assert.equal(archive[1].postponed[0].title, 'Review the draft');
  assert.equal(archive[1].todos[0].text, 'Return a library book');
  const matches = searchHistory(archive, ' REVIEW ');
  assert.deepEqual(matches.map(result => result.date), [otherDay, oldDay]);
  assert.deepEqual(matches.map(result => result.rows[0].title), ['Review the draft', 'Review December']);
  assert.deepEqual(searchHistory(archive, 'LIBRARY book')[0].rows, archive[1].todos);
  const plan = JSON.parse(await fixture('today.json'));
  const todoList = JSON.parse(await fixture('todo.json'));
  assert.deepEqual(currentHistoryDay(plan, todoList).todos.map(todo => todo.text), ['Water plants']);
  assert.deepEqual(searchHistory([currentHistoryDay(plan, todoList)], 'Read chapter'), []);
  assert.equal(adjacentMonth('2029-12', 1), '2030-01');
  assert.equal(monthCells('2030-01')[0], null);
  assert.equal(monthCells('2030-01')[1], '2030-01-01');
  assert.equal(monthCells('2032-02').filter(Boolean).length, 29);
});
