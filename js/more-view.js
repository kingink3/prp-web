import { CODEX_PATH, CODEX_STATUSES, codexActionStatus, codexPrompt, codexPullRequest, parseCodexTasks, updateCodexTask } from './codex.js';
import { fireRoutine, isRoutineUrl, routinePayload } from './routine.js';
import { strings } from './strings.js';
import { localIsoMinutes } from './util.js';
import { button, el, link, showNotice } from './work-dom.js';

const s = strings.moreView;
const commitActions = { copy: 'send Codex task', cancel: 'cancel Codex task', reopen: 'reopen Codex task' };

export function createMoreView(panel, { fixture, getRoutine, onResponse }) {
  const form = panel.querySelector('#instant-form');
  const input = panel.querySelector('#instant-text');
  const send = panel.querySelector('#instant-send');
  const notice = panel.querySelector('#instant-notice');
  const taskNotice = panel.querySelector('#codex-notice');
  const taskList = panel.querySelector('#codex-list');
  const refresh = panel.querySelector('#codex-refresh');
  let view;
  let firing = false;

  async function dispatch(text, feedback) {
    if (firing) return showNotice(feedback, s.requestInFlight);
    if (!routinePayload(text)) return showNotice(feedback, s.invalidPayload, 'error');
    const config = getRoutine();
    if (fixture) return showNotice(feedback, s.fixtureRoutine, 'error');
    if (!isRoutineUrl(config.url) || !config.token) return showNotice(feedback, s.missingRoutine, 'error');
    firing = send.disabled = true;
    showNotice(feedback, s.sending);
    try {
      const status = await fireRoutine(config, text);
      if (status === null) showNotice(feedback, s.sentRequest, 'success');
      else showNotice(feedback, s.httpHints[status] || s.httpError(status), 'error');
    } catch {
      showNotice(feedback, s.network, 'error');
    } finally {
      firing = send.disabled = false;
    }
  }

  for (const control of form.querySelectorAll('[data-payload]')) {
    control.addEventListener('click', () => {
      input.value = control.dataset.payload;
      input.focus();
    });
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    dispatch(input.value, notice);
  });
  refresh.addEventListener('click', () => load(view));

  async function load(state) {
    if (!state?.client || state.busy) return;
    setBusy(state, true);
    showNotice(taskNotice, s.loading);
    try {
      const file = await state.client.getFile(CODEX_PATH).catch(error => {
        if (error.status === 404) return { text: '{"tasks":[]}' };
        throw error;
      });
      if (view !== state) return;
      state.tasks = parseCodexTasks(file.text).tasks;
      showNotice(taskNotice, '');
      render(state);
    } catch {
      if (view === state) showNotice(taskNotice, s.loadError, 'error');
    } finally {
      onResponse(state.client);
      setBusy(state, false);
    }
  }

  function setBusy(state, busy) {
    state.busy = busy;
    if (view !== state) return;
    taskList.setAttribute('aria-busy', String(busy));
    refresh.disabled = busy;
    for (const control of taskList.querySelectorAll('button')) control.disabled = busy;
  }

  async function change(state, task, action) {
    if (state.busy || view !== state) return;
    setBusy(state, true);
    showNotice(taskNotice, '');
    try {
      if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(codexPrompt(task, state.repository));
        } catch {
          if (view === state) showNotice(taskNotice, s.copyFailed, 'error');
          return;
        }
      }
      const at = localIsoMinutes();
      const file = await state.client.update(CODEX_PATH,
        text => updateCodexTask(text, task, action, state.repository, at),
        `lab: web — ${commitActions[action]} ${task.id}`);
      if (view !== state) return;
      state.tasks = parseCodexTasks(file.text).tasks;
      const current = state.tasks.find(item => item?.id === task.id);
      const updated = current?.status === codexActionStatus(task.status, action);
      showNotice(taskNotice, updated ? s.changed[action] : action === 'copy' ? s.copiedStale : s.stale,
        updated ? 'success' : 'error');
      render(state, task.id);
    } catch {
      if (view === state) showNotice(taskNotice, action === 'copy' ? s.copiedSaveFailed : s.saveError, 'error');
    } finally {
      onResponse(state.client);
      setBusy(state, false);
    }
  }

  async function approve(state, task, pr) {
    if (state.busy || view !== state) return;
    if (firing) return showNotice(taskNotice, s.requestInFlight);
    if (!window.confirm(s.confirmMerge(task.pr, pr.repo))) return;
    setBusy(state, true);
    showNotice(taskNotice, '');
    try {
      const { text } = await state.client.getFile(CODEX_PATH);
      if (view !== state) return;
      state.tasks = parseCodexTasks(text).tasks;
      const current = state.tasks.find(item => item?.id === task.id);
      if (current?.status !== 'review' || codexPullRequest(current, state.repository)?.href !== pr.href) {
        showNotice(taskNotice, s.stale, 'error');
        render(state, task.id);
        return;
      }
      await dispatch(pr.payload, taskNotice);
    } catch {
      if (view === state) showNotice(taskNotice, s.loadError, 'error');
    } finally {
      onResponse(state.client);
      setBusy(state, false);
    }
  }

  function render(state, focusId) {
    const groups = [];
    let focusRow;
    for (const status of CODEX_STATUSES) {
      const tasks = state.tasks.filter(task => task?.status === status);
      if (!tasks.length) continue;
      const group = el('section', undefined, 'codex-group');
      const rows = el('ul', undefined, 'work-list');
      for (const task of tasks) {
        const row = el('li', undefined, 'codex-task');
        row.dataset.codexId = task.id;
        const title = el('p', task.title, 'codex-title');
        const meta = el('p', task.id, 'work-muted');
        const pr = codexPullRequest(task, state.repository);
        if (pr) {
          const anchor = link(s.pr(task.pr), pr.href);
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          meta.append(' · ', anchor);
        }
        row.append(title, meta);
        const actions = el('div', undefined, 'actions');
        if (status === 'review' && pr) actions.append(button(s.merge, () => approve(state, task, pr)));
        for (const action of ['copy', 'cancel', 'reopen']) {
          if (codexActionStatus(status, action)) actions.append(button(s[action], () => change(state, task, action)));
        }
        if (actions.childElementCount) row.append(actions);
        rows.append(row);
        if (task.id === focusId) focusRow = row;
      }
      group.dataset.codexStatus = status;
      group.append(el('h3', s.status[status]), rows);
      groups.push(group);
    }
    taskList.replaceChildren(...(groups.length ? groups : [el('p', s.empty, 'work-muted')]));
    if (focusRow) {
      focusRow.tabIndex = -1;
      focusRow.focus();
    }
  }

  return {
    show(client, repository) {
      if (view?.client === client) return;
      view = { client, repository };
      refresh.hidden = !client;
      showNotice(taskNotice, '');
      taskList.replaceChildren();
      if (client) load(view);
      else taskList.append(link(strings.settings, '#settings'));
    },
    hide() { view = undefined; },
  };
}
