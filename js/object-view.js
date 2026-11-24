import { bodySections } from './frontmatter.js';
import { editChecklist, editStatus, loadObjects, objectCard, objectTypes, parseAreas, saveObjectEdit,
  statusOptions, taskReference } from './objects.js';
import { strings } from './strings.js';
import { addObjectToPlan, editDailyIdea, planPath } from './today-data.js';
import { today } from './util.js';
import { appendLinkedText, button, el, link } from './work-dom.js';

const s = strings.work;
const objectHref = (route, path) => '#' + route + '/' + encodeURIComponent(path);
const statusLabel = status => Object.hasOwn(s.status, status) ? s.status[status] : status;
const planJson = value => JSON.stringify(value, null, 2) + '\n';
const ideaStatuses = ['new', 'liked', 'testing', 'parked', 'done', 'killed'];
const ideaReaction = value => Object.keys(s.reactions).find(key => key === value || s.reactions[key][0] === value);

function textBlock(value) {
  const node = el('p', undefined, 'work-text');
  appendLinkedText(node, String(value));
  return node;
}

function renderCard(card, route) {
  const anchor = link('', objectHref(route, card.path), 'work-card work-object');
  const head = el('div', undefined, 'work-card-head');
  const badge = el('span', statusLabel(card.status), 'badge');
  if (card.status) badge.dataset.status = card.status;
  head.append(el('strong', card.title), badge);
  anchor.append(head);
  if (card.nextStep) anchor.append(el('p', card.nextStep));
  const facts = [s.type[card.type]];
  if (card.progress) facts.push(s.progress + ' ' + card.progress.join('/'));
  if (card.age !== null) facts.push(s.age(card.age));
  anchor.append(el('small', facts.join(' · '), 'work-muted'));
  if (card.progress?.[1]) {
    const [done, total] = card.progress;
    const progress = el('progress', undefined, 'pbar');
    progress.max = total;
    progress.value = done;
    progress.setAttribute('aria-label', s.progress);
    anchor.append(progress);
  }
  return anchor;
}

