import { parseChecklist, parseFrontMatter, serializeFrontMatter } from './frontmatter.js';
import { areasPath } from './lab-data.js';
import { editChecklist, editObject, isObjectPath, objectCard, objectPurposes, parseAreas,
  saveObjectEdit, statusOptions, taskReference, typeObjectFields } from './objects.js';
import { strings } from './strings.js';
import { addObjectToPlan, planPath } from './today-data.js';
import { today } from './util.js';
import { button, el, link, showNotice } from './work-dom.js';

const s = strings.objectDrawer;
const work = strings.work;
const normalizeBody = value => value.replace(/\r\n?/g, '\n');

function field(key, caption, value, choices) {
  const control = el(choices ? 'select' : 'input');
  control.name = key;
  if (choices) {
    if (!choices.some(([option]) => option === value)) choices = [[value, value || s.choose], ...choices];
    for (const [option, label] of choices) {
      const entry = el('option', label);
      entry.value = option;
      control.append(entry);
    }
  }
  control.value = value;
  const label = el('label', caption, 'field');
  label.append(control);
  return { control, label };
}

export function createObjectDrawer({ fixture, onResponse, onClose, onChange, onCodex }) {
  const dialog = el('dialog', undefined, 'drawer object-drawer');
  const head = el('header', undefined, 'drawer-head');
  const caption = el('p', s.heading, 'work-muted');
  caption.id = 'object-drawer-heading';
  dialog.setAttribute('aria-labelledby', caption.id);
  const close = button(s.closeIcon, onClose, 'btn small drawer-close');
  close.setAttribute('aria-label', s.close);
  close.autofocus = true;
  const notice = el('p');
  notice.setAttribute('role', 'status');
  const retry = button(work.retry, () => load(state), 'btn small');
  const retryJournal = button(work.retryJournal, () => {
    const active = state;
    run(active, work.saved, () => saveJournal(active));
  }, 'btn small');
  const content = el('div', undefined, 'drawer-content');
  head.append(caption, close);
  dialog.append(head, notice, retry, retryJournal, content);
  document.body.append(dialog);
  let state;
  const writes = new WeakMap();
  const journals = new WeakMap();
  let backdropDown = false;

  const outside = event => event.target === dialog && event.clientX < dialog.getBoundingClientRect().left;
  dialog.addEventListener('pointerdown', event => { backdropDown = outside(event); });
  dialog.addEventListener('click', event => {
    if (backdropDown && outside(event)) onClose();
    backdropDown = false;
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    onClose();
  });

  function fileMap(store, client) {
    if (!store.has(client)) store.set(client, new Map());
    return store.get(client);
  }

  function setBusy(active, busy) {
    if (active !== state) return;
    const blocked = fileMap(journals, active.client).has(active.path);
    content.setAttribute('aria-busy', String(busy));
    if (active.editor) active.editor.disabled = busy;
    for (const control of content.querySelectorAll('[data-write]')) {
      control.disabled = busy || blocked || control.dataset.disabled === 'true';
    }
    retryJournal.hidden = !blocked;
    retryJournal.disabled = busy;
  }

  async function run(active, success, action, failure = work.saveError) {
    const pending = fileMap(writes, active.client);
    if (pending.has(active.path)) return;
    const request = Promise.resolve().then(action);
    pending.set(active.path, request);
    showNotice(notice, '');
    setBusy(active, true);
    try {
      await request;
      if (active === state) showNotice(notice, success, 'success');
    } catch {
      if (active === state) showNotice(notice, failure, 'error');
    } finally {
      pending.delete(active.path);
      if (active === state) {
        if (fileMap(journals, active.client).has(active.path)) showNotice(notice, work.journalError, 'error');
        setBusy(active, false);
      }
      onResponse(active.client);
    }
  }

  async function load(active) {
    retry.hidden = retryJournal.hidden = true;
    content.replaceChildren();
    active.editor = undefined;
    caption.textContent = s.heading;
    showNotice(notice, active.client ? work.loading : '');
    if (!active.client) {
      content.append(link(strings.settings, '#settings'));
      return;
    }
    if (!isObjectPath(active.path)) {
      showNotice(notice, work.noObject);
      return;
    }
    try {
      await fileMap(writes, active.client).get(active.path)?.catch(() => {});
      if (state !== active) return;
      const [file, config] = await Promise.all([
        active.client.getFile(active.path).catch(error => {
          if (error.status === 404) return null;
          throw error;
        }),
        active.lab.peek(areasPath) ?? active.lab.refresh(areasPath, ''),
      ]);
      if (active !== state) return;
      active.config = parseAreas(config.text);
      active.date = fixture ? '2030-01-15' : today();
      active.card = file && objectCard(active.path, file.text, active.config, active.date);
      if (!active.card) return showNotice(notice, work.noObject);
      active.markdown = file.text;
      render(active);
      showNotice(notice, fileMap(journals, active.client).has(active.path) ? work.journalError : '', 'error');
    } catch {
      if (active !== state) return;
      showNotice(notice, work.loadError, 'error');
      retry.hidden = false;
    } finally {
      onResponse(active.client);
    }
  }

  async function saveJournal(active) {
    const pending = fileMap(journals, active.client);
    await pending.get(active.path)?.();
    pending.delete(active.path);
  }

  function draftMarkdown(active) {
    const draft = parseFrontMatter(active.markdown);
    draft.body = active.body.value;
    return serializeFrontMatter(draft);
  }

  function updateFromFile(active, text, replaceFields) {
    if (state !== active) return;
    active.markdown = text;
    active.card = objectCard(active.path, text, active.config, active.date);
    if (!active.card) return;
    for (const [key, control] of Object.entries(active.fields)) {
      const old = active.original[key];
      const value = String(active.card.attributes[key] ?? (key === 'area' ? active.card.area : '') ?? '');
      if (replaceFields || control.value === old) {
        if (control.tagName === 'SELECT' && ![...control.options].some(option => option.value === value)) {
          const option = el('option', value || s.choose);
          option.value = value;
          control.append(option);
        }
        control.value = value;
      }
      active.original[key] = value;
    }
    active.body.value = active.card.body;
    renderTasks(active);
    renderFooter(active);
  }

  async function persist(active, mutate, description, commit, replaceFields = false) {
    const at = fixture ? new Date(active.date + 'T10:30') : new Date();
    const result = await saveObjectEdit(active.client, active.card, mutate, { at, description, commit });
    if (result.saveJournal) fileMap(journals, active.client).set(active.path, result.saveJournal);
    active.lab.patchObject(active.path, result.text);
    updateFromFile(active, result.text, replaceFields);
    onChange(active.lab, 'object');
  }

  function save(active) {
    const fields = Object.fromEntries(Object.entries(active.fields)
      .filter(([key, control]) => control.value !== active.original[key])
      .map(([key, control]) => [key, control.value.trim()]));
    const previousBody = normalizeBody(active.card.body);
    const body = active.body.value === previousBody ? undefined : active.body.value;
    return run(active, work.saved, () => persist(active,
      (markdown, date) => editObject(markdown, active.card.type, { fields, body, previousBody }, date),
      s.edited, 'edit object', true));
  }

  function addToPlan(active, nextStep) {
    return run(active, work.addedToPlan, async () => {
      const expected = JSON.parse((await active.lab.refresh(planPath)).text).date;
      const at = fixture ? new Date(expected + 'T10:30') : new Date();
      const result = await active.client.update(planPath, text => {
        const plan = JSON.parse(text);
        if (plan.date !== expected) throw new RangeError('The plan changed day');
        const card = { ...active.card, title: active.fields.title.value.trim() || active.card.title,
          nextStep, minutes: 25 };
        return JSON.stringify(addObjectToPlan(plan, card, at), null, 2) + '\n';
      }, 'lab: web - add object to plan');
      active.lab.remember(planPath, result);
      onChange(active.lab, 'plan');
    });
  }

  function writable(control) {
    control.dataset.write = '';
    return control;
  }

  function renderTasks(active) {
    if (!active.tasks) return;
    const tasks = parseChecklist(draftMarkdown(active));
    const edit = (action, description, onSaved) => {
      if (active.body.value !== normalizeBody(active.card.body)) {
        // The checklist follows a manually edited body and is saved with the document in this case.
        const changed = parseFrontMatter(editChecklist(draftMarkdown(active), action, active.date));
        active.body.value = changed.body;
        if (active.fields.next_step.value === active.original.next_step) {
          active.fields.next_step.value = changed.attributes.next_step ?? '';
        }
        renderTasks(active);
        setBusy(active, false);
        onSaved?.();
      } else {
        run(active, work.saved, async () => {
          await persist(active, (markdown, day) => editChecklist(markdown, action, day), description, 'project checklist');
          if (active === state) onSaved?.();
        });
      }
    };
    active.tasks.replaceChildren(...tasks.map((task, index) => {
      const row = el('li', undefined, 'ptask');
      const reference = taskReference(tasks, index);
      const check = writable(el('input'));
      check.type = 'checkbox';
      check.checked = task.done;
      check.addEventListener('change', () => {
        const done = check.checked;
        check.checked = task.done;
        edit({ kind: 'tick', task: reference, done }, (done ? work.taskTicked : work.taskUnticked)(task.text));
      });
      const label = el('label');
      label.append(check, el('span', task.text));
      const add = writable(button(s.taskToday, () => addToPlan(active, task.text), 'btn small'));
      const up = writable(button(s.upIcon, () => edit({
        kind: 'up', task: reference, previous: taskReference(tasks, index - 1),
      }, work.taskRaised(task.text)), 'btn small'));
      up.setAttribute('aria-label', work.up);
      up.dataset.disabled = String(index === 0);
      const remove = writable(button(s.closeIcon, () => edit({ kind: 'remove', task: reference },
        work.taskRemoved(task.text)), 'btn small'));
      remove.setAttribute('aria-label', work.remove);
      row.append(label, add, up, remove);
      return row;
    }));
    active.addTask = (text, onSaved) => edit({ kind: 'add', text }, work.taskAdded(text), onSaved);
  }

  function renderFooter(active) {
    const { created, last_touched: touched, source, origin } = active.card.attributes;
    active.footer.textContent = [
      created && s.created(created), touched && s.touched(touched), source, origin === 'agent' && work.origin.agent,
    ].filter(Boolean).join(' · ');
  }

  function claude(active, prompt) {
    const copy = navigator.clipboard?.writeText(prompt);
    window.open('https://claude.ai/code', '_blank', 'noopener,noreferrer');
    if (!copy) showNotice(notice, s.copyFailed, 'error');
    else copy.then(() => {
      if (state === active) showNotice(notice, s.copied, 'success');
    }).catch(() => {
      if (state === active) showNotice(notice, s.copyFailed, 'error');
    });
  }

  function render(active) {
    const { card } = active;
    caption.textContent = [s.icons[card.type], work.type[card.type], card.path].join(' · ');
    const editor = active.editor = el('fieldset', undefined, 'drawer-editor');
    const form = el('form');
    const fields = active.fields = {};
    const original = active.original = {};
    const addField = (parent, key, choices) => {
      const value = String(card.attributes[key] ?? (key === 'area' ? card.area : '') ?? '');
      const { control, label } = field(key, s.fields[key] ?? work.field[key], value, choices);
      fields[key] = control;
      original[key] = control.value;
      parent.append(label);
    };
    addField(editor, 'title');
    fields.title.required = true;
    const metadata = el('div', undefined, 'three');
    const statuses = card.type === 'idea' ? work.ideaStatuses : work.status;
    addField(metadata, 'area', active.config.areas.map(({ id, title }) => [id, title]));
    addField(metadata, 'status', statusOptions[card.type].map(status => [status, statuses[status]]));
    addField(metadata, 'purpose', [['', s.choose], ...objectPurposes.map(purpose => [purpose, s.purposes[purpose]])]);
    editor.append(metadata);
    addField(editor, 'next_step');
    const typeFields = el('div', undefined, 'two');
    for (const key of typeObjectFields[card.type]) addField(typeFields, key);
    editor.append(typeFields);

    const body = active.body = el('textarea', undefined, 'drawer-markdown');
    body.name = 'body';
    body.spellcheck = false;
    body.value = card.body;
    if (card.type === 'project') {
      const section = el('section', undefined, 'drawer-tasks');
      const taskInput = writable(el('input'));
      taskInput.placeholder = s.taskInput;
      taskInput.setAttribute('aria-label', s.taskInput);
      taskInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        const text = taskInput.value.trim();
        if (!text) return;
        active.addTask(text, () => { taskInput.value = ''; });
      });
      active.tasks = el('ul', undefined, 'work-list');
      section.append(el('h2', work.progress), active.tasks, taskInput);
      editor.append(section);
      body.addEventListener('input', () => {
        renderTasks(active);
        setBusy(active, false);
      });
      renderTasks(active);
    }
    const bodyLabel = el('label', s.body, 'field');
    bodyLabel.append(body);
    const actions = el('div', undefined, 'actions drawer-actions');
    const submit = writable(el('button', s.save, 'btn primary'));
    submit.type = 'submit';
    const plan = writable(button(work.addToPlan, () => addToPlan(active, fields.next_step.value.trim()), 'btn'));
    const codex = button(s.codex, () => onCodex({ ...active.card, title: fields.title.value.trim() || card.title }), 'btn');
    actions.append(submit, plan, codex);
    if (card.type === 'learning') actions.append(button(s.course, () => claude(active, s.coursePrompt(card.id)), 'btn'));
    actions.append(button(s.claude, () => claude(active, s.claudePrompt(card.type, card.id)), 'btn'));
    editor.append(bodyLabel, actions);
    form.append(editor);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!submit.disabled) save(active);
    });
    active.footer = el('footer', undefined, 'work-muted drawer-footer');
    renderFooter(active);
    content.replaceChildren(form, active.footer);
    setBusy(active, false);
  }

  return {
    show(client, lab, path) {
      if (state?.path === path && state.client === client) return;
      state = { client, lab, path };
      if (!dialog.open) dialog.showModal();
      dialog.scrollTop = 0;
      close.focus({ preventScroll: true });
      load(state);
    },
    hide() {
      state = undefined;
      if (dialog.open) dialog.close();
    },
  };
}
