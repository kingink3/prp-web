import { ideaFilterStatuses, ideaList, ideaStatus } from './ideas.js';
import { areasPath } from './lab-data.js';
import { editIdeaComment, editStatus, objectHref, objectList, parseAreas,
  saveObjectEdit } from './objects.js';
import { strings } from './strings.js';
import { addIdeaToPlan, editDailyIdea, ideaInPlan, planPath } from './today-data.js';
import { today } from './util.js';
import { button, el, link } from './work-dom.js';

const s = strings.work;
function statusLabel(status, type) {
  const labels = type === 'idea' ? s.ideaStatuses : s.status;
  const key = type === 'idea' ? ideaStatus(status) : status;
  return Object.hasOwn(labels, key) ? labels[key] : status;
}
const planJson = value => JSON.stringify(value, null, 2) + '\n';

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
    const entries = lab.peekObjects();
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
      const [areaFile, updated] = await Promise.all([lab.refresh(areasPath, ''), lab.refreshObjects()]);
      await active.pending?.catch(() => {});
      if (current !== view) return;
      const latest = lab.peekObjects() ?? updated;
      if (!entries || areaFile.text !== cachedConfig || JSON.stringify(latest) !== JSON.stringify(entries)) {
        displayList(current, latest, areaFile.text);
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
      current.cards = objectList(active.lab.peekObjects(), current.config, current.date);
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
      if (current === view) {
        // ideas of the day come from the plan: draw them once it is loaded
        if ((current.plan?.ideas ?? []).some(idea => !idea.reaction)) render();
        else updatePlanButtons();
      }
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
    heading.textContent = strings[view.route];
    if (view.route === 'ideas' && !view.config.areas.some(area => area.id === ideaArea)) ideaArea = '';
    content.replaceChildren(...(view.route === 'ideas' ? renderIdeas() : renderBoard()));
    updatePlanButtons();
  }

  return {
    show(client, lab, route) {
      if (scope?.client !== client) {
        scope = { client, lab };
        selectedArea = undefined;
        ideaArea = '';
        ideaFilter = 'all';
        ideaDrafts = new Map();
        view = undefined;
      }
      if (view?.route === route) return;
      const current = view = { route };
      heading.textContent = strings[route];
      if (client) load(current);
      else {
        feedback();
        content.replaceChildren(link(strings.settings, '#settings'));
      }
      window.scrollTo(0, 0);
    },
    syncDrawer({ object, plan }) {
      if (!view?.cards) return;
      if (plan && view.route === 'ideas') view.plan = JSON.parse(scope.lab.peek(planPath).text);
      if (object) view.cards = objectList(scope.lab.peekObjects(), view.config, view.date);
      if (object || (plan && view.route === 'ideas')) render();
    },
    hide() { view = undefined; },
  };
}
