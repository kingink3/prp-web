import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getSection, parseFrontMatter } from '../js/frontmatter.js';
import { appendJournal, journalLine, saveObjectEdit } from '../js/objects.js';
import { completeEvening, isEvening, pickCandidate, previousPlan, resumeSection, saveEveningNote,
  scheduleTest, stepModel, writeResumeNote } from '../js/check-in-data.js';
import { editPlanText } from '../js/today-data.js';

const read = path => readFileSync(new URL('../fixtures/lab/' + path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const plan = json('today.json');
const { todos } = json('todo.json');
const { objects } = json('objects.json');
const { tasks } = json('codex.json');
const previous = json('history/2030-01-14.json');
const [experiment, , idea, learning, project] = objects;
const at = new Date('2030-01-15T22:30');

test('check-in changes mode at 22:00 and 04:00 local time', () => {
  for (const [time, expected] of [['21:59', false], ['22:00', true], ['03:59', true], ['04:00', false]]) {
    assert.equal(isEvening(new Date('2030-01-15T' + time)), expected);
  }
});

test('fixture summaries count plan items, minutes, reactions, archived items and Codex work', () => {
  const model = stepModel(plan, todos, tasks, objects, previous);
  assert.deepEqual(model.stats, { done: 1, total: 4, elapsed: 0, planned: 75, spent: 0 });
  assert.deepEqual(model.previous, { done: 1, total: 1, elapsed: 0, planned: 0, spent: 0,
    date: '2030-01-14', postponed: 1 });
  assert.deepEqual([model.open.length, model.budget, model.learningMinutes, model.waiting.length,
    model.review, model.ready, model.doneTodos, model.merged], [3, 180, 30, 1, 0, 1, 1, 0]);
  assert.equal(model.first.id, 't4');
  assert.equal(model.groupCounts.tasks.total, 2);
  const items = plan.items.map(item => item.done ? { ...item, spent: 17 } : item);
  const extra = stepModel({ ...plan, items }, todos, [...tasks, { status: 'merged', updated: '2030-01-16T02:00' }],
    objects, previous);
  assert.equal(extra.stats.spent, 17);
  assert.equal(extra.merged, 1);
});

test('tails include carried and blocked open items and omit kept or finished rows', () => {
  const items = plan.items.map((item, index) => ({ ...item, carried: index < 3, blocker: index === 3 ? 'Blocked' : '' }));
  assert.deepEqual(stepModel({ ...plan, items }, todos, tasks, objects, previous, new Set(['t1']))
    .tails.map(item => item.id), ['t2', 't4']);
});

test('pick lists deduplicate projects, exclude ideas from candidates and exclude tests with existing experiments', () => {
  const choice = { ref: project.id, title: 'Candidate step', kind: 'project', minutes: 25 };
  const candidates = [choice, { ...choice }, { ref: idea.id, title: idea.title, kind: 'idea' }];
  const modified = { ...plan, items: plan.items.filter(item => item.ref !== project.id), candidates };
  const testing = { ...idea, status: 'testing' };
  const review = [...tasks, { id: 'cx-change', status: 'changes' }, { id: 'cx-review', status: 'review' }];
  let model = stepModel(modified, todos, review, [experiment, testing, learning, project], previous);
  assert.deepEqual(model.candidates, [{ ...choice, task: 'Candidate step' }]);
  assert.deepEqual(model.morningTests.map(row => row.ref), [experiment.id, idea.id]);
  assert.deepEqual(model.codex.map(row => row.id), [tasks[0].id, 'cx-change']);
  assert.equal(model.review, 2);
  model = stepModel({ ...plan, candidates }, todos, review, [{ ...experiment, idea: idea.id }, testing, learning, project]);
  assert.deepEqual(model.candidates, []);
  assert.deepEqual(model.morningTests.map(row => row.ref), [experiment.id]);
});

test('evening refs are unique and exclude routine tracks, completed objects and ideas', () => {
  const items = [...plan.items, { ref: project.id }, { ref: experiment.id }, { ref: idea.id }];
  const modified = { ...plan, items, evening: { notes: [{ ref: project.id, text: 'Saved' }] } };
  const model = stepModel(modified, todos, tasks, [
    { ...learning, resume: false }, { ...experiment, status: 'done' }, project, idea,
  ]);
  assert.deepEqual(model.refs.map(({ id, note }) => [id, note]), [[project.id, 'Saved']]);
});

test('candidate and tomorrow mutations preserve existing data and avoid duplicates on replay', () => {
  const entry = { ref: experiment.id, kind: 'experiment', title: experiment.title, task: experiment.next_step, minutes: 25 };
  const picked = pickCandidate(plan, entry, at);
  const item = picked.items.at(-1);
  assert.match(item.id, /^p-\d+$/);
  assert.deepEqual([item.ref, item.task, item.kind, item.minutes], [experiment.id, experiment.next_step, 'experiment', 25]);
  assert.equal(pickCandidate(picked, entry, at), picked);
  const postponed = scheduleTest(picked, entry, new Date('2030-01-16T02:30'));
  assert.deepEqual(postponed.postponed.at(-1), { id: postponed.postponed.at(-1).id, ref: experiment.id,
    title: experiment.title, task: experiment.next_step, kind: 'experiment', minutes: 45,
    done: false, done_at: null, until: '2030-01-16', postponed_on: '2030-01-15' });
  assert.equal(scheduleTest(postponed, entry, at), postponed);
  const testIdea = { ...idea, reaction: '🧪' };
  const model = stepModel({ ...postponed, ideas: [testIdea] }, todos, tasks, objects, previous);
  assert.deepEqual(model.eveningTests.map(row => row.ref), [idea.id]);
  assert.deepEqual(model.draft.postponed.map(row => row.title), ['Sort photos', experiment.title]);
  assert.equal(model.draft.planned, 45);
  assert.deepEqual(model.draft.projects.map(row => row.task), [project.next_step]);
});

test('resume edits preserve other sections and journal the logical evening date', async () => {
  const note = 'Start with the second draft.';
  const source = read(project.path);
  const updated = writeResumeNote(source, note, plan.date);
  assert.equal(getSection(updated, resumeSection), note);
  assert.equal(parseFrontMatter(updated).attributes.last_touched, plan.date);
  assert.equal(getSection(updated, 'Задачи'), getSection(source, 'Задачи'));
  const stored = saveEveningNote(plan, project.id, note);
  assert.deepEqual(stored.evening.notes, [{ ref: project.id, text: note }]);
  assert.equal(saveEveningNote(stored, project.id, note), stored);
  const afterMidnight = new Date('2030-01-16T02:30');
  const files = new Map([[project.path, source]]);
  await saveObjectEdit({ async update(path, mutate, _, { initial } = {}) {
    const text = mutate(files.get(path) ?? initial);
    files.set(path, text);
    return { text };
  } }, { path: project.path, id: project.id }, (markdown, day) => writeResumeNote(markdown, note, day),
  { at: afterMidnight, day: plan.date, description: note, commit: 'save evening note' });
  assert.equal(files.get(project.path), updated);
  assert.equal(files.get('journal/2030-01-15.md'), appendJournal('', journalLine(afterMidnight, note, project.id)));
  const finished = completeEvening(stored, afterMidnight);
  assert.deepEqual(finished.evening, { notes: stored.evening.notes, done_at: '2030-01-16T02:30' });
  assert.equal(completeEvening(finished, at), finished);
  assert.throws(() => editPlanText('{"date":"2030-01-16"}', plan.date, value => completeEvening(value, at)), RangeError);
});

test('history uses the known index or probes at most seven previous dates without listing', async () => {
  const reads = [];
  const lab = {
    peekHistoryDates: () => ['2030-01-15', '2029-12-31'],
    peek: () => undefined,
    async refresh(path) {
      reads.push(path);
      if (path === 'history/2029-12-31.json') return { text: read(path) };
      throw Object.assign(new Error(), { status: 404 });
    },
  };
  assert.equal((await previousPlan(lab, plan.date)).date, '2029-12-31');
  assert.deepEqual(reads.splice(0), ['history/2029-12-31.json']);
  lab.peekHistoryDates = () => undefined;
  assert.equal(await previousPlan(lab, plan.date), null);
  assert.equal(reads.length, 7);
  assert.equal(reads[0], 'history/2030-01-14.json');
  assert.equal(reads.at(-1), 'history/2030-01-08.json');
});
