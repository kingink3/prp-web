import { parseFrontMatter, serializeFrontMatter } from './frontmatter.js';
import { createTimers } from './timers.js';
import { strings } from './strings.js';
import { localIsoMinutes, today } from './util.js';
import {
  addReminder, addTodo, carryDue, clearDone, completeReminder, emptyLists, planGroups, planPath,
  planProgress, referencePath, reminderPath, removeItem, reorder, rowRank, setDone, setImportant,
  setNotes, snooze, splitReminders, todoPath, unpostpone, postpone,
} from './today-data.js';

const s = strings.todayView;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function button(text, action, { label, className, disabled } = {}) {
  const node = el('button', text, className);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  node.disabled = Boolean(disabled);
  node.addEventListener('click', action);
  return node;
}

function input(type, label) {
  const node = el('input');
  node.type = type;
  node.setAttribute('aria-label', label);
  return node;
}

function formControl(label, control) {
  const node = el('label', label, 'today-field');
  node.append(control);
  return node;
}

const json = data => JSON.stringify(data, null, 2) + '\n';
const dayLabel = date => date.slice(8, 10) + '.' + date.slice(5, 7) + '.' + date.slice(0, 4);
const atLabel = at => dayLabel(at) + ' · ' + at.slice(11, 16);

export function createTodayView(panel, { fixture, onResponse }) {
  const heading = el('div', undefined, 'today-heading');
  const titleGroup = el('div');
  const date = el('p', undefined, 'today-date');
  titleGroup.append(el('h1', strings.today), date);
  const refreshButton = button('⟳', () => refresh(), { label: s.refresh, className: 'today-icon' });
  heading.append(titleGroup, refreshButton);
  const toast = el('p', undefined, 'today-toast');
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  const status = el('div', undefined, 'today-status');
  status.setAttribute('role', 'status');
  const body = el('div', undefined, 'today-grid');
  const progress = el('progress');
  progress.setAttribute('aria-label', s.progress);
  const count = el('p', undefined, 'today-count');
  const summary = el('div', undefined, 'today-summary');
  summary.append(count, progress);
  const plan = el('div', undefined, 'today-column');
  plan.append(summary);
  const groups = {};
  for (const name of ['tasks', 'learning', 'projects']) {
    const section = el('section', undefined, 'today-card');
    const rows = el('ul', undefined, 'today-rows');
    const empty = el('p', s.emptyGroup, 'today-muted');
    section.append(el('h2', s[name]), rows, empty);
    plan.append(section);
    groups[name] = { section, rows, empty };
  }

  const todoForm = el('form', undefined, 'today-form todo-form');
  const todoInput = input('text', s.todoInput);
  todoInput.placeholder = s.todoInput;
  todoInput.required = true;
  const addTodoButton = el('button', s.add);
  addTodoButton.type = 'submit';
  todoForm.append(todoInput, addTodoButton);
  const clearButton = button(s.clearDone, () => {
    const ids = data[todoPath].todos.filter(item => item.done).map(item => item.id);
    apply(todoPath, list => clearDone(list, ids), 'clear completed to-dos');
  }, { className: 'today-text-button' });
  groups.tasks.section.append(todoForm, clearButton);

  const postponedPanel = el('details', undefined, 'today-card');
  const postponedTitle = el('summary');
  const postponedRows = el('ul', undefined, 'today-rows');
  postponedPanel.append(postponedTitle, postponedRows);
  plan.append(postponedPanel);

  const aside = el('aside', undefined, 'today-column');
  const reminders = el('section', undefined, 'today-card');
  const reminderRows = el('ul', undefined, 'today-rows');
  const laterLabel = el('p', undefined, 'today-muted');
  const reminderForm = el('form', undefined, 'today-form reminder-form');
  const reminderText = input('text', s.reminderText);
  reminderText.required = true;
  reminderText.placeholder = s.reminderText;
  const reminderAt = input('datetime-local', s.when);
  reminderAt.required = true;
  const reminderRepeat = el('select');
  for (const [value, label] of [['', s.once], ['daily', s.daily], ['weekdays', s.weekdays]]) {
    const option = el('option', label);
    option.value = value;
    reminderRepeat.append(option);
  }
  const addReminderButton = el('button', s.add);
  addReminderButton.type = 'submit';
  reminderForm.append(reminderText, formControl(s.when, reminderAt),
    formControl(s.repeat, reminderRepeat), addReminderButton);
  reminders.append(el('h2', s.reminders), reminderRows, laterLabel, reminderForm);
  aside.append(reminders);
  body.append(plan, aside);

  const dialog = el('dialog', undefined, 'today-dialog');
  const dialogTitle = el('h2');
  dialogTitle.id = 'today-dialog-title';
  dialog.setAttribute('aria-labelledby', dialogTitle.id);
  const dialogForm = el('form', undefined, 'today-dialog-form');
  const dialogFields = el('div');
  const dialogActions = el('div', undefined, 'actions');
  const dialogSubmit = el('button', s.save, 'primary');
  const dialogCancel = button(s.cancel, () => {
    dialog.close();
    dialogDismiss?.();
  });
  dialogActions.append(dialogSubmit, dialogCancel);
  dialogForm.append(dialogFields, dialogActions);
  dialog.append(dialogTitle, dialogForm);
  panel.append(heading, toast, status, body, dialog);

  let source;
  let scope;
  let data;
  let statuses = new Map();
  let pending = false;
  let loading;
  let revision = 0;
  let refreshAfterSave = false;
  let active = false;
  let dialogAction;
  let dialogDismiss;
  let toastTimeout;
  let timerRows = [];
  const timers = createTimers({ persistent: !fixture, onTick: updateTimers });
  const now = () => fixture && data ? new Date(data[planPath].date + 'T10:30') : new Date();

  function message(text, isError = false) {
    clearTimeout(toastTimeout);
    toast.textContent = text;
    toast.classList.toggle('error', isError);
    toast.hidden = false;
    toastTimeout = setTimeout(() => { toast.hidden = true; }, 6500);
  }

  function openDialog(title, fields, action, submit = s.save, cancel = s.cancel, dismiss) {
    dialogTitle.textContent = title;
    dialogFields.replaceChildren(...fields);
    dialogSubmit.textContent = submit;
    dialogCancel.textContent = cancel;
    dialogAction = action;
    dialogDismiss = dismiss;
    dialog.showModal();
  }

  dialog.addEventListener('cancel', () => dialogDismiss?.());

  dialogForm.addEventListener('submit', event => {
    event.preventDefault();
    const action = dialogAction;
    dialog.close();
    action();
  });

  function setControlState() {
    refreshButton.disabled = !source || Boolean(loading);
    body.setAttribute('aria-busy', String(Boolean(loading) || pending));
    addTodoButton.disabled = addReminderButton.disabled = pending;
    clearButton.disabled = pending;
  }

  async function read(path, client = source) {
    try {
      return (await client.getFile(path)).text;
    } catch (error) {
      if (error.status === 404 && Object.hasOwn(emptyLists, path)) return json(emptyLists[path]);
      throw error;
    }
  }

  async function refresh() {
    if (!active || !source || loading) return;
    if (pending) {
      refreshAfterSave = true;
      return;
    }
    const client = source;
    const version = revision;
    if (!data) status.textContent = s.loading;
    const request = Promise.all([planPath, todoPath, reminderPath].map(async path => [path, JSON.parse(await read(path, client))]));
    loading = request;
    setControlState();
    try {
      const snapshot = Object.fromEntries(await request);
      const plan = carryDue(snapshot[planPath]);
      const refs = new Set(plan.items.map(item => item.ref).filter(referencePath));
      const states = await Promise.all([...refs].map(async ref => {
        try {
          const { text } = await client.getFile(referencePath(ref));
          return [ref, parseFrontMatter(text).attributes.status];
        } catch (error) {
          if (error.status === 404) return [ref, null];
          throw error;
        }
      }));
      if (version !== revision) return;
      data = { ...snapshot, [planPath]: plan };
      statuses = new Map(states);
      status.textContent = '';
      reminderAt.value ||= localIsoMinutes(now());
      render();
    } catch {
      if (version !== revision) return;
      if (data) message(s.loadError, true);
      else status.textContent = s.loadError;
    } finally {
      if (loading === request) {
        loading = undefined;
        setControlState();
      }
      if (source === client) onResponse(client);
    }
  }

  async function apply(path, mutate, what) {
    if (pending || !source || !data) return false;
    const client = source;
    const before = data[path];
    const expectedDay = data[planPath].date;
    const next = mutate(before);
    if (next === before) return true;
    const version = ++revision;
    loading = undefined;
    pending = true;
    data = { ...data, [path]: next };
    render();
    try {
      const { text } = await client.update(path, inputText => {
        const current = JSON.parse(inputText);
        if (path === planPath && current.date !== expectedDay) throw new Error('The plan changed day');
        const base = path === planPath ? carryDue(current) : current;
        const changed = mutate(base);
        return changed === current ? inputText : json(changed);
      }, 'lab: web — ' + what, { initial: Object.hasOwn(emptyLists, path) ? json(emptyLists[path]) : undefined });
      if (version !== revision) return false;
      data[path] = JSON.parse(text);
      return true;
    } catch {
      if (version !== revision) return false;
      data[path] = before;
      message(s.saveError, true);
      return false;
    } finally {
      if (version === revision) {
        pending = false;
        onResponse(client);
        render();
        if (refreshAfterSave) {
          refreshAfterSave = false;
          refresh();
        }
      }
    }
  }

  // To-dos and ideas are separate files. Adding an idea copies its source text in one commit.
  async function copyToIdea(item) {
    if (pending) return;
    pending = true;
    render();
    const at = now();
    const day = today(at);
    const id = 'idea-' + day.replaceAll('-', '') + '-' + crypto.randomUUID();
    const attributes = {
      id, type: 'idea', title: item.text, lang: 'ru', area: 'projects', purpose: 'useful',
      status: 'new', created: day, last_touched: day, source: 'widget', origin: 'owner',
      tags: [], links: [], next_step: '',
    };
    const text = serializeFrontMatter({ attributes, body: item.comment ? item.comment + '\n' : '' });
    const client = source;
    try {
      await client.update('ideas/' + id + '.md', existing => existing || text, 'lab: web — copy to-do to ideas', { initial: '' });
      if (source === client) message(s.ideaAdded);
    } catch {
      if (source === client) message(s.saveError, true);
    } finally {
      if (source === client) {
        pending = false;
        onResponse(client);
        render();
        if (refreshAfterSave) {
          refreshAfterSave = false;
          refresh();
        }
      }
    }
  }

  function timerKey(row) {
    return JSON.stringify([scope, row.path, row.path === planPath ? data[planPath].date : null, row.item.id]);
  }

  function editNotes(row) {
    const fields = {};
    const controls = ['comment', 'blocker'].map(key => {
      fields[key] = el('textarea');
      fields[key].value = row.item[key] ?? '';
      return formControl(s[key], fields[key]);
    });
    openDialog(s.notes, controls, () => {
      const notes = {};
      for (const key of Object.keys(fields)) {
        if (fields[key].value !== (row.item[key] ?? '')) notes[key] = fields[key].value;
      }
      apply(row.path, list => setNotes(list, row.key, row.item.id, notes), 'edit notes');
    });
  }

  function editDuration(key) {
    const field = input('number', s.duration);
    field.min = '1';
    field.max = '1440';
    field.step = '1';
    field.required = true;
    field.value = timers.get(key).minutes;
    openDialog(s.timer, [formControl(s.duration, field)], () => {
      timers.configure(key, field.valueAsNumber);
      updateTimers(Date.now());
    });
    field.select();
  }

  function updateTimers(time) {
    for (const entry of timerRows) {
      const timer = timers.get(entry.key);
      const seconds = Math.max(0, Math.ceil((timer.end - time) / 1000));
      entry.duration.textContent = timer.end
        ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : s.minutes(timer.minutes);
      entry.duration.disabled = Boolean(timer.end);
      entry.control.textContent = timer.end ? '■' : '▶';
      entry.control.setAttribute('aria-label', timer.end ? s.stop : s.start);
      entry.control.disabled = Boolean(timer.rang);
    }
    if (!active || pending || dialog.open || document.hidden) return;
    const expired = timerRows.find(entry => timers.get(entry.key).rang);
    if (!expired) return;
    const { row, key } = expired;
    const { minutes } = timers.get(key);
    openDialog(s.timerEnded, [el('p', row.item.title ?? row.item.text)], async () => {
      const at = now();
      const ok = await apply(row.path, list => setDone(list, row.key, row.item.id, true, at, minutes), 'complete timed item');
      if (ok) timers.clear(key);
    }, s.markDone, s.dismiss, () => timers.stop(key));
  }

  function attachImportance(node, toggle) {
    let press;
    function cancel() {
      clearTimeout(press?.timer);
      press = undefined;
    }
    node.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' || event.target.closest('button, summary, a')) return;
      cancel();
      const timer = setTimeout(() => { cancel(); toggle(); }, 520);
      press = { timer, x: event.clientX, y: event.clientY };
    });
    node.addEventListener('pointermove', event => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 9) cancel();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(type, cancel);
    node.addEventListener('contextmenu', event => {
      if (event.target.closest('button, summary, a')) return;
      event.preventDefault();
      if (event.pointerType === 'mouse' || !event.pointerType) toggle();
    });
  }

  function dragHandle(node, row, peers) {
    const handle = button('⠿', () => {}, { label: s.reorder, className: 'today-icon today-drag', disabled: pending || peers.length < 2 });
    let target;
    let pointer;
    function moveTo(id) {
      const ids = peers.map(peer => peer.item.id);
      const from = ids.indexOf(row.item.id);
      const to = ids.indexOf(id);
      if (to === -1 || from === to) return;
      ids.splice(from, 1);
      ids.splice(to, 0, row.item.id);
      const save = apply(row.path, list => reorder(list, row.key, ids), 'reorder plan rows');
      save.then(() => {
        if (active && document.activeElement === document.body) {
          const replacement = [...panel.querySelectorAll('.today-row')].find(candidate =>
            candidate.dataset.id === row.item.id && candidate.dataset.path === row.path);
          replacement?.querySelector('.today-drag')?.focus();
        }
      });
    }
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const from = peers.indexOf(row);
      const next = peers[from + (event.key === 'ArrowUp' ? -1 : 1)];
      if (next) moveTo(next.item.id);
    });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || pointer !== undefined) return;
      event.preventDefault();
      pointer = event.pointerId;
      handle.setPointerCapture(pointer);
      node.classList.add('dragging');
    });
    handle.addEventListener('pointermove', event => {
      if (event.pointerId !== pointer) return;
      target?.classList.remove('drop-target');
      const candidate = document.elementFromPoint(event.clientX, event.clientY)?.closest('.today-row');
      target = candidate !== node && candidate?.parentElement === node.parentElement &&
        candidate.dataset.path === row.path && peers.some(peer => peer.item.id === candidate.dataset.id) ? candidate : undefined;
      target?.classList.add('drop-target');
      if (event.clientY > innerHeight - 36) window.scrollBy(0, 20);
      if (event.clientY < 36) window.scrollBy(0, -20);
    });
    function finish(event) {
      if (event.pointerId !== pointer) return;
      target?.classList.remove('drop-target');
      node.classList.remove('dragging');
      const id = target?.dataset.id;
      pointer = target = undefined;
      if (event.type === 'pointerup' && id) moveTo(id);
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
    return handle;
  }

  function renderRow(row, group) {
    const { item, path, key } = row;
    const node = el('li', undefined, 'today-row');
    node.dataset.id = item.id;
    node.dataset.path = path;
    node.classList.toggle('is-done', Boolean(item.done));
    const set = (edit, what) => apply(path, list => edit(list, key, item.id), what);
    const complete = button(item.done ? '✓' : '', () => {
      const at = now();
      set((list, key, id) => setDone(list, key, id, !item.done, at), item.done ? 'reopen item' : 'complete item');
    }, { label: item.done ? s.undoDone : s.markDone, className: 'today-icon today-check', disabled: pending });
    complete.setAttribute('aria-pressed', String(Boolean(item.done)));
    const info = el('div', undefined, 'today-row-info');
    const title = el('p', undefined, 'today-row-title');
    if (item.important) {
      const star = el('span', '★', 'today-star');
      star.setAttribute('aria-label', s.important);
      title.append(star, ' ');
    }
    const label = el('span', item.title ?? item.text, 'today-row-label');
    title.append(label);
    info.append(title);
    if (Number.isFinite(item.minutes)) info.append(el('p', s.minutes(item.minutes), 'today-muted today-estimate'));
    for (const field of ['comment', 'blocker']) {
      if (item[field]?.trim()) info.append(el('p', s.noteLine(s[field], item[field]), 'today-muted'));
    }

    const trailing = el('div', undefined, 'today-row-actions');
    if (!item.done) {
      const timer = el('div', undefined, 'today-timer');
      const timerId = timerKey(row);
      const duration = button('', () => editDuration(timerId), { label: s.duration, className: 'today-time' });
      const control = button('', () => {
        if (timers.get(timerId).end) timers.stop(timerId);
        else timers.start(timerId);
        updateTimers(Date.now());
      }, { className: 'today-icon' });
      timerRows.push({ row, key: timerId, duration, control });
      timer.append(duration, control);
      trailing.append(timer);
    }
    const toggleImportant = () => {
      set((list, key, id) => setImportant(list, key, id, !item.important), 'change priority');
    };
    attachImportance(info, toggleImportant);
    const menu = el('details', undefined, 'today-menu');
    const menuLabel = el('summary', '…', 'today-icon');
    menuLabel.setAttribute('aria-label', s.rowActions);
    const commands = el('div', undefined, 'today-menu-items');
    function command(text, action) {
      commands.append(button(text, () => { menu.open = false; action(); }, { disabled: pending }));
    }
    if (path === planPath) command(s.postpone, () => {
      const at = now();
      apply(path, list => postpone(list, item.id, at), 'postpone item');
    });
    command(s.notes, () => editNotes(row));
    command(item.important ? s.unimportant : s.makeImportant, toggleImportant);
    if (path === todoPath) command(s.toIdea, () => copyToIdea(item));
    command(s.remove, () => set(removeItem, 'remove item'));
    menu.append(menuLabel, commands);
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of panel.querySelectorAll('.today-menu[open]')) {
        if (other !== menu) other.open = false;
      }
    });
    trailing.append(menu, dragHandle(node, row, group.filter(peer =>
      peer.path === path && rowRank(peer.item) === rowRank(item))));
    node.append(complete, info, trailing);
    return node;
  }

  function renderReminders() {
    const at = now();
    const { due, later } = splitReminders(data[reminderPath], at);
    reminderRows.replaceChildren(...due.map(item => {
      const row = el('li', undefined, 'today-reminder');
      const text = el('div', undefined, 'today-row-info');
      text.append(el('p', item.text, 'today-row-title'));
      const label = item.at.slice(0, 10) < today(at) ? s.overdue(atLabel(item.at)) : item.at.slice(11, 16);
      text.append(el('p', label, 'today-muted'));
      const controls = el('div', undefined, 'today-reminder-actions');
      for (const [minutes, caption] of [[10, s.snooze10], [60, s.snooze60]]) {
        controls.append(button(caption, () => {
          const at = now();
          apply(reminderPath, list => snooze(list, item.id, item.at, minutes, at), 'snooze reminder');
        }, { disabled: pending, label: s.snooze(caption), className: 'today-text-button' }));
      }
      const complete = button('✓', () => {
        const at = now();
        apply(reminderPath, list => completeReminder(list, item.id, item.at, at), 'complete reminder');
      }, { disabled: pending, label: s.reminderDone, className: 'today-icon today-check' });
      row.append(complete, text, controls);
      return row;
    }));
    if (!due.length) reminderRows.append(el('li', s.emptyReminders, 'today-muted'));
    laterLabel.textContent = later.length ? s.later(later.length, atLabel(later[0].at)) : s.laterNone;
  }

  function render() {
    body.hidden = !data;
    timerRows = [];
    setControlState();
    if (!data) {
      date.textContent = '';
      return;
    }
    const daily = data[planPath];
    date.textContent = dayLabel(daily.date) + (fixture ? ' · ' + s.fixture : '');
    const grouped = planGroups(daily, data[todoPath], statuses);
    const totals = planProgress(grouped);
    count.textContent = s.counter(totals.done, totals.total, totals.elapsed, totals.planned);
    progress.max = totals.planned || totals.total || 1;
    progress.value = totals.planned ? totals.elapsed : totals.done;
    for (const [name, rows] of Object.entries(grouped)) {
      groups[name].rows.replaceChildren(...rows.map(row => renderRow(row, rows)));
      groups[name].empty.hidden = Boolean(rows.length);
    }
    clearButton.hidden = !data[todoPath].todos.some(item => item.done);
    const postponed = daily.postponed ?? [];
    postponedPanel.hidden = !postponed.length;
    postponedTitle.textContent = s.postponed(postponed.length);
    postponedRows.replaceChildren(...postponed.map(item => {
      const row = el('li', undefined, 'today-postponed');
      const info = el('div', undefined, 'today-row-info');
      info.append(el('p', item.title, 'today-row-title'), el('p', dayLabel(item.until), 'today-muted'));
      row.append(info, button(s.unpostpone, () =>
        apply(planPath, list => unpostpone(list, item.id), 'restore postponed item'), { disabled: pending }));
      return row;
    }));
    renderReminders();
    timers.tick();
  }

  todoForm.addEventListener('submit', async event => {
    event.preventDefault();
    const text = todoInput.value;
    if (!text.trim()) return;
    const at = now();
    if (await apply(todoPath, list => addTodo(list, text, at), 'add to-do') && todoInput.value === text) todoInput.value = '';
  });
  reminderForm.addEventListener('submit', async event => {
    event.preventDefault();
    const text = reminderText.value;
    if (!text.trim()) return;
    const at = now();
    const time = reminderAt.value;
    const repeat = reminderRepeat.value || null;
    if (await apply(reminderPath, list => addReminder(list, text, time, repeat, at), 'add reminder') &&
        reminderText.value === text) reminderText.value = '';
  });

  document.addEventListener('click', event => {
    if (event.target.closest('.today-menu')) return;
    for (const menu of panel.querySelectorAll('.today-menu[open]')) menu.open = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (!active || document.hidden) return;
    refresh();
    timers.tick();
  });

  let pull;
  panel.addEventListener('touchstart', event => {
    if (scrollY <= 0 && event.touches.length === 1 && !event.target.closest('button, input, textarea, select, summary')) {
      pull = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
  }, { passive: true });
  panel.addEventListener('touchend', event => {
    const finger = event.changedTouches[0];
    if (pull && scrollY <= 0 && finger.clientY - pull.y >= 72 && Math.abs(finger.clientX - pull.x) < 48) refresh();
    pull = undefined;
  }, { passive: true });
  panel.addEventListener('touchcancel', () => { pull = undefined; }, { passive: true });

  return {
    show(client, namespace) {
      active = true;
      if (source !== client || scope !== namespace) {
        source = client;
        scope = namespace;
        data = undefined;
        pending = false;
        loading = undefined;
        refreshAfterSave = false;
        ++revision;
        todoInput.value = reminderText.value = reminderAt.value = '';
        render();
      }
      if (!client) {
        const link = el('a', strings.settings);
        link.href = '#settings';
        status.replaceChildren(link);
      } else refresh();
    },
    hide() {
      active = false;
      if (dialog.open) dialog.close();
    },
  };
}
