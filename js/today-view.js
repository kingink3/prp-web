import { objectHref } from './objects.js';
import { createFocusView } from './focus-view.js';
import { link } from './work-dom.js';
import { createTimers } from './timers.js';
import { askNotifications, chime, enableAudio, notify } from './sound.js';
import {
  addQuickTimer, dueReminders, expireQuickTimers, leftMs, loadQuickTimers, removeQuickTimer, saveQuickTimers, toggleQuickTimer,
} from './quick-timers.js';
import { strings } from './strings.js';
import { localIsoMinutes, today } from './util.js';
import {
  addReminder, addTodo, carryDue, clearDone, completeReminder, emptyLists, planGroups, planPath,
  editDailyIdea, editPlanText, focusOrder, nextFocusRow, planProgress, reminderPath, reorder, rowActions, rowRank,
  setDone, setImportant,
  referencePath, setNotes, setText, snooze, splitReminders, todoPath, unpostpone, postpone,
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
const focusHistoryKey = 'prpFocus';

export function createTodayView(panel, { fixture, onResponse, onFirstRender }) {
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
  const progress = el('progress', undefined, 'bbar');
  progress.setAttribute('aria-label', s.progress);
  const count = el('p', undefined, 'today-count');
  const summary = el('div', undefined, 'today-summary');
  summary.append(count, progress);
  const plan = el('div', undefined, 'today-column');
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
  const dailyIdeas = el('section', undefined, 'today-card today-daily-ideas');
  const ideaRows = el('div', undefined, 'work-group');
  dailyIdeas.append(el('h2', strings.work.dailyIdeas), ideaRows);
  // Ideas of the day live on the «Идеи» tab now.
  dailyIdeas.hidden = true;

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
  // Quick timers: a short comment + minutes, with a sound at the end (kept on this device).
  const quick = el('section', undefined, 'today-card');
  const quickRows = el('ul', undefined, 'today-rows');
  const quickForm = el('form', undefined, 'today-form quick-form');
  const quickLabel = input('text', s.quickLabel);
  quickLabel.placeholder = s.quickLabel;
  quickLabel.maxLength = 60;
  const quickMinutes = input('number', s.quickMinutes);
  quickMinutes.min = '1'; quickMinutes.max = '600'; quickMinutes.value = '10';
  const quickStart = el('button', s.quickStart);
  quickStart.type = 'submit';
  quickForm.append(quickLabel, quickMinutes, quickStart);
  quick.append(el('h2', s.quickTimers), quickRows, quickForm);
  aside.append(reminders, quick, summary); // «Сделано» sits under the reminders, as in the Console
  body.append(plan, aside);

  const dialog = el('dialog', undefined, 'today-dialog');
  const dialogTitle = el('h2');
  dialogTitle.id = 'today-dialog-title';
  dialog.setAttribute('aria-labelledby', dialogTitle.id);
  const dialogForm = el('form', undefined, 'today-dialog-form');
  const dialogFields = el('div');
  const dialogActions = el('div', undefined, 'actions');
  const dialogSubmit = el('button', s.save, 'primary');
  dialogSubmit.type = 'submit';
  const dialogCancel = button(s.cancel, () => {
    dialog.close();
    dialogDismiss?.();
  });
  dialogActions.append(dialogSubmit, dialogCancel);
  dialogForm.append(dialogFields, dialogActions);
  dialog.append(dialogTitle, dialogForm);
  const focus = createFocusView(focusAction);
  panel.append(heading, toast, status, body, dialog, focus.element);

  let source;
  let lab;
  let scope;
  let data;
  let statuses = new Map();
  let ideaPaths = new Map();
  const ideaDrafts = new Map();
  let pending = false;
  let loading;
  let revision = 0;
  let refreshAfterSave = false;
  let active = false;
  let dialogAction;
  let dialogDismiss;
  let toastTimeout;
  let timerRows = [];
  let focusSession;
  let focusOnLoad = false;
  let focusTimer;
  const timers = createTimers({ persistent: !fixture, onTick: updateTimers });
  const now = () => fixture && data ? new Date(data[planPath].date + 'T10:30') : new Date();
  let store;
  try { if (!fixture) store = window.localStorage; } catch { /* storage unavailable */ }
  let quickList = loadQuickTimers(store);
  const RANG_KEY = 'prp.remindersRang';
  let rangReminders;
  try { rangReminders = new Set(JSON.parse(store?.getItem(RANG_KEY) ?? '[]')); } catch { rangReminders = new Set(); }

  function setQuick(list) { quickList = list; saveQuickTimers(store, list); renderQuick(); }
  function renderQuick() {
    const at = Date.now();
    quickRows.replaceChildren(...quickList.map(t => {
      const row = el('li', undefined, 'today-reminder quick-timer' + (t.rang ? ' rang' : '') + (t.end ? ' run' : ''));
      const info = el('div', undefined, 'today-row-info');
      info.append(el('p', t.label || s.quickNoLabel, 'today-row-title'));
      const ms = leftMs(t, at);
      const time = el('p', t.rang ? s.quickDone(t.minutes) : String(Math.floor(ms / 60000)).padStart(2, '0') + ':' +
        String(Math.floor(ms / 1000) % 60).padStart(2, '0'), 'today-muted quick-left');
      time.dataset.qt = t.id;
      info.append(time);
      const controls = el('div', undefined, 'today-reminder-actions');
      if (!t.rang) controls.append(button(t.end ? '❚❚' : '▶', () => setQuick(toggleQuickTimer(quickList, t.id, Date.now())),
        { label: t.end ? s.pause : s.start, className: 'today-text-button' }));
      controls.append(button('✕', () => setQuick(removeQuickTimer(quickList, t.id)), { label: s.quickRemove, className: 'today-text-button' }));
      row.append(info, controls);
      return row;
    }));
    quick.classList.toggle('empty', !quickList.length);
  }
  quickForm.addEventListener('submit', event => {
    event.preventDefault();
    enableAudio();
    askNotifications();
    setQuick(addQuickTimer(quickList, quickLabel.value, quickMinutes.value, Date.now()));
    quickLabel.value = '';
  });
  // one ticker for quick timers and due reminders
  setInterval(() => {
    const at = Date.now();
    const { list, rang } = expireQuickTimers(quickList, at);
    if (rang.length) {
      setQuick(list);
      chime('timer');
      for (const t of rang) { message(s.quickRang(t.label || s.quickNoLabel)); notify('⏱ ' + (t.label || s.quickNoLabel), s.quickDone(t.minutes)); }
    } else {
      for (const node of quickRows.querySelectorAll('[data-qt]')) {
        const t = quickList.find(x => x.id === node.dataset.qt);
        if (t && !t.rang && t.end) {
          const ms = leftMs(t, at);
          node.textContent = String(Math.floor(ms / 60000)).padStart(2, '0') + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');
        }
      }
    }
    const reminderList = data?.[reminderPath]?.reminders;
    if (!fixture && reminderList) {
      const due = dueReminders(reminderList, rangReminders, at, localIsoMinutes(new Date(at)));
      if (due.length) {
        for (const r of due) { rangReminders.add(r.id + '@' + r.at); message('⏰ ' + r.text); notify('⏰ ' + r.text, r.at.slice(11, 16)); }
        try { store?.setItem(RANG_KEY, JSON.stringify([...rangReminders].slice(-200))); } catch { /* keep in memory */ }
        chime('reminder');
        renderReminders();
      }
    }
  }, 1000);

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

  const todayPaths = [planPath, todoPath, reminderPath];

  function displaySnapshot(files, entries) {
    const snapshot = Object.fromEntries(todayPaths.map((path, i) => [path, JSON.parse(files[i].text)]));
    const plan = carryDue(snapshot[planPath]);
    if (data && data[planPath].date !== plan.date) {
      closeFocus();
      ideaDrafts.clear();
    }
    data = { ...snapshot, [planPath]: plan };
    statuses = new Map(entries.map(entry => [entry.id, entry.status]));
    ideaPaths = new Map(entries.filter(entry => entry.type === 'idea').map(entry => [entry.id, entry.path]));
    status.textContent = '';
    reminderAt.value ||= localIsoMinutes(now());
    render();
    maybeOpenFirst();
    onFirstRender();
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
    const request = Promise.all([
      ...todayPaths.map(path => lab.refresh(path, Object.hasOwn(emptyLists, path) ? json(emptyLists[path]) : undefined)),
      lab.refreshObjects(),
    ]);
    loading = request;
    setControlState();
    try {
      const [plan, todos, reminders, entries] = await request;
      if (version !== revision) return;
      displaySnapshot([plan, todos, reminders], entries);
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
    const activeLab = lab;
    const before = data[path];
    const expectedDay = data[planPath].date;
    const next = mutate(before);
    if (next === before) return true;
    const version = ++revision;
    refreshAfterSave ||= Boolean(loading);
    loading = undefined;
    pending = true;
    data = { ...data, [path]: next };
    render();
    try {
      const result = await client.update(path, inputText => {
        if (path === planPath) return editPlanText(inputText, expectedDay, mutate);
        const current = JSON.parse(inputText);
        const changed = mutate(current);
        return changed === current ? inputText : json(changed);
      }, 'lab: web — ' + what, { initial: Object.hasOwn(emptyLists, path) ? json(emptyLists[path]) : undefined });
      activeLab.remember(path, result);
      if (version !== revision) return false;
      data[path] = JSON.parse(result.text);
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

  function timerKey(row) {
    return JSON.stringify([scope, row.path, row.path === planPath ? data[planPath].date : null, row.item.id]);
  }

  function editRow(row, mutate, commit) {
    return apply(row.path, list => mutate(list, row.key, row.item.id), commit);
  }

  function saveNotes(row, notes) {
    return editRow(row, (list, key, id) => setNotes(list, key, id, notes), 'edit notes');
  }

  async function finishRow(row, done, notes = {}, spent = 0) {
    const at = now();
    const key = timerKey(row);
    const commit = done ? (spent ? 'complete timed item' : 'complete item') : 'reopen item';
    const ok = await editRow(row, (list, field, id) =>
      setDone(setNotes(list, field, id, notes), field, id, done, at, spent), commit);
    if (ok && done) timers.reset(key);
    return ok;
  }

  async function postponeRow(row, notes = {}) {
    const at = now();
    const key = timerKey(row);
    const ok = await editRow(row, (list, field, id) =>
      postpone(setNotes(list, field, id, notes), id, at), 'postpone item');
    if (ok) timers.reset(key);
    return ok;
  }

  function editText(row) {
    const isPlan = row.path === planPath;
    const text = el('textarea');
    text.value = (isPlan ? row.item.title : row.item.text) ?? '';
    const fields = [formControl(s.editText, text)];
    let minutes;
    if (isPlan) {
      minutes = input('number', s.editMinutes);
      minutes.min = '1'; minutes.max = '600';
      minutes.value = row.item.minutes ?? '';
      fields.push(formControl(s.editMinutes, minutes));
    }
    openDialog(s.editTitle, fields, () =>
      editRow(row, (list, key, id) => setText(list, key, id, { text: text.value, minutes: minutes?.value }), 'edit item'));
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
      saveNotes(row, notes);
    });
  }

  function makeTimer(row, inFocus = false) {
    const key = timerKey(row);
    const timer = el('div', undefined, 'timer today-timer');
    const lengthInput = inFocus ? input('number', s.duration) : null;
    const duration = button('', () => {
      if (!lengthInput) return openFocus(row, duration);
      lengthInput.value = timers.get(key).minutes;
      lengthInput.hidden = false;
      lengthInput.focus();
      lengthInput.select();
      duration.hidden = true;
    }, { label: inFocus ? s.duration : s.openFocus, className: 'today-time' });
    const control = button('', () => timers.toggle(key), { className: 'today-icon tbtn' });
    if (lengthInput) {
      lengthInput.className = 'timer-min';
      lengthInput.min = '1';
      lengthInput.max = '1440';
      lengthInput.step = '1';
      lengthInput.required = true;
      lengthInput.hidden = true;
      lengthInput.addEventListener('blur', () => {
        const { end, minutes } = timers.get(key);
        if (!end && lengthInput.validity.valid && lengthInput.valueAsNumber !== minutes) {
          timers.configure(key, lengthInput.valueAsNumber);
        }
        lengthInput.hidden = true;
        duration.hidden = false;
        updateTimers(Date.now());
      });
      lengthInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (lengthInput.reportValidity()) {
          lengthInput.blur();
          duration.focus();
        }
      });
      timer.append(duration, lengthInput, control);
    } else timer.append(duration, control);
    return { row, key, timer, duration, control, inFocus };
  }

  function updateTimers(time) {
    for (const entry of focusTimer ? [...timerRows, focusTimer] : timerRows) {
      const timer = timers.get(entry.key);
      const remaining = timer.end ? Math.max(0, timer.end - time) : timer.remaining;
      const seconds = Math.ceil(remaining / 1000);
      entry.duration.textContent = remaining === undefined ? s.minutes(timer.minutes) :
        Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
      entry.timer.classList.toggle('run', Boolean(timer.end) && !timer.rang);
      entry.duration.disabled = entry.inFocus ? Boolean(timer.end) || Boolean(focusSession?.busy) : pending;
      entry.control.textContent = timer.end ? '⏸' : '▶';
      entry.control.setAttribute('aria-label', timer.end ? s.pause : s.start);
      entry.control.disabled = Boolean(timer.rang) || (entry.inFocus ? Boolean(focusSession?.busy) : pending);
    }
    if (!active || pending || focusSession?.busy || dialog.open || document.hidden) return;
    const entries = focusSession ? (focusTimer ? [focusTimer] : []) : timerRows;
    const expired = entries.find(entry => timers.get(entry.key).rang);
    if (!expired) return;
    const { row, key } = expired;
    const { minutes } = timers.get(key);
    openDialog(s.timerEnded, [el('p', row.item.title ?? row.item.text)], () => {
      if (focusSession) focusAction('done', { spent: minutes });
      else finishRow(row, true, {}, minutes);
    }, s.markDone, s.dismiss, () => timers.reset(key));
  }

  function focusQueue() {
    return focusOrder(planGroups(data[planPath], data[todoPath], statuses));
  }

  function showFocusRow(row) {
    focusSession.row = row;
    focusTimer = row ? makeTimer(row, true) : undefined;
    focus.show(row, focusTimer?.timer);
    updateTimers(Date.now());
  }

  function openFocus(row, opener) {
    if (pending || focusSession) return;
    if (!history.state?.[focusHistoryKey]) history.pushState({ ...history.state, [focusHistoryKey]: true }, '');
    focusSession = { row, openedFrom: row, opener: opener?.matches('summary') ? '.today-menu summary' : '.today-time' };
    showFocusRow(row);
  }

  function maybeOpenFirst() {
    if (!focusOnLoad || !active || !data || pending) return;
    focusOnLoad = false;
    const first = focusQueue()[0];
    if (first) openFocus(first);
  }

  function closeFocus({ restore = true, goBack = true } = {}) {
    const session = focusSession;
    if (!session) return;
    const { opener, openedFrom } = session;
    focusSession = focusTimer = undefined;
    if (dialog.open) dialog.close();
    focus.close();
    if (goBack && history.state?.[focusHistoryKey]) history.back();
    if (restore) {
      const row = [...panel.querySelectorAll('.today-row')].find(node =>
        node.dataset.id === openedFrom.item.id && node.dataset.path === openedFrom.path);
      const control = row?.querySelector(opener);
      (control ?? row?.querySelector('.today-check') ?? refreshButton).focus({ preventScroll: true });
    }
  }

  async function focusAction(action, { back = false, spent = 0 } = {}) {
    const session = focusSession;
    if (!session) return;
    if (back) session.back = true;
    if (session.busy) return;
    const { row } = session;
    if (!row) return closeFocus({ goBack: !session.back });
    const before = focusQueue();
    const notes = focus.readNotes();
    session.busy = true;
    focus.busy(true);
    focus.showError('');
    updateTimers(Date.now());

    let ok;
    if (action === 'done') ok = await finishRow(row, true, notes, spent);
    else if (action === 'postpone') ok = await postponeRow(row, notes);
    else ok = !Object.keys(notes).length || await saveNotes(row, notes);

    if (focusSession !== session) return;
    session.busy = false;
    focus.busy(false);
    if (!ok) {
      if (session.back && !history.state?.[focusHistoryKey]) {
        history.pushState({ ...history.state, [focusHistoryKey]: true }, '');
        session.back = false;
      }
      focus.showError(s.saveError);
      updateTimers(Date.now());
      return;
    }
    if (action === 'close' || session.back) closeFocus({ goBack: !session.back });
    else showFocusRow(nextFocusRow(before, row, focusQueue()));
  }

  window.addEventListener('popstate', () => {
    const [route] = location.hash.slice(1).split('/');
    if (focusSession && !history.state?.[focusHistoryKey] && (!route || route === 'today')) {
      focusAction('close', { back: true });
    }
  });

  function attachImportance(node, toggle) {
    // Right click (mouse) toggles ⭐. On touch, long press is used to drag; ⭐ is in the «⋯» menu.
    node.addEventListener('contextmenu', event => {
      if (event.target.closest('button, summary, a, input, textarea')) return;
      event.preventDefault();
      if (event.pointerType === 'mouse' || !event.pointerType) toggle();
    });
  }

  function dragHandle(node, row, peers) {
    const handle = button('⠿', () => {}, { label: s.reorder, className: 'today-icon today-drag', disabled: pending });
    let target;
    let pointer;
    function moveTo(id, fromKeyboard = false) {
      const ids = peers.map(peer => peer.item.id);
      const from = ids.indexOf(row.item.id);
      const to = ids.indexOf(id);
      if (to === -1 || from === to) return;
      ids.splice(from, 1);
      ids.splice(to, 0, row.item.id);
      const save = apply(row.path, list => reorder(list, row.key, ids), 'reorder plan rows');
      save.then(() => {
        if (fromKeyboard && active && document.activeElement === document.body) {
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
      if (next) moveTo(next.item.id, true);
    });
    // Drag the whole row: mouse — press and move; touch — hold ~0.3 s, then move.
    // The ⠿ button stays (visually hidden) for keyboard users: focus it and use ↑/↓.
    let armed = false, start, holdTimer;
    const interactive = event => event.target.closest('button, summary, a, input, textarea, select, label, .today-check');
    function begin(event) {
      armed = true;
      pointer = event.pointerId;
      try { node.setPointerCapture(pointer); } catch { /* pointer already gone */ }
      node.classList.add('dragging');
    }
    node.addEventListener('pointerdown', event => {
      if (pending || event.button !== 0 || pointer !== undefined || interactive(event)) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId, type: event.pointerType };
      if (event.pointerType !== 'mouse') holdTimer = setTimeout(() => begin(event), 300);
    });
    node.addEventListener('pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (!armed) {
        if (start.type === 'mouse' && moved > 6) begin(event);
        else if (start.type !== 'mouse' && moved > 9) { clearTimeout(holdTimer); start = undefined; }  // a scroll, not a drag
        if (!armed) return;
      }
      target?.classList.remove('drop-target');
      const candidate = document.elementFromPoint(event.clientX, event.clientY)?.closest('.today-row');
      target = candidate !== node && candidate?.parentElement === node.parentElement &&
        candidate.dataset.path === row.path && peers.some(peer => peer.item.id === candidate.dataset.id) ? candidate : undefined;
      target?.classList.add('drop-target');
      if (event.clientY > innerHeight - 36) window.scrollBy(0, 20);
      if (event.clientY < 36) window.scrollBy(0, -20);
    });
    node.addEventListener('touchmove', event => { if (armed) event.preventDefault(); }, { passive: false });
    function finish(event) {
      clearTimeout(holdTimer);
      if (start && event.pointerId === start.id && !armed) start = undefined;
      if (!armed || event.pointerId !== pointer) return;
      target?.classList.remove('drop-target');
      node.classList.remove('dragging');
      const id = target?.dataset.id;
      pointer = target = start = undefined;
      armed = false;
      if (event.type === 'pointerup' && id) moveTo(id);
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(type, finish);
    return handle;
  }

  function renderRow(row, group) {
    const { item, path } = row;
    const node = el('li', undefined, 'row today-row');
    node.dataset.kind = path === todoPath ? 'todo' : item.kind ?? 'custom';
    node.classList.toggle('imp', Boolean(item.important));
    node.dataset.id = item.id;
    node.dataset.path = path;
    node.classList.toggle('is-done', Boolean(item.done));
    const complete = button(item.done ? '✓' : '', () => finishRow(row, !item.done), {
      label: item.done ? s.undoDone : s.markDone, className: 'chk today-check', disabled: pending,
    });
    complete.setAttribute('aria-pressed', String(Boolean(item.done)));
    const info = el('div', undefined, 'today-row-info');
    const title = el('p', undefined, 'today-row-title');
    if (item.important) {
      const star = el('span', '★', 'today-star');
      star.setAttribute('aria-label', s.important);
      title.append(star, ' ');
    }
    // A plan item with a ref opens its card (learning / project / experiment / idea), as in the Console.
    const objectPath = referencePath(item.ref);
    const href = objectPath && objectHref('today', objectPath);
    const label = href ? link(item.title ?? item.text, href, 'today-row-label today-ref') : el('span', item.title ?? item.text, 'today-row-label');
    title.append(label);
    info.append(title);
    if (Number.isFinite(item.minutes)) info.append(el('p', s.minutes(item.minutes), 'today-muted today-estimate'));
    const urls = (Array.isArray(item.links) ? item.links : []).filter(l => /^https?:\/\//i.test(l?.url ?? ''));
    if (urls.length) {
      const line = el('p', undefined, 'today-muted today-links');
      urls.forEach((l, k) => {
        const a = link(l.title || l.url, l.url);
        a.target = '_blank'; a.rel = 'noopener noreferrer';
        line.append(...(k ? [' · ', a] : [a]));
      });
      info.append(line);
    }
    for (const field of ['comment', 'blocker']) {
      if (item[field]?.trim()) info.append(el('p', s.noteLine(s[field], item[field]), 'today-muted'));
    }

    const toggleImportant = () =>
      editRow(row, (list, key, id) => setImportant(list, key, id, !item.important), 'change priority');
    attachImportance(info, toggleImportant);
    const leading = el('div', undefined, 'today-row-tools');
    leading.append(complete);
    const peers = group.filter(peer => peer.path === path && rowRank(peer.item) === rowRank(item));
    if (peers.length > 1) leading.append(dragHandle(node, row, peers));
    node.append(leading, info);
    if (!item.done) {
      const timer = makeTimer(row);
      timerRows.push(timer);
      const trailing = el('div', undefined, 'today-row-actions');
      trailing.append(timer.timer, rowMenu(row, toggleImportant));
      node.append(trailing);
    }
    return node;
  }

  function rowMenu(row, toggleImportant) {
    const menu = el('details', undefined, 'today-menu');
    const trigger = el('summary', '⋯', 'tbtn more');
    trigger.setAttribute('aria-label', s.rowActions);
    const commands = el('div', undefined, 'rowmenu');
    const callbacks = {
      focus: () => openFocus(row, trigger),
      notes: () => editNotes(row),
      edit: () => editText(row),
      makeImportant: toggleImportant,
      unimportant: toggleImportant,
      postpone: () => postponeRow(row),
    };
    for (const action of rowActions(row)) {
      commands.append(button(action === 'notes' ? s.menuNotes : s[action], () => {
        menu.open = false;
        trigger.focus({ preventScroll: true });
        callbacks[action]();
      }, { disabled: pending }));
    }
    menu.append(trigger, commands);
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of panel.querySelectorAll('.today-menu[open]')) {
        if (other !== menu) other.open = false;
      }
    });
    menu.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      trigger.focus();
    });
    return menu;
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
      }, { disabled: pending, label: s.reminderDone, className: 'chk today-check' });
      row.append(complete, text, controls);
      return row;
    }));
    if (!due.length) reminderRows.append(el('li', s.emptyReminders, 'today-muted'));
    laterLabel.textContent = later.length ? s.later(later.length, atLabel(later[0].at)) : '';
    laterLabel.hidden = !later.length;
  }

  function renderDailyIdeas() {
    const labels = strings.work;
    const ideas = (data[planPath].ideas ?? []).filter(idea => !idea.reaction);
    dailyIdeas.hidden = true;
    ideaRows.replaceChildren(...ideas.map(idea => {
      const id = idea.id ?? idea.ref;
      const row = el('article', undefined, 'work-card work-daily-idea');
      const caption = idea.title ?? id;
      const title = el('h3', caption);
      const path = ideaPaths.get(id);
      if (path) {
        const link = el('a', caption);
        link.href = objectHref('today', path);
        title.replaceChildren(link);
      }
      row.append(title);
      if (idea.pitch) row.append(el('p', idea.pitch, 'work-text'));
      const reactions = el('div', undefined, 'actions work-reactions');
      for (const [reaction, [icon, label]] of Object.entries(labels.reactions)) {
        reactions.append(button(icon, () =>
          apply(planPath, plan => editDailyIdea(plan, idea, { reaction }), 'daily idea reaction'),
        { label, disabled: pending }));
      }
      const form = el('form', undefined, 'work-comment');
      const comment = el('textarea');
      comment.rows = 2;
      comment.value = ideaDrafts.get(id) ?? idea.comment ?? '';
      comment.setAttribute('aria-label', labels.ownerComment);
      comment.placeholder = labels.ownerComment;
      comment.disabled = pending;
      comment.addEventListener('input', () => ideaDrafts.set(id, comment.value));
      const submit = el('button', labels.saveComment);
      submit.type = 'submit';
      submit.disabled = pending;
      form.append(comment, submit);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const saved = await apply(planPath, plan => editDailyIdea(plan, idea, { comment: comment.value.trim() }),
          'daily idea comment');
        if (saved) ideaDrafts.delete(id);
      });
      row.append(reactions, form);
      return row;
    }));
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
    const totals = planProgress(grouped, daily.date, data[todoPath]);
    count.textContent = s.counter(totals.done, totals.total, totals.timed);
    progress.max = totals.total || 1;
    progress.value = totals.done;
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
    renderQuick();
    renderDailyIdeas();
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
    show(client, store, namespace, startInFocus = false) {
      active = true;
      focusOnLoad ||= startInFocus;
      if (source !== client || lab !== store || scope !== namespace) {
        closeFocus({ restore: false, goBack: false });
        source = client;
        lab = store;
        scope = namespace;
        data = undefined;
        pending = false;
        loading = undefined;
        refreshAfterSave = false;
        ++revision;
        todoInput.value = reminderText.value = reminderAt.value = '';
        ideaDrafts.clear();
        render();
      }
      if (!client) {
        const link = el('a', strings.settings);
        link.href = '#settings';
        status.replaceChildren(link);
      } else {
        const files = todayPaths.map(path => lab.peek(path));
        const entries = lab.peekObjects();
        if (!pending && files.every(Boolean) && entries) displaySnapshot(files, entries);
        else if (data) {
          maybeOpenFirst();
          onFirstRender();
        }
        refresh();
      }
    },
    hide() {
      active = false;
      focusOnLoad = false;
      closeFocus({ restore: false, goBack: false });
      if (dialog.open) dialog.close();
    },
  };
}
