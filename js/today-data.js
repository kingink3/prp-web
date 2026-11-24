import { eveningDate, localIsoMinutes, postponedId, reminderId, today, todoId, tomorrow } from './util.js';

export const planPath = 'today.json';
export const todoPath = 'todo.json';
export const reminderPath = 'reminders.json';
export const emptyLists = { [todoPath]: { todos: [] }, [reminderPath]: { reminders: [] } };

function change(data, key, id, edit) {
  const list = data[key] ?? [];
  const index = list.findIndex(item => item.id === id);
  if (index < 0) return data;
  const next = edit(list[index]);
  if (next === list[index]) return data;
  return { ...data, [key]: list.toSpliced(index, 1, ...(next ? [next] : [])) };
}

function uniqueId(list, id) {
  const dash = id.lastIndexOf('-');
  let stamp = Number(id.slice(dash + 1));
  while (list.some(item => item.id === id)) id = id.slice(0, dash + 1) + ++stamp;
  return id;
}

export function setDone(data, key, id, done, at, spent = 0) {
  return change(data, key, id, item => {
    if (Boolean(item.done) === done) return item;
    const result = { ...item, done, done_at: done ? localIsoMinutes(at) : null };
    if (done && spent > 0) result.spent = (item.spent ?? 0) + spent;
    return result;
  });
}

export function setImportant(data, key, id, important) {
  return change(data, key, id, item => {
    if (Boolean(item.important) === important) return item;
    const next = { ...item };
    if (important) next.important = true;
    else delete next.important;
    return next;
  });
}

export function setNotes(data, key, id, notes) {
  return change(data, key, id, item => {
    const next = { ...item };
    for (const field of ['comment', 'blocker']) {
      if (!Object.hasOwn(notes, field)) continue;
      const text = notes[field].trim();
      if (text) next[field] = text;
      else delete next[field];
    }
    return Object.keys(next).length === Object.keys(item).length &&
      next.comment === item.comment && next.blocker === item.blocker ? item : next;
  });
}

// ✎ edit: the visible text (`title` of a plan item, `text` of a to-do) and the planned minutes of a plan item.
export function setText(data, key, id, { text, minutes } = {}) {
  return change(data, key, id, item => {
    const field = Object.hasOwn(item, 'title') ? 'title' : 'text';
    const next = { ...item };
    const value = String(text ?? '').trim().slice(0, 300);
    if (value) next[field] = value;
    const mins = Number(minutes);
    if (field === 'title' && Number.isInteger(mins) && mins >= 1 && mins <= 600) next.minutes = mins;
    return next[field] === item[field] && next.minutes === item.minutes ? item : next;
  });
}

export const removeItem = (data, key, id) => change(data, key, id, () => null);

export function addObjectToPlan(data, card, at) {
  const items = data.items ?? [];
  const id = uniqueId([...items, ...(data.postponed ?? [])], 'p-' + Math.floor(at.getTime() / 1000));
  const task = card.nextStep ?? '';
  return { ...data, items: [...items, {
    id, title: task || card.title, kind: card.type, ref: card.id, minutes: 30, task,
    done: false, done_at: null,
  }] };
}

export const ideaInPlan = (plan, id) => (plan.items ?? []).some(item => item.ref === id && !item.done);

export function addIdeaToPlan(plan, card, at) {
  if (ideaInPlan(plan, card.id)) return plan;
  const items = plan.items ?? [];
  const id = uniqueId([...items, ...(plan.postponed ?? [])], 'p-' + Math.floor(at.getTime() / 1000));
  return { ...plan, items: [...items, {
    id, title: card.title, kind: 'idea', ref: card.id, minutes: 25, done: false, done_at: null,
  }] };
}

export function editDailyIdea(data, idea, patch) {
  const ideas = data.ideas ?? [];
  const index = ideas.findIndex(entry => (entry.id ?? entry.ref) === (idea.id ?? idea.ref));
  if (index < 0) throw new RangeError('The idea is no longer in the plan');
  const current = ideas[index];
  const next = { ...current, ...patch };
  if (Object.hasOwn(patch, 'comment') && !patch.comment) delete next.comment;
  if (current.reaction === next.reaction && current.comment === next.comment) return data;
  return { ...data, ideas: ideas.toSpliced(index, 1, next) };
}

export function postpone(data, id, at) {
  const item = data.items.find(entry => entry.id === id);
  if (!item) return data;
  const date = eveningDate(at);
  const until = tomorrow(new Date(date + 'T12:00'));
  const postponed = data.postponed ?? [];
  const nextId = uniqueId([...data.items, ...postponed], postponedId(at));
  return {
    ...removeItem(data, 'items', id),
    postponed: [...postponed, { ...item, id: nextId, until, postponed_on: date }],
  };
}

export function unpostpone(data, id, carried = false) {
  const item = data.postponed?.find(entry => entry.id === id);
  if (!item) return data;
  const { until, postponed_on, ...rest } = item;
  return {
    ...removeItem(data, 'postponed', id),
    items: [...data.items, carried ? { ...rest, carried: true } : rest],
  };
}

export function carryDue(data) {
  return (data.postponed ?? []).filter(item => item.until <= data.date)
    .reduce((plan, item) => unpostpone(plan, item.id, true), data);
}

// Replace only the requested slots, including after concurrent insertions or deletions.
export function reorder(data, key, ids) {
  const list = data[key] ?? [];
  const byId = new Map(list.map(item => [item.id, item]));
  const ordered = [...new Set(ids)].filter(id => byId.has(id));
  const slots = new Set(ordered);
  let index = 0;
  const next = list.map(item => slots.has(item.id) ? byId.get(ordered[index++]) : item);
  return next.some((item, index) => item !== list[index]) ? { ...data, [key]: next } : data;
}

