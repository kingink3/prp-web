import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  addReminder, addTodo, carryDue, clearDone, completeReminder, planGroups, planProgress,
  postpone, removeItem, reorder, setDone, setImportant, setNotes, snooze, splitReminders, unpostpone,
} from '../js/today-data.js';
import { postponedId, reminderId, todoId } from '../js/util.js';

const fixture = async name => JSON.parse(await readFile(new URL('../fixtures/lab/' + name + '.json', import.meta.url)));
const [plan, todo, reminders] = await Promise.all(['today', 'todo', 'reminders'].map(fixture));
const now = new Date('2030-01-15T10:30');

test('toggles plan rows and preserves existing tracked minutes', () => {
  const done = setDone(plan, 'items', 't1', true, now, 20);
  assert.deepEqual(done.items[0], { ...plan.items[0], done: true, done_at: '2030-01-15T10:30', spent: 20 });
  assert.equal(setDone(done, 'items', 't1', true, now, 20), done);
  const reset = setDone(done, 'items', 't1', false, now);
  assert.equal(reset.items[0].done, false);
  assert.equal(reset.items[0].done_at, null);
  assert.equal(reset.items[0].spent, 20);
  assert.equal(plan.items[0].done, undefined);
});

test('postpones, manually restores and carries rows to a new plan', () => {
  const afterMidnight = new Date('2030-01-16T03:59');
  const delayed = postpone(plan, 't4', afterMidnight);
  const added = delayed.postponed.at(-1);
  assert.deepEqual(added, { ...plan.items[3], id: postponedId(afterMidnight), until: '2030-01-16', postponed_on: '2030-01-15' });
  assert.ok(!delayed.items.some(item => item.id === 't4'));
  assert.equal(postpone(delayed, 't4', afterMidnight), delayed);
  const restored = unpostpone(delayed, added.id);
  assert.deepEqual(restored.items.at(-1), { ...plan.items[3], id: added.id });
  assert.deepEqual(restored.postponed, plan.postponed);
  const carried = carryDue({ ...delayed, date: '2030-01-16' });
  assert.equal(carried.postponed.length, 0);
  assert.equal(carried.items.at(-1).carried, true);
});

test('reorders only the selected slots, ignoring deleted or repeated IDs', () => {
  const sorted = reorder(plan, 'items', ['t4', 'missing', 't1', 't1']);
  assert.deepEqual(sorted.items.map(row => row.id), ['t4', 't2', 't3', 't1']);
  const ids = todo.todos.map(item => item.id);
  assert.deepEqual(reorder(todo, 'todos', ids.toReversed()).todos, todo.todos.toReversed());
  assert.equal(reorder(plan, 'items', ['missing']), plan);
});

test('edits notes and importance, and removes only the targeted row', () => {
  const updated = setNotes(plan, 'items', 't4', { comment: ' ', blocker: '  Waiting  ' });
  assert.equal(Object.hasOwn(updated.items[3], 'comment'), false);
  assert.equal(updated.items[3].blocker, 'Waiting');
  assert.equal(setNotes(updated, 'items', 't4', {}), updated);
  const important = setImportant(plan, 'items', 't1', true);
  assert.equal(important.items[0].important, true);
  assert.equal(Object.hasOwn(setImportant(important, 'items', 't1', false).items[0], 'important'), false);
  const notedTodo = setNotes(todo, 'todos', todo.todos[0].id, { comment: 'After lunch' });
  assert.equal(notedTodo.todos[0].comment, 'After lunch');
  assert.deepEqual(removeItem(notedTodo, 'todos', todo.todos[0].id).todos, todo.todos.slice(1));
});