export function createObjectView(panel, { fixture, onResponse }) {
  const heading = el('h1');
  const notice = el('div', undefined, 'work-notice');
  notice.setAttribute('role', 'status');
  const content = el('div', undefined, 'work-content');
  panel.append(heading, notice, content);
  let scope;
  let view;
  let selectedArea;

  function feedback(text, isError = false) {
    notice.replaceChildren(text ?? '');
    notice.classList.toggle('error', isError);
    if (scope?.journal) {
      notice.replaceChildren(el('p', s.journalError), button(s.retryJournal,
        () => transact(async active => {
          await active.journal();
          active.journal = undefined;
        }, s.saved), 'work-retry'));
      notice.classList.add('error');
    }
    notice.hidden = !notice.textContent;
  }

  function setBusy() {
    const busy = Boolean(scope?.pending);
    content.setAttribute('aria-busy', String(busy));
    for (const control of panel.querySelectorAll('[data-mutation], .work-retry')) {
      control.disabled = busy || (Boolean(scope?.journal) && control.matches('[data-mutation]')) ||
        control.dataset.disabled === 'true';
    }
  }

  function mutable(node) {
    node.dataset.mutation = '';
    return node;
  }

  async function transact(action, success = s.saved, onFailure) {
    const current = view;
    const active = scope;
    if (!current || active.pending) return;
    const request = Promise.resolve().then(() => action(active));
    active.pending = request;
    feedback();
    setBusy();
    try {
      await request;
      if (current !== view) return;
      render();
      feedback(success);
    } catch {
      if (current !== view) return;
      onFailure?.();
      feedback(s.saveError, true);
    } finally {
      active.pending = undefined;
      if (active === scope) setBusy();
      onResponse(active.client);
    }
  }

  async function readPlan(active) {
    return JSON.parse((await active.client.getFile(planPath)).text);
  }

  async function writePlan(active, expectedDay, change, commit) {
    const result = await active.client.update(planPath, input => {
      const plan = JSON.parse(input);
      if (plan.date !== expectedDay) throw new RangeError('The plan changed day');
      const updated = change(plan);
      return updated === plan ? input : planJson(updated);
    }, 'lab: web — ' + commit);
    return JSON.parse(result.text);
  }

  async function load(current) {
    const active = scope;
    feedback(s.loading);
    content.replaceChildren();
    try {
      await active.pending?.catch(() => {});
      if (current !== view) return;
      const { client } = active;
      const configFile = current.route === 'ideas' ? null : client.getFile('config/areas.yaml').catch(error => {
        if (error.status === 404) return null;
        throw error;
      });
      const [plan, configSource] = await Promise.all([current.route === 'ideas' || fixture ? readPlan(active) : null, configFile]);
      const config = parseAreas(configSource?.text ?? '');
      const date = fixture ? plan.date : today();
      const folders = current.route === 'ideas' ? ['ideas'] : Object.keys(objectTypes);
      const cards = await loadObjects(client, folders, config, date);
      if (current !== view) return;
      Object.assign(current, { cards, config, date, plan });
      render();
      feedback();
    } catch {
      if (current !== view) return;
      content.replaceChildren(el('p', s.loadError), button(s.retry, () => load(current)));
      feedback();
    } finally {
      onResponse(active.client);
    }
  }

  function updateCard(card, mutate, description, commit, onFailure) {
    const current = view;
    transact(async active => {
      const at = fixture ? new Date(current.date + 'T10:30') : new Date();
      const result = await saveObjectEdit(active.client, card, mutate, { at, description, commit });
      active.journal = result.saveJournal;
      current.cards = current.cards.map(entry => entry.path === card.path
        ? objectCard(card.path, result.text, current.config, current.date) : entry).filter(Boolean);
    }, s.saved, onFailure);
  }

  function renderBoard() {
    const areas = [...view.config.areas];
    const known = new Set(areas.map(area => area.id));
    const other = view.cards.filter(card => !known.has(card.area));
    if (other.length || !areas.length) areas.push({ id: null, title: s.otherArea });
    if (!areas.some(area => area.id === selectedArea)) {
      selectedArea = areas.find(area => view.cards.some(card => card.area === area.id))?.id ?? areas[0].id;
    }
    const tabs = el('nav', undefined, 'work-tabs');
    tabs.setAttribute('aria-label', s.areas);
    for (const area of areas) {
      const tab = button(area.title, () => {
        selectedArea = area.id;
        render();
        content.querySelector('.work-tabs [aria-current]').focus();
      });
      if (selectedArea === area.id) tab.setAttribute('aria-current', 'true');
      tabs.append(tab);
    }
    const cards = selectedArea === null ? other : view.cards.filter(card => card.area === selectedArea);
    const column = el('div', undefined, 'work-column');
    const grid = el('div', undefined, 'work-grid');
    grid.append(...cards.map(card => renderCard(card, view.route)));
    column.append(cards.length ? grid : el('p', s.noCards, 'work-muted'));
    return [tabs, column];
  }

  function detailFields(card) {
    const group = el('details', undefined, 'work-card work-fields');
    group.append(el('summary', s.fields));
    const details = el('dl');
    for (const [key, value] of Object.entries(card.attributes)) {
      const label = Object.hasOwn(s.field, key) ? s.field[key] : key;
      const display = key === 'status' ? statusLabel(value)
        : key === 'type' ? s.type[card.type]
          : key === 'area' ? view.config.areas.find(area => area.id === value)?.title ?? value
            : Array.isArray(value) ? value.join('\n') : value;
      const field = el('dd', undefined, 'work-text');
      if (display !== undefined && display !== null) appendLinkedText(field, String(display));
      details.append(el('dt', label), field);
    }
    group.append(details);
    return group;
  }

  function renderTasks(card) {
    const section = el('section', undefined, 'work-card work-tasks');
    const counts = card.progress ?? [0, 0];
    section.append(el('h2', s.progress + ' · ' + counts.join('/')));
    const edit = (action, description) => updateCard(card,
      (text, date) => editChecklist(text, action, date), description, 'project checklist');
    const list = el('ul', undefined, 'work-list');
    card.tasks.forEach((task, index) => {
      const row = el('li', undefined, 'work-task');
      const reference = taskReference(card.tasks, index);
      const check = mutable(el('input'));
      check.type = 'checkbox';
      check.checked = task.done;
      check.addEventListener('change', () => {
        const done = check.checked;
        check.checked = task.done;
        edit({ kind: 'tick', task: reference, done }, (done ? s.taskTicked : s.taskUnticked)(task.text));
      });
      const label = el('label');
      label.append(check, el('span', task.text));
      const up = mutable(button('↑', () => edit({
        kind: 'up', task: reference, previous: taskReference(card.tasks, index - 1),
      }, s.taskRaised(task.text))));
      up.setAttribute('aria-label', s.up);
      up.dataset.disabled = String(!index);
      const remove = mutable(button('✕', () => edit({ kind: 'remove', task: reference }, s.taskRemoved(task.text))));
      remove.setAttribute('aria-label', s.remove);
      row.append(label, up, remove);
      list.append(row);
    });
    const form = el('form', undefined, 'work-form');
    const input = el('input');
    input.required = true;
    input.placeholder = s.taskInput;
    input.setAttribute('aria-label', s.taskInput);
    const add = mutable(el('button', s.addTask));
    add.type = 'submit';
    form.append(input, add);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (add.disabled || !input.value.trim()) return;
      edit({ kind: 'add', text: input.value }, s.taskAdded(input.value));
    });
    section.append(list, form);
    if (card.taskNotes) section.append(textBlock(card.taskNotes));
    return section;
  }

  function renderDetail(card) {
    const back = link(s.back, '#' + view.route, 'btn work-back');
    if (!card) return [back, el('p', s.noObject)];
    const summary = el('section', undefined, 'work-card');
    summary.append(el('p', s.type[card.type] + ' · ' + (statusLabel(card.status) ?? ''), 'work-muted'));
    if (card.nextStep) summary.append(el('h2', s.nextStep), textBlock(card.nextStep));
    const actions = el('div', undefined, 'actions');
    const statuses = mutable(el('select'));
    statuses.setAttribute('aria-label', s.setStatus);
    const choices = statusOptions[card.type];
    const options = choices.includes(card.status) ? choices : [card.status ?? '', ...choices];
    for (const status of options) {
      const option = el('option', statusLabel(status));
      option.value = status;
      option.disabled = !choices.includes(status);
      statuses.append(option);
    }
    statuses.value = card.status ?? '';
    statuses.addEventListener('change', () => {
      const next = statuses.value;
      updateCard(card, (text, date) => editStatus(text, card.type, next, date),
        s.setStatus + ': ' + statusLabel(next), 'object status', () => { statuses.value = card.status ?? ''; });
    });
    const add = mutable(button(s.addToPlan, () => transact(async active => {
      const plan = await readPlan(active);
      const at = fixture ? new Date(plan.date + 'T10:30') : new Date();
      await writePlan(active, plan.date, data => addObjectToPlan(data, card, at), 'add object to plan');
    }, s.addedToPlan), 'primary'));
    actions.append(statuses, add);
    summary.append(actions);
    const sections = bodySections(card.body).filter(section => card.type !== 'project' || section.title !== s.progress)
      .map(({ title, text }) => {
        const section = el('section', undefined, 'work-card');
        if (title) section.append(el('h2', title));
        if (text) section.append(textBlock(text));
        return section;
      });
    return [back, summary, ...(card.type === 'project' ? [renderTasks(card)] : []), detailFields(card), ...sections];
  }

  function renderIdea(idea) {
    const current = view;
    const card = current.cards.find(entry => entry.id === (idea.id ?? idea.ref));
    const row = el('article', undefined, 'work-card work-idea');
    const title = idea.title ?? card?.title ?? idea.id ?? idea.ref;
    const heading = el('h3');
    heading.append(card ? link(title, objectHref('ideas', card.path)) : title);
    row.append(heading);
    if (idea.pitch) row.append(textBlock(idea.pitch));
    const form = el('form', undefined, 'work-comment');
    const comment = mutable(el('textarea'));
    comment.rows = 2;
    comment.value = idea.comment ?? '';
    comment.setAttribute('aria-label', s.ownerComment);
    comment.placeholder = s.ownerComment;
    const save = (patch, commit) => transact(async active => {
      current.plan = await writePlan(active, current.plan.date, plan => editDailyIdea(plan, idea, patch), commit);
      if (Object.hasOwn(patch, 'comment')) current.drafts.delete(idea.id ?? idea.ref);
    });
    const reactions = el('div', undefined, 'actions work-reactions');
    for (const [id, [icon, label]] of Object.entries(s.reactions)) {
      const selected = ideaReaction(idea.reaction) === id;
      const react = mutable(button(icon, () => save({ reaction: selected ? null : id }, 'idea reaction')));
      react.setAttribute('aria-label', label);
      react.setAttribute('aria-pressed', String(selected));
      reactions.append(react);
    }
    const key = idea.id ?? idea.ref;
    if (current.drafts.has(key)) comment.value = current.drafts.get(key);
    comment.addEventListener('input', () => current.drafts.set(key, comment.value));
    const submit = mutable(el('button', s.saveComment));
    submit.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (submit.disabled) return;
      save({ comment: comment.value.trim() }, 'idea comment');
    });
    form.append(comment, submit);
    row.append(reactions, form);
    return row;
  }

  function renderIdeas() {
    const daily = el('section', undefined, 'work-group');
    daily.append(el('h2', s.dailyIdeas));
    const ideas = view.plan.ideas ?? [];
    daily.append(...(ideas.length ? ideas.map(renderIdea) : [el('p', s.noDailyIdeas, 'work-muted')]));
    const all = el('section', undefined, 'work-group');
    all.append(el('h2', s.allIdeas));
    for (const status of new Set([...ideaStatuses, ...view.cards.map(card => card.status)])) {
      const cards = view.cards.filter(card => card.status === status);
      if (!cards.length) continue;
      const group = el('section', undefined, 'work-group');
      const grid = el('div', undefined, 'work-grid');
      grid.append(...cards.map(card => renderCard(card, 'ideas')));
      group.append(el('h3', statusLabel(status)), grid);
      all.append(group);
    }
    if (!view.cards.length) all.append(el('p', s.noIdeas, 'work-muted'));
    return [daily, all];
  }

  function render() {
    const card = view.path && view.cards.find(entry => entry.path === view.path);
    heading.textContent = card?.title ?? strings[view.route];
    content.replaceChildren(...(view.path ? renderDetail(card) : view.route === 'ideas' ? renderIdeas() : renderBoard()));
    setBusy();
  }

  return {
    show(client, route, path) {
      if (scope?.client !== client) {
        scope = { client };
        selectedArea = undefined;
        view = undefined;
      }
      if (view?.route === route && view.path === path) return;
      if (view?.route === route && view.cards) {
        view.path = path;
        feedback();
        render();
        window.scrollTo(0, 0);
        return;
      }
      view = { route, path, drafts: new Map() };
      heading.textContent = strings[route];
      if (client) load(view);
      else {
        feedback();
        content.replaceChildren(link(strings.settings, '#settings'));
      }
    },
    hide() { view = undefined; },
  };
}