export function addTodo(data, text, at) {
  const todos = data.todos ?? [];
  text = text.trim();
  if (!text) return data;
  return { ...data, todos: [...todos, { id: uniqueId(todos, todoId(at)), text, done: false, created: today(at) }] };
}

export function clearDone(data, ids) {
  const selected = ids && new Set(ids);
  const todos = data.todos.filter(item => !item.done || (selected && !selected.has(item.id)));
  return todos.length === data.todos.length ? data : { ...data, todos };
}

export function addReminder(data, text, at, repeat, now) {
  const reminders = data.reminders ?? [];
  text = text.trim();
  if (!text) return data;
  return { ...data, reminders: [...reminders, {
    id: uniqueId(reminders, reminderId(now)), text, at, repeat, done: false, created_by: 'web',
  }] };
}

function nextOccurrence(at, repeat, now) {
  const limit = localIsoMinutes(now);
  const time = at.slice(11, 16);
  const day = new Date(at.slice(0, 10) + 'T12:00');
  const todayAtNoon = new Date(today(now) + 'T12:00');
  day.setDate(day.getDate() + 1);
  if (day < todayAtNoon) day.setTime(todayAtNoon.getTime());
  while ((repeat === 'weekdays' && (day.getDay() === 0 || day.getDay() === 6)) || today(day) + 'T' + time <= limit) {
    day.setDate(day.getDate() + 1);
  }
  return today(day) + 'T' + time;
}

export function completeReminder(data, id, occurrence, now) {
  return change(data, 'reminders', id, item => {
    if (item.done || item.at !== occurrence) return item;
    if (item.repeat === 'daily' || item.repeat === 'weekdays') {
      return { ...item, at: nextOccurrence(item.at, item.repeat, now), done: false, done_at: null };
    }
    return { ...item, done: true, done_at: localIsoMinutes(now) };
  });
}

export function snooze(data, id, occurrence, minutes, now) {
  return change(data, 'reminders', id, item => {
    if (item.done || item.at !== occurrence) return item;
    const start = Math.max(now.getTime(), new Date(item.at).getTime());
    return { ...item, at: localIsoMinutes(new Date(start + minutes * 60_000)) };
  });
}

const objectFolders = { project: 'projects', experiment: 'experiments', idea: 'ideas', learning: 'learning' };

export function referencePath(ref) {
  if (typeof ref !== 'string' || !/^(?:project|experiment|idea|learning)-[\w-]+$/.test(ref)) return null;
  return objectFolders[ref.split('-')[0]] + '/' + ref + '.md';
}

export const rowRank = item => item.done ? 2 : item.important ? 0 : 1;

export function planGroups(plan, todoList, statuses) {
  const groups = { tasks: [], learning: [], projects: [] };
  for (const item of plan.items) {
    if (['paused', 'parked'].includes(statuses.get(item.ref))) continue;
    const path = referencePath(item.ref);
    const group = item.kind === 'learning' ? 'learning' : path && !path.startsWith('learning/') ? 'projects' : 'tasks';
    groups[group].push({ item, path: planPath, key: 'items' });
  }
  for (const item of todoList.todos) groups.tasks.push({ item, path: todoPath, key: 'todos' });
  for (const group of Object.values(groups)) group.sort((a, b) => rowRank(a.item) - rowRank(b.item));
  return groups;
}

export function rowActions({ item, path }) {
  if (item.done) return [];
  const actions = ['edit', 'focus', 'notes', item.important ? 'unimportant' : 'makeImportant'];
  if (path === planPath) actions.push('postpone');
  return actions;
}

export function focusOrder({ tasks, learning, projects }) {
  return [
    ...tasks.filter(row => row.path === planPath),
    ...tasks.filter(row => row.path === todoPath),
    ...learning,
    ...projects,
  ].filter(row => !row.item.done);
}

export function focusItemKey(row) {
  return JSON.stringify([row.path, row.item.id]);
}

// Start after the selected item and wrap past the last item, using the latest open rows.
export function nextFocusRow(before, current, after) {
  const key = focusItemKey(current);
  const index = before.findIndex(row => focusItemKey(row) === key);
  const remaining = new Map(after.map(row => [focusItemKey(row), row]));
  remaining.delete(key);
  for (const row of [...before.slice(index + 1), ...before.slice(0, Math.max(index, 0))]) {
    const next = remaining.get(focusItemKey(row));
    if (next) return next;
  }
  return remaining.values().next().value ?? null;
}

// «Сделано»: plan items + to-dos (open, or done on `day`) by count; minutes only from timers (`spent`).
export function planProgress(groups, day) {
  const items = Object.values(groups).flat().filter(row => row.path === planPath ||
    (row.path === todoPath && (!row.item.done || !day || String(row.item.done_at ?? '').startsWith(day)))).map(row => row.item);
  const done = items.filter(item => item.done);
  const timed = items.reduce((sum, item) => sum + (Number(item.spent) || 0), 0);
  return { done: done.length, total: items.length, timed };
}

export function splitReminders(data, now) {
  const localDay = today(now);
  const open = data.reminders.filter(item => !item.done).sort((a, b) => a.at.localeCompare(b.at));
  return { due: open.filter(item => item.at.slice(0, 10) <= localDay), later: open.filter(item => item.at.slice(0, 10) > localDay) };
}
