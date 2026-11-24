import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTimerStore } from '../js/timers.js';
import { focusOrder, nextFocusRow, planGroups, planPath, postpone, rowActions, setDone, todoPath } from '../js/today-data.js';

const fixtures = new URL('../fixtures/lab/', import.meta.url);
const plan = JSON.parse(await readFile(new URL(planPath, fixtures), 'utf8'));
const todos = JSON.parse(await readFile(new URL(todoPath, fixtures), 'utf8'));
const at = new Date(plan.date + 'T10:30');
const order = (daily = plan, list = todos, states = new Map()) => focusOrder(planGroups(daily, list, states));
const ids = rows => rows.map(row => row.item.id);

test('open plan rows offer four menu actions and to-dos omit postponing and copying to ideas', () => {
  const [task, todo, learning, project] = order();
  assert.deepEqual(rowActions(task), ['edit', 'focus', 'notes', 'unimportant', 'postpone']);
  for (const row of [learning, project]) assert.deepEqual(rowActions(row), ['edit', 'focus', 'notes', 'makeImportant', 'postpone']);
  assert.deepEqual(rowActions(todo), ['edit', 'focus', 'notes', 'makeImportant']);
  assert.deepEqual(rowActions({ ...task, item: { ...task.item, done: true } }), []);
});

test('focus visits open tasks, to-dos, learning, projects and ignores paused refs and done items', () => {
  const importantTodo = { todos: [{ ...todos.todos[0], important: true }, todos.todos[1]] };
  const ordinaryTask = { ...plan, items: plan.items.map(item => ({ ...item, important: false })) };
  const paused = new Map([[plan.items[0].ref, 'paused']]);
  const grouped = planGroups(ordinaryTask, importantTodo, paused);
  assert.equal(grouped.tasks[0].path, todoPath);
  assert.deepEqual(ids(focusOrder(grouped)), ['t4', todos.todos[0].id, 't2']);
  assert.deepEqual(ids(order()), ['t4', todos.todos[0].id, 't1', 't2']);
});

test('focus advances after completion or postponing, wraps after skipping the last, and reaches the end', () => {
  const before = order();
  const [task, todo, learning, project] = before;
  const finished = setDone(plan, 'items', 't4', true, at);
  assert.equal(nextFocusRow(before, task, order(finished)).item.id, todo.item.id);
  assert.equal(nextFocusRow(before, todo, before), learning);
  assert.equal(nextFocusRow(before, project, before), task);
  assert.equal(nextFocusRow(before, project, order(postpone(plan, project.item.id, at))).item.id, task.item.id);
  assert.equal(nextFocusRow(before, project, []), null);
  assert.equal(nextFocusRow([project], project, [project]), null);
});

test('timer lengths default to twenty minutes and reload separately per item', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const store = createTimerStore(storage);
  const taskKey = JSON.stringify(['owner/repo', planPath, plan.date, 't4']);
  const todoKey = JSON.stringify(['owner/repo', todoPath, null, todos.todos[0].id]);
  assert.equal(store.get(taskKey).minutes, 20);
  store.configure(taskKey, 5);
  store.configure(todoKey, 13);
  const reloaded = createTimerStore(storage);
  assert.deepEqual(reloaded.get(taskKey), { minutes: 5 });
  assert.deepEqual(reloaded.get(todoKey), { minutes: 13 });
  assert.deepEqual(reloaded.get('different item'), { minutes: 20 });
});

import { setText } from '../js/today-data.js';
test('✎ edit changes the visible text and planned minutes only', () => {
  const plan = { items: [{ id: 'a', title: 'Old', minutes: 45 }] };
  assert.deepEqual(setText(plan, 'items', 'a', { text: ' New ', minutes: '30' }).items[0], { id: 'a', title: 'New', minutes: 30 });
  assert.equal(setText(plan, 'items', 'a', { text: '   ' }), plan);
  const todos = { todos: [{ id: 't', text: 'Old' }] };
  assert.deepEqual(setText(todos, 'todos', 't', { text: 'New', minutes: '30' }).todos[0], { id: 't', text: 'New' });
});
