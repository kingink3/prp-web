import { bodySections } from './frontmatter.js';
import { ideaFilterStatuses, ideaList, ideaStatus } from './ideas.js';
import { areasPath } from './lab-data.js';
import { editChecklist, editIdeaComment, editStatus, isObjectPath, objectCard, objectList, parseAreas,
  saveObjectEdit, statusOptions, taskReference } from './objects.js';
import { strings } from './strings.js';
import { addIdeaToPlan, addObjectToPlan, editDailyIdea, ideaInPlan, planPath } from './today-data.js';
import { today } from './util.js';
import { appendLinkedText, button, el, link } from './work-dom.js';

const s = strings.work;
const objectHref = (route, path) => '#' + route + '/' + encodeURIComponent(path);
function statusLabel(status, type) {
  const labels = type === 'idea' ? s.ideaStatuses : s.status;
  const key = type === 'idea' ? ideaStatus(status) : status;
  return Object.hasOwn(labels, key) ? labels[key] : status;
}
const planJson = value => JSON.stringify(value, null, 2) + '\n';

function textBlock(value) {
  const node = el('p', undefined, 'work-text');
  appendLinkedText(node, String(value));
  return node;
}

function renderCard(card, route) {
  const anchor = link('', objectHref(route, card.path), 'work-card work-object');
  const head = el('div', undefined, 'work-card-head');
  const badge = el('span', statusLabel(card.status, card.type), 'badge');
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

export function createObjectView(panel, { fixture, onResponse, onFirstRender }) {
  const heading = el('h1');
  const notice = el('div', undefined, 'work-notice');
  notice.setAttribute('role', 'status');
  const content = el('div', undefined, 'work-content');
  panel.append(heading, notice, content);
  let scope;
  let view;
  let selectedArea;
  let ideaArea;
  let ideaFilter;
  let ideaDrafts;

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
    return JSON.parse((await active.lab.refresh(planPath)).text);
  }

  async function writePlan(active, expectedDay, change, commit) {
    const result = await active.client.update(planPath, input => {
      const plan = JSON.parse(input);
      if (plan.date !== expectedDay) throw new RangeError('The plan changed day');
      const updated = change(plan);
      return updated === plan ? input : planJson(updated);
    }, 'lab: web — ' + commit);
    active.lab.remember(planPath, result);
    return JSON.parse(result.text);
  }


  function displayList(current, entries, configText) {
    const date = fixture ? '2030-01-15' : today();
    current.config = parseAreas(configText);
    current.date = date;
    current.cards = objectList(entries, current.config, date);
    render();
    onFirstRender(current.route);
    if (current.route === 'ideas' && !current.planScheduled) {
      current.planScheduled = true;
      // Read the plan after the catalog has had a frame to paint.
      requestAnimationFrame(() => requestAnimationFrame(() => loadIdeaPlan(current)));
    }
  }

  async function load(current) {
    const active = scope;
    const { client, lab } = active;
    const cachedConfig = lab.peek(areasPath)?.text ?? '';
    const entries = !current.path && lab.peekObjects();
    if (current.route === 'ideas') {
      const cachedPlan = lab.peek(planPath);
      current.plan = cachedPlan ? JSON.parse(cachedPlan.text) : undefined;
    }
    if (entries) {
      displayList(current, entries, cachedConfig);
      feedback();
    } else {
      content.replaceChildren();
      feedback(s.loading);
    }
    try {
      await active.pending?.catch(() => {});
      if (current !== view) return;
      if (current.path && !isObjectPath(current.path)) {
        render();
        feedback();
        return;
      }
      const config = lab.refresh(areasPath, '');
      if (current.path) {
        const file = client.getFile(current.path).catch(error => {
          if (error.status === 404) return null;
          throw error;
        });
        const [areaFile, detail] = await Promise.all([config, file]);
        if (current !== view) return;
        current.config = parseAreas(areaFile.text);
        current.date = fixture ? '2030-01-15' : today();
        current.detail = detail && objectCard(current.path, detail.text, current.config, current.date);
        render();
      } else {
        const [areaFile, updated] = await Promise.all([config, lab.refreshObjects()]);
        await active.pending?.catch(() => {});
        if (current !== view) return;
        const latest = lab.peekObjects() ?? updated;
        if (!entries || areaFile.text !== cachedConfig || JSON.stringify(latest) !== JSON.stringify(entries)) {
          displayList(current, latest, areaFile.text);
        }
      }
      feedback();
    } catch {
      if (current !== view) return;
      const retry = button(s.retry, () => load(current));
      if (entries) {
        feedback(s.loadError, true);
        notice.append(' ', retry);
      } else {
        content.replaceChildren(el('p', s.loadError), retry);
        feedback();
      }
    } finally {
      onResponse(client);
    }
  }

  function updateCard(card, mutate, description, commit, onSuccess, onFailure) {
    const current = view;
    transact(async active => {
      const at = fixture ? new Date(current.date + 'T10:30') : new Date();
      const result = await saveObjectEdit(active.client, card, mutate, { at, description, commit });
      active.journal = result.saveJournal;
      active.lab.patchObject(card.path, result.text);
      if (current.path) current.detail = objectCard(card.path, result.text, current.config, current.date);
      else current.cards = objectList(active.lab.peekObjects(), current.config, current.date);
      onSuccess?.();
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
      const display = key === 'status' ? statusLabel(value, card.type)
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
    summary.append(el('p', s.type[card.type] + ' · ' + (statusLabel(card.status, card.type) ?? ''), 'work-muted'));
    if (card.nextStep) summary.append(el('h2', s.nextStep), textBlock(card.nextStep));
    const actions = el('div', undefined, 'actions');
    const statuses = mutable(el('select'));
    statuses.setAttribute('aria-label', s.setStatus);
    const choices = statusOptions[card.type];
    const options = choices.includes(card.status) ? choices : [card.status ?? '', ...choices];
    for (const status of options) {
      const option = el('option', statusLabel(status, card.type));
      option.value = status;
      option.disabled = !choices.includes(status);
      statuses.append(option);
    }
    statuses.value = card.status ?? '';
    statuses.addEventListener('change', () => {
      const next = statuses.value;
      updateCard(card, (text, date) => editStatus(text, card.type, next, date),
        s.setStatus + ': ' + statusLabel(next, card.type), 'object status', undefined, () => { statuses.value = card.status ?? ''; });
    });
    const add = mutable(button(s.addToPlan, () => transact(async active => {
      const plan = await readPlan(active);
      const at = fixture ? new Date(plan.date + 'T10:30') : new Date();
      await writePlan(active, plan.date, data => card.type === 'idea' ? addIdeaToPlan(data, card, at) : addObjectToPlan(data, card, at), 'add object to plan');
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


  function renderIdea(card) {
    const current = view;
    const row = el('article', undefined, 'work-card work-idea');
    const title = el('h3');
    title.append(link(card.title, objectHref('ideas', card.path)));
    const { purpose, origin, main_risk: risk } = card.attributes;
    const status = ideaStatus(card.status);
    const area = current.config.areas.find(item => item.id === card.area);
    const meta = [
      Object.hasOwn(s.purpose, purpose) ? s.purpose[purpose] : purpose,
      area?.title ?? card.area, statusLabel(status, 'idea'), origin === 'agent' ? s.origin.agent : s.origin.owner,
    ].filter(Boolean);
    row.append(title, el('p', meta.join(' · '), 'work-muted idea-meta'));
    if (risk) row.append(el('p', s.ideaRisk(risk), 'idea-risk'));

    const actions = el('div', undefined, 'idea-actions');
    const reactions = el('div', undefined, 'work-reactions idea-reactions');
    for (const [value, icon, label] of s.ideaActions) {
      const react = mutable(button(icon, () => {
        const atStatus = statusLabel(value, 'idea');
        updateCard(card, (text, date) => editStatus(text, 'idea', value, date),
          s.setStatus + ': ' + atStatus, 'idea status');
      }));
      react.setAttribute('aria-label', label);
      react.setAttribute('aria-pressed', String(status === value));
      reactions.append(react);
    }

    const form = el('form', undefined, 'idea-edit');
    const input = mutable(el('input'));
    input.placeholder = s.ideaEdit;
    input.setAttribute('aria-label', s.ideaEdit);
    input.value = ideaDrafts.get(card.id) ?? '';
    input.addEventListener('input', () => ideaDrafts.set(card.id, input.value));
    form.append(input);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const comment = input.value.trim();
      const drafts = ideaDrafts;
      if (!comment || input.disabled) return;
      updateCard(card, (text, date) => editIdeaComment(text, comment, date), s.ideaEdited, 'idea comment',
        () => drafts.delete(card.id));
    });

    const planButton = mutable(button(s.ideaAdd, () => transact(async active => {
      const at = fixture ? new Date(current.plan.date + 'T10:30') : new Date();
      current.plan = await writePlan(active, current.plan.date, plan => addIdeaToPlan(plan, card, at), 'add idea to plan');
    }, s.addedToPlan), 'btn small idea-plan'));
    planButton.dataset.ref = card.id;
    actions.append(reactions, form, planButton);
    row.append(actions);
    return row;
  }

  function updatePlanButtons() {
    for (const control of content.querySelectorAll('.idea-plan')) {
      const planned = view.plan && ideaInPlan(view.plan, control.dataset.ref);
      control.textContent = planned ? s.ideaInPlan : s.ideaAdd;
      control.dataset.disabled = String(!view.plan || Boolean(planned));
    }
    setBusy();
  }

  async function loadIdeaPlan(current) {
    if (current !== view) return;
    const active = scope;
    try {
      current.plan = await readPlan(active);
      if (current === view) updatePlanButtons();
    } catch {
      if (current !== view) return;
      feedback(s.planLoadError, true);
      notice.append(' ', button(s.retry, () => {
        feedback();
        loadIdeaPlan(current);
      }));
    } finally {
      onResponse(active.client);
    }
  }

  // «Идеи дня» from today.json (unreacted) — reacted to here, not on «Сегодня».
  function renderDailyIdeas() {
    const plan = view.plan;
    const ideas = (plan?.ideas ?? []).filter(idea => !idea.reaction);
    if (!ideas.length) return [];
    const labels = strings.work;
    const section = el('section', undefined, 'work-group daily-ideas');
    section.append(el('h2', labels.dailyIdeas + ' · ' + ideas.length));
    for (const idea of ideas) {
      const id = idea.id ?? idea.ref;
      const row = el('article', undefined, 'work-card work-daily-idea');
      const card = view.cards.find(c => c.id === id);
      row.append(el('h3', undefined));
      row.lastChild.append(card ? link(idea.title ?? id, objectHref('ideas', card.path)) : idea.title ?? id);
      const pitch = idea.pitch ?? idea.summary;
      if (pitch) row.append(el('p', pitch, 'work-text'));
      if (idea.main_risk) row.append(el('p', s.riskLine(idea.main_risk), 'work-muted'));
      const react = (patch, commit) => transact(async active => {
        view.plan = await writePlan(active, plan.date, data => editDailyIdea(data, idea, patch), commit);
      });
      const reactions = el('div', undefined, 'actions work-reactions');
      for (const [reaction, [icon, label]] of Object.entries(labels.reactions)) {
        reactions.append(mutable(button(icon, () => react({ reaction }, 'daily idea reaction'), { label })));
      }
      const comment = el('input');
      comment.type = 'text';
      comment.value = ideaDrafts?.get?.(id) ?? idea.comment ?? '';
      comment.placeholder = labels.ownerComment + ' (Enter — сохранить)';
      comment.setAttribute('aria-label', labels.ownerComment);
      comment.className = 'daily-idea-comment';
      comment.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        react({ comment: comment.value.trim() }, 'daily idea comment');
      });
      reactions.append(mutable(comment));
      row.append(reactions);
      section.append(row);
    }
    return [section];
  }

  function renderIdeas() {
    const { counts, visible } = ideaList(view.cards, ideaArea, ideaFilter);
    const filters = el('div', undefined, 'idea-filters');
    const tabs = el('nav', undefined, 'work-tabs');
    tabs.setAttribute('aria-label', s.ideaFilters);
    for (const status of ideaFilterStatuses) {
      const label = (status === 'killed' ? '✕ ' : '') + s.ideaStatuses[status];
      const pill = button(label + ' (' + counts[status] + ')', () => {
        ideaFilter = status;
        render();
        content.querySelector('.idea-filters [aria-current]').focus();
      });
      pill.dataset.status = status;
      if (status === ideaFilter) pill.setAttribute('aria-current', 'true');
      tabs.append(pill);
    }
    const select = el('select');
    select.setAttribute('aria-label', s.areaFilter);
    for (const { id, title } of [{ id: '', title: s.allAreas }, ...view.config.areas]) {
      const option = el('option', title);
      option.value = id;
      select.append(option);
    }
    select.value = ideaArea;
    select.addEventListener('change', () => {
      ideaArea = select.value;
      render();
      content.querySelector('.idea-filters select').focus();
    });
    filters.append(tabs, select);
    const cards = el('div', undefined, 'work-group idea-list');
    cards.append(...(visible.length ? visible.map(renderIdea) : [el('p', s.noIdeas, 'work-muted')]));
    return [...renderDailyIdeas(), filters, cards];
  }

  function render() {
    const card = view.detail;
    heading.textContent = card?.title ?? strings[view.route];
    if (!view.path && view.route === 'ideas' && !view.config.areas.some(area => area.id === ideaArea)) ideaArea = '';
    content.replaceChildren(...(view.path ? renderDetail(card) : view.route === 'ideas' ? renderIdeas() : renderBoard()));
    updatePlanButtons();
  }

  return {
    show(client, lab, route, path) {
      if (scope?.client !== client) {
        scope = { client, lab };
        selectedArea = undefined;
        ideaArea = '';
        ideaFilter = 'all';
        ideaDrafts = new Map();
        view = undefined;
      }
      if (view?.route === route && view.path === path) return;
      const current = view = { route, path };
      heading.textContent = strings[route];
      if (client) load(current);
      else {
        feedback();
        content.replaceChildren(link(strings.settings, '#settings'));
      }
      window.scrollTo(0, 0);
    },
    hide() { view = undefined; },
  };
}