test('adds, toggles and clears to-dos without clearing newly completed rows on a retry', () => {
  const added = addTodo(todo, '  Wash cups  ', now);
  const { id } = added.todos.at(-1);
  assert.deepEqual(added.todos.at(-1), { id: todoId(now), text: 'Wash cups', done: false, created: '2030-01-15' });
  assert.notEqual(addTodo(added, 'Fold towels', now).todos.at(-1).id, id);
  const done = setDone(added, 'todos', id, true, now);
  const oldDone = todo.todos.filter(item => item.done).map(item => item.id);
  assert.equal(setDone(done, 'todos', id, false, now).todos.at(-1).done_at, null);
  const visible = list => list.todos.filter(item => !item.hidden).map(item => item.id);
  assert.deepEqual(visible(clearDone(done, oldDone)), [todo.todos[0].id, id]);
  assert.deepEqual(visible(clearDone(done)), [todo.todos[0].id]);
  assert.equal(clearDone(done).todos.length, done.todos.length);  // hidden, not deleted
  const groups = planGroups(plan, clearDone(done), new Map());
  assert.equal(groups.tasks.some(row => row.item.id === id), false);
  assert.equal(planProgress(groups, plan.date, clearDone(done)).done >= 1, true);
});

test('groups by kind and reference, hides paused and parked cards, and counts planned items', () => {
  const withParked = { ...plan, items: [...plan.items, {
    id: 'parked', kind: 'idea', ref: plan.ideas[0].id, minutes: 60,
  }] };
  const groups = planGroups(withParked, todo, new Map([[plan.items[1].ref, 'paused'], [plan.ideas[0].id, 'parked']]));
  assert.deepEqual(groups.tasks.map(row => row.item.id), ['t4', todo.todos[0].id, 't3', todo.todos[1].id]);
  assert.deepEqual(groups.learning.map(row => row.item.id), ['t1']);
  assert.deepEqual(groups.projects, []);
  assert.deepEqual(planProgress(groups, plan.date), { done: 2, total: 5, timed: 0 });
});

test('adds reminders and separates overdue, today and later entries', () => {
  const added = addReminder(reminders, '  Read  ', '2030-01-14T09:10', 'daily', now);
  assert.deepEqual(added.reminders.at(-1), {
    id: reminderId(now), text: 'Read', at: '2030-01-14T09:10', repeat: 'daily', done: false, created_by: 'web',
  });
  const { due, later } = splitReminders(added, now);
  assert.deepEqual(due.map(item => item.id), [reminderId(now), 'r-1']);
  assert.deepEqual(later.map(item => item.id), ['r-2']);
});

test('completes one-off reminders and advances daily and weekday reminders', () => {
  const oneOff = reminders.reminders[1];
  const completed = completeReminder(reminders, oneOff.id, oneOff.at, now);
  assert.deepEqual(completed.reminders[1], { ...oneOff, done: true, done_at: '2030-01-15T10:30' });
  const friday = '2030-01-18T10:00';
  for (const [repeat, next] of [['daily', '2030-01-19T10:00'], ['weekdays', '2030-01-21T10:00']]) {
    const start = { reminders: [{ ...reminders.reminders[0], at: friday, repeat }] };
    const done = completeReminder(start, 'r-1', friday, new Date('2030-01-18T14:15'));
    assert.deepEqual(done.reminders[0], { ...start.reminders[0], at: next, done_at: null });
    assert.equal(completeReminder(done, 'r-1', friday, now), done);
  }
  const overdue = completeReminder(reminders, 'r-1', reminders.reminders[0].at, new Date('2030-01-21T08:00'));
  assert.equal(overdue.reminders[0].at, '2030-01-21T10:00');
});

test('snoozes from the later of now and the scheduled time', () => {
  const scheduled = reminders.reminders[0].at;
  assert.equal(snooze(reminders, 'r-1', scheduled, 10, now).reminders[0].at, '2030-01-15T10:40');
  assert.equal(snooze(reminders, 'r-2', reminders.reminders[1].at, 60, now).reminders[1].at, '2030-01-20T10:30');
  assert.equal(snooze(reminders, 'r-1', '2030-01-14T09:00', 10, now), reminders);
});

test('a to-do done on an earlier day is not listed', () => {
  const list = { todos: [{ id: 'a', text: 'old', done: true, done_at: '2030-01-14T21:02' }, { id: 'b', text: 'open', done: false }] };
  const groups = planGroups({ date: '2030-01-15', items: [] }, list, new Map());
  assert.deepEqual(groups.tasks.map(row => row.item.id), ['b']);
});
