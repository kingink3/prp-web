import { CODEX_PATH, codexPrompt, parseCodexTasks, updateCodexTask } from './codex.js';
import { completeEvening, pickCandidate, previousPlan, saveEveningNote, scheduleTest,
  stepModel, writeResumeNote } from './check-in-data.js';
import { saveObjectEdit } from './objects.js';
import { routinePayload } from './routine.js';
import { strings } from './strings.js';
import { carryDue, editDailyIdea, editPlanText, planPath, postpone, referencePath, removeItem, todoPath } from './today-data.js';
import { eveningDate, localIsoMinutes } from './util.js';
import { button, el, link, showNotice } from './work-dom.js';

const s = strings.checkIn;
const work = strings.work;
const ratio = ({ done, total }) => s.ratio(done, total);
const minutes = strings.todayView.minutes;
const emptyTodos = '{"todos":[]}';
const emptyCodex = '{"tasks":[]}';

export function createCheckInView(panel, { fixture, routine, onResponse }) {
  const heading = el('h1');
  const steps = el('nav', undefined, 'msteps');
  steps.setAttribute('aria-label', s.steps);
  const body = el('div', undefined, 'mbody');
  const content = el('div', undefined, 'checkin-content');
  const notice = el('p', undefined, 'notice');
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  const navigation = el('div', undefined, 'actions checkin-navigation');
  body.append(notice, content, navigation);
  panel.append(heading, steps, body);
  let view;
  let suspended;
  let session;

  const current = state => view === state;

  function stamp(state) {
    const at = new Date();
    if (!fixture) return at;
    const date = new Date(state.plan.date + 'T12:00');
    if (at.getHours() < 4) date.setDate(date.getDate() + 1);
    date.setHours(at.getHours(), at.getMinutes(), at.getSeconds(), at.getMilliseconds());
    return date;
  }

  function control(text, action, className = 'btn') {
    const node = button(text, action, className);
    node.dataset.checkinAction = '';
    return node;
  }

  function setBusy(state, busy) {
    state.busy = busy;
    if (!current(state)) return;
    body.setAttribute('aria-busy', String(busy));
    for (const node of body.querySelectorAll('button[data-checkin-action], input')) {
      node.disabled = busy || node.hasAttribute('data-unavailable');
    }
  }

  function unavailable(node, hint) {
    node.dataset.unavailable = '';
    node.title = hint;
    node.disabled = true;
    return node;
  }

  async function run(state, action) {
    if (!current(state) || state.busy) return;
    setBusy(state, true);
    showNotice(notice, '');
    try {
      await action();
      if (current(state)) render(state);
    } catch {
      if (current(state)) showNotice(notice, work.saveError, 'error');
    } finally {
      setBusy(state, false);
      onResponse(state.client);
    }
  }

  async function apply(state, mutate, description) {
    const at = stamp(state);
    const result = await state.client.update(planPath,
      text => editPlanText(text, state.plan.date, plan => mutate(plan, at)), 'lab: web — ' + description);
    state.lab.remember(planPath, result);
    state.plan = JSON.parse(result.text);
  }

  async function load(state) {
    content.replaceChildren(el('p', work.loading, 'work-muted'));
    try {
      const { lab } = state;
      const requests = [lab.refresh(planPath), lab.refresh(todoPath, emptyTodos),
        lab.refresh(CODEX_PATH, emptyCodex), lab.refreshObjects()];
      const [plan, todos, codex, objects] = await Promise.all(requests);
      if (!current(state)) return;
      state.plan = JSON.parse(plan.text);
      state.todos = JSON.parse(todos.text).todos ?? [];
      state.tasks = parseCodexTasks(codex.text).tasks;
      state.objects = objects;
      state.day = fixture ? state.plan.date : eveningDate();
      if (session?.lab !== lab || session?.day !== state.day) {
        session = { lab, day: state.day, kept: new Set(), sent: new Set(), drafts: new Map(), notes: new Map() };
      }
      state.session = session;
      state.previous = state.evening ? null : await previousPlan(lab, state.day).catch(() => null);
      if (current(state)) render(state);
    } catch {
      if (current(state)) content.replaceChildren(el('p', work.loadError), button(work.retry, () => load(state)));
    } finally {
      onResponse(state.client);
    }
  }

  function budget(value, limit) {
    const element = el('div', undefined, 'checkin-budget');
    const bar = el('progress', undefined, 'bbar');
    const label = s.budget(value, limit);
    bar.max = limit > 0 ? limit : Math.max(value, 1);
    bar.value = value;
    bar.classList.toggle('over-budget', limit > 0 && value > limit);
    bar.setAttribute('aria-label', label);
    element.append(el('span', label, 'work-muted'), bar);
    return element;
  }

  function cards(entries) {
    const grid = el('div', undefined, 'mcards');
    for (const [title, value, detail] of entries) {
      const card = el('div', undefined, 'mcard');
      card.append(el('span', title, 'work-muted'), el('b', value));
      if (detail) card.append(el('small', detail, 'work-muted'));
      grid.append(card);
    }
    return grid;
  }

  function row(title, detail, actions = []) {
    const item = el('article', undefined, 'mcard checkin-row');
    const text = el('div');
    text.append(el('h3', title));
    if (detail) text.append(el('p', detail, 'work-text work-muted'));
    item.append(text);
    if (actions.length) {
      const controls = el('div', undefined, 'actions');
      controls.append(...actions);
      item.append(controls);
    }
    return item;
  }

  function section(title, rows, empty = s.empty) {
    const element = el('section', undefined, 'checkin-section');
    element.append(el('h2', title), ...(rows.length ? rows : [el('p', empty, 'work-muted')]));
    return element;
  }

  function inputRow(title, value, hint, save, onInput) {
    const form = el('form', undefined, 'checkin-entry');
    const label = el('label', title, 'field');
    const input = el('input');
    input.type = 'text';
    input.placeholder = hint;
    input.value = value;
    if (onInput) input.addEventListener('input', () => onInput(input.value));
    const submit = el('button', s.save, 'btn');
    submit.type = 'submit';
    submit.dataset.checkinAction = '';
    label.append(input);
    form.append(label, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      save(input.value.trim());
    });
    return form;
  }

  function planRows(state, items, step) {
    return items.map(item => {
      const ifOpen = mutate => (plan, at) =>
        plan.items.some(entry => entry.id === item.id && !entry.done) ? mutate(plan, at) : plan;
      const actions = [];
      if (step === 'tails') actions.push(control(s.keep, () => {
        state.session.kept.add(item.id);
        render(state);
        content.querySelector('button')?.focus();
      }));
      actions.push(control(s.postpone, () => run(state, () =>
        apply(state, ifOpen((plan, at) => postpone(plan, item.id, at, plan.date)), 'postpone item'))));
      if (step !== 'plan') actions.push(control(step === 'tails' ? s.remove : s.unschedule, () => run(state, () =>
        apply(state, ifOpen(plan => removeItem(plan, 'items', item.id)), 'remove item'))));
      const detail = [item.minutes && minutes(item.minutes), item.blocker].filter(Boolean).join(' · ');
      return row(item.title ?? item.task, detail, actions);
    });
  }

  function ideaRows(state, ideas) {
    return ideas.map(idea => {
      const id = idea.id ?? idea.ref;
      const edit = patch => run(state, async () => {
        await apply(state, plan => editDailyIdea(plan, idea, patch), 'comment' in patch ? 'daily idea comment' : 'daily idea reaction');
        state.session.drafts.delete(id);
      });
      const actions = Object.entries(work.reactions).map(([reaction, [icon, label]]) => {
        const react = control(icon, () => edit({ reaction }));
        react.setAttribute('aria-label', label);
        return react;
      });
      const card = row(idea.title ?? id, idea.summary ?? idea.pitch, actions);
      card.append(inputRow(s.ideaEdit, state.session.drafts.get(id) ?? idea.comment ?? '', s.enter,
        comment => edit({ comment }), value => state.session.drafts.set(id, value)));
      return card;
    });
  }

  function pick(state, entry) {
    return control(s.add(entry.minutes), () => run(state, () =>
      apply(state, (plan, at) => pickCandidate(plan, entry, at), 'add plan item')));
  }

  function choiceRow(entry, actions) {
    return row(entry.title, entry.task !== entry.title ? entry.task : '', actions);
  }

  function morningTest(state, entry) {
    const controls = [pick(state, entry)];
    if (entry.kind === 'idea') {
      const payload = 'test: ' + entry.ref;
      const sent = state.session.sent.has(entry.ref);
      const send = control(sent ? s.agentPending : s.agents, () => run(state, async () => {
        if (await routine.dispatch(payload, notice)) state.session.sent.add(entry.ref);
      }));
      if (sent) unavailable(send, s.agentPending);
      else if (!routine.routineReady() || !routinePayload(payload)) unavailable(send, strings.moreView.missingRoutine);
      controls.push(send);
    }
    return choiceRow(entry, controls);
  }

  function copyTask(state, task) {
    return run(state, async () => {
      const labels = strings.moreView;
      try {
        await navigator.clipboard.writeText(codexPrompt(task, state.repository));
      } catch {
        if (current(state)) showNotice(notice, labels.copyFailed, 'error');
        return;
      }
      try {
        const at = localIsoMinutes(stamp(state));
        const result = await state.client.update(CODEX_PATH,
          text => updateCodexTask(text, task, 'copy', state.repository, at), 'lab: web — send Codex task ' + task.id);
        state.lab.remember(CODEX_PATH, result);
        state.tasks = parseCodexTasks(result.text).tasks;
        const sent = state.tasks.find(entry => entry?.id === task.id)?.status === 'sent';
        if (current(state)) showNotice(notice, sent ? labels.changed.copy : labels.copiedStale, sent ? 'success' : 'error');
      } catch {
        if (current(state)) showNotice(notice, labels.copiedSaveFailed, 'error');
      }
    });
  }

  function briefLink(plan) {
    const value = plan.brief_url ?? plan.brief?.url ?? plan.brief;
    if (typeof value === 'string') {
      try {
        const url = new URL(value);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
          return link(s.brief, url.href);
        }
      } catch { /* Older plans may omit a usable brief link. */ }
    }
    return link(s.openPlan, '#today');
  }

  function morning(state, model) {
    const { previous, stats } = model;
    switch (state.step) {
      case 0:
        return [
          cards([
            [s.previous, previous ? s.timeRatio(ratio(previous), minutes(previous.elapsed)) : s.noHistory,
              previous && s.postponedCount(previous.postponed)],
            [s.today, s.openCount(model.open.length), s.todayMinutes(stats.planned, model.budget, model.learningMinutes)],
            [s.dailyIdeas, model.waiting.length ? s.waiting(model.waiting.length) : s.reviewed],
            [s.codex, s.onReview(model.review), s.readyCount(model.ready)],
          ]), briefLink(state.plan),
        ];
      case 1:
        return [section(s.morning[1], planRows(state, model.tails, 'tails'), s.noTails)];
      case 2:
        return [section(s.dailyIdeas, ideaRows(state, model.waiting), s.reviewed)];
      case 3:
        return [
          budget(stats.planned, model.budget),
          ...(model.waiting.length ? [section(s.dailyIdeas, ideaRows(state, model.waiting))] : []),
          section(s.planned, planRows(state, model.open, 'plan')),
          section(s.projects, model.candidates.map(entry => choiceRow(entry, [pick(state, entry)]))),
          section(s.tests, model.morningTests.map(entry => morningTest(state, entry))),
          ...(model.morningTests.some(entry => entry.kind === 'idea') && !routine.routineReady()
            ? [el('p', strings.moreView.missingRoutine, 'hint')] : []),
          section(s.giveCodex, model.codex.map(task => row(task.title, strings.moreView.status[task.status], [
            control(s.copy, () => copyTask(state, task)),
          ]))),
        ];
      default:
        const actions = el('div', undefined, 'actions');
        actions.append(link(s.start, '#today', 'btn primary'));
        if (model.first) actions.append(link(s.focus, '#today/focus', 'btn'));
        return [
          budget(stats.planned, model.budget), section(s.first, model.first ? [row(model.first.title ?? model.first.text)] : []),
          actions,
        ];
    }
  }

  async function saveNote(state, entry, text) {
    const ref = entry.id;
    const pending = state.session.notes;
    let workInProgress = pending.get(ref);
    if (!workInProgress) {
      const at = stamp(state);
      workInProgress = { text, day: state.plan.date, at };
      pending.set(ref, workInProgress);
    }
    if (workInProgress.day !== state.plan.date) throw new RangeError('The plan changed day');
    if (!workInProgress.objectSaved) {
      const path = referencePath(ref);
      const result = await saveObjectEdit(state.client, { path, id: ref },
        markdown => writeResumeNote(markdown, workInProgress.text, workInProgress.day),
        { at: workInProgress.at, day: workInProgress.day, description: workInProgress.text, commit: 'save evening note' });
      workInProgress.objectSaved = true;
      workInProgress.saveJournal = result.saveJournal;
      state.lab.remember(path, { text: result.text, sha: result.sha });
      state.lab.patchObject(path, result.text);
      state.objects = state.lab.peekObjects();
    }
    if (workInProgress.saveJournal) {
      await workInProgress.saveJournal();
      workInProgress.saveJournal = undefined;
    }
    await apply(state, plan => saveEveningNote(plan, ref, workInProgress.text), 'record evening note');
    pending.delete(ref);
    if (text !== workInProgress.text) await saveNote(state, entry, text);
    if (current(state)) showNotice(notice, work.saved, 'success');
  }

  function evening(state, model) {
    switch (state.step) {
      case 0:
        return [
          budget(model.stats.elapsed, model.stats.planned),
          cards([
            [s.done, ratio(model.stats), s.spent(model.stats.spent)],
            [s.groups, Object.values(model.groupCounts).map(ratio).join(' · ')],
            [s.doneTodos, String(model.doneTodos)], [s.merged, String(model.merged)],
          ]),
        ];
      case 1:
        return [section(s.evening[1], planRows(state, model.open, 'evening'))];
      case 2:
        return [section(s.evening[2], model.refs.map(entry => {
          const card = row(entry.title);
          const value = state.session.drafts.get(entry.id) ?? state.session.notes.get(entry.id)?.text ?? entry.note;
          card.append(inputRow(s.evening[2], value, s.enter, text => run(state, async () => {
            if (!text && !entry.note && !state.session.notes.has(entry.id)) return;
            await saveNote(state, entry, text);
            state.session.drafts.delete(entry.id);
          }), text => state.session.drafts.set(entry.id, text)));
          return card;
        }))];
      case 3:
        return [section(s.tests, model.eveningTests.map(entry => choiceRow(entry, [
          control(s.addTomorrow, () => run(state, () =>
            apply(state, (plan, at) => scheduleTest(plan, entry, at), 'schedule test for tomorrow'))),
        ])))];
      default:
        return [
          budget(model.draft.planned, model.budget),
          section(s.postponed, model.draft.postponed.map(item => row(item.title, item.minutes && minutes(item.minutes)))),
          section(work.nextStep, model.draft.projects.map(entry => choiceRow(entry, []))),
          model.doneAt ? el('p', s.completedAt(model.doneAt.slice(11, 16)), 'notice success') :
            control(s.complete, () => run(state, () => apply(state, completeEvening,
              'complete evening check-in')), 'btn primary'),
        ];
    }
  }

  function jump(state, index) {
    state.step = index;
    showNotice(notice, '');
    render(state);
    steps.querySelector('[aria-current]')?.focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'start' });
  }

  function render(state) {
    const model = stepModel(carryDue(state.plan), state.todos, state.tasks, state.objects, state.previous, state.session.kept);
    const labels = state.evening ? s.evening : s.morning;
    steps.replaceChildren(...labels.map((label, index) => {
      const pill = button(label, () => jump(state, index), index < state.step ? 'past' : index === state.step ? 'on' : '');
      if (index === state.step) pill.setAttribute('aria-current', 'step');
      return pill;
    }));
    content.replaceChildren(...(state.evening ? evening(state, model) : morning(state, model)));
    navigation.replaceChildren(
      ...(state.step > 0 ? [button(work.back, () => jump(state, state.step - 1), 'btn')] : []),
      ...(state.step < 4 ? [button(s.next, () => jump(state, state.step + 1), 'btn primary')] : []),
    );
    setBusy(state, Boolean(state.busy));
  }

  return {
    show(client, lab, repository, evening) {
      if (view?.client === client && view.evening === evening) return;
      if (suspended?.busy && suspended.client === client && suspended.evening === evening) {
        view = suspended;
        suspended = undefined;
        render(view);
        return;
      }
      suspended = undefined;
      view = { client, lab, repository, evening, step: 0 };
      heading.textContent = evening ? strings.evening : strings.morning;
      steps.replaceChildren();
      navigation.replaceChildren();
      showNotice(notice, '');
      if (client) load(view);
      else content.replaceChildren(link(strings.settings, '#settings'));
    },
    hide() {
      if (view?.busy) suspended = view;
      view = undefined;
    },
  };
}
