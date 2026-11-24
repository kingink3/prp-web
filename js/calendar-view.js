import { adjacentMonth, currentHistoryDay, historyDates, isDay, monthCells, parseHistoryDay, searchHistory } from './history.js';
import { listFiles } from './objects.js';
import { strings } from './strings.js';
import { planPath, todoPath } from './today-data.js';
import { eveningDate } from './util.js';
import { button, el, link } from './work-dom.js';

const s = strings.work;
const monthFormat = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'long', timeZone: 'UTC' });
const batchSize = 7;

function dayRows(rows) {
  const list = el('ul', undefined, 'work-list calendar-rows');
  for (const item of rows) {
    const row = el('li', item.title ?? item.text ?? item.task);
    for (const value of [item.until && s.until(item.until), item.comment, item.blocker]) {
      if (value) row.append(el('small', value, 'work-muted work-text'));
    }
    list.append(row);
  }
  return list;
}

export function createCalendarView(panel, { fixture, onResponse }) {
  const heading = el('h1', strings.calendar);
  const body = el('div', undefined, 'work-content');
  panel.append(heading, body);
  let view;

  function renderMonth(state, grid) {
    const title = el('h2', monthFormat.format(new Date(state.month + '-01')));
    const previous = button('‹', () => moveMonth(-1));
    const next = button('›', () => moveMonth(1));
    previous.setAttribute('aria-label', s.previousMonth);
    next.setAttribute('aria-label', s.nextMonth);
    const nav = el('div', undefined, 'calendar-navigation');
    nav.append(previous, title, next);
    const weekdays = s.weekdays.map(day => el('span', day, 'work-muted calendar-weekday'));
    const days = monthCells(state.month).map(date => {
      if (!date) return el('span');
      const label = String(Number(date.slice(-2)));
      if (!state.dates.includes(date)) return el('span', label, 'calendar-day');
      const cell = button(label, () => selectDay(date), 'calendar-day has-data');
      cell.setAttribute('aria-label', dayFormat.format(new Date(date)));
      cell.setAttribute('aria-pressed', String(date === state.selected));
      if (date === state.today) cell.setAttribute('aria-current', 'date');
      return cell;
    });
    const cells = el('div', undefined, 'calendar-grid');
    cells.append(...weekdays, ...days);
    grid.replaceChildren(nav, cells, button(s.currentDay, () => selectDay(state.today)));

    function moveMonth(offset) {
      state.month = adjacentMonth(state.month, offset);
      renderMonth(state, grid);
      grid.querySelectorAll('.calendar-navigation button')[offset < 0 ? 0 : 1].focus();
    }
  }

  function renderDetail(state) {
    const detail = state.detail;
    const date = state.selected;
    const heading = el('h2', dayFormat.format(new Date(date)));
    detail.replaceChildren(heading);
    const day = state.loaded.get(date);
    if (!day) {
      detail.append(el('p', state.failed.has(date) ? s.loadError : s.loading, 'work-muted'));
      if (state.failed.has(date)) detail.append(button(s.retry, () => selectDay(date)));
      return;
    }
    const groups = [[s.doneItems, day.done], [s.postponed, day.postponed], [s.doneTodos, day.todos]];
    for (const [label, rows] of groups) {
      if (rows.length) detail.append(el('h3', label), dayRows(rows));
    }
    if (groups.every(([, rows]) => !rows.length)) detail.append(el('p', s.emptyDay, 'work-muted'));
  }

  function renderSearch(state) {
    const results = state.results;
    const query = state.search.value.trim();
    if (!query) {
      results.replaceChildren();
      return;
    }
    const matches = searchHistory(state.loaded.values(), query);
    const count = el('p', s.loaded(state.loaded.size, state.dates.length), 'work-muted');
    count.setAttribute('role', 'status');
    const groups = matches.map(({ date, rows }) => {
      const group = el('section', undefined, 'work-group');
      const day = button(dayFormat.format(new Date(date)), () => {
        selectDay(date);
        state.detail.scrollIntoView({ block: 'start' });
      });
      group.append(day, dayRows(rows));
      return group;
    });
    const more = button(state.batch ? s.loading : state.searchError ? s.retry : s.older, () => loadOlder(state));
    more.disabled = Boolean(state.batch);
    const hints = [];
    if (!groups.length && !state.batch) hints.push(el('p', s.noMatches));
    if (state.searchError) hints.push(el('p', s.loadError));
    results.replaceChildren(count, ...hints, ...groups, ...(state.dates.length > state.loaded.size ? [more] : []));
  }

  async function readDay(state, date) {
    if (state.loaded.has(date)) return;
    if (state.requests.has(date)) return state.requests.get(date);
    state.failed.delete(date);
    const request = state.client.getFile('history/' + date + '.json').then(({ text }) => {
      state.loaded.set(date, parseHistoryDay(text, date));
    }).catch(error => {
      state.failed.add(date);
      throw error;
    }).finally(() => {
      state.requests.delete(date);
      onResponse(state.client);
    });
    state.requests.set(date, request);
    return request;
  }

  async function selectDay(date) {
    const state = view;
    state.selected = date;
    state.month = date.slice(0, 7);
    renderMonth(state, state.grid);
    renderDetail(state);
    await readDay(state, date).catch(() => {});
    if (state !== view) return;
    if (state.selected === date) renderDetail(state);
    renderSearch(state);
  }

  async function loadOlder(state) {
    if (state.batch) return;
    const dates = state.dates.filter(date => !state.loaded.has(date)).slice(0, batchSize);
    state.searchError = false;
    state.batch = true;
    renderSearch(state);
    for (const date of dates) {
      if (view !== state) break;
      try {
        await readDay(state, date);
      } catch {
        state.searchError = true;
      }
      if (view === state && state.selected === date) renderDetail(state);
    }
    state.batch = false;
    if (view === state) renderSearch(state);
  }

  async function load(state) {
    body.replaceChildren(el('p', s.loading, 'work-muted'));
    const { client } = state;
    try {
      const [names, planFile, todoFile] = await Promise.all([
        listFiles(client, 'history', /^\d{4}-\d{2}-\d{2}\.json$/),
        client.getFile(planPath),
        client.getFile(todoPath).catch(error => {
          if (error.status === 404) return { text: '{}' };
          throw error;
        }),
      ]);
      if (state !== view) return;
      const plan = JSON.parse(planFile.text);
      const dates = historyDates(names);
      state.today = fixture && isDay(plan.date) ? plan.date : eveningDate();
      state.month = state.today.slice(0, 7);
      state.selected = state.today;
      state.dates = [...new Set([...dates, state.today, ...(isDay(plan.date) ? [plan.date] : [])])].sort().reverse();
      if (isDay(plan.date) && (!dates.includes(plan.date) || plan.date === state.today)) {
        state.loaded.set(plan.date, currentHistoryDay(plan, JSON.parse(todoFile.text)));
      }
      if (!dates.includes(state.today) && !state.loaded.has(state.today)) {
        state.loaded.set(state.today, { date: state.today, done: [], postponed: [], todos: [] });
      }
      state.grid = el('section', undefined, 'work-card calendar-month');
      state.detail = el('section', undefined, 'work-card calendar-detail');
      const searchPanel = el('section', undefined, 'work-card calendar-search');
      const label = el('label', s.search, 'field');
      state.search = el('input');
      state.search.type = 'search';
      state.results = el('div', undefined, 'work-group');
      state.search.addEventListener('input', () => {
        renderSearch(state);
        if (state.search.value.trim() && !state.searchStarted) {
          state.searchStarted = true;
          loadOlder(state);
        }
      });
      label.append(state.search);
      searchPanel.append(label, state.results);
      body.replaceChildren(state.grid, state.detail, searchPanel);
      selectDay(state.today);
    } catch {
      if (state === view) body.replaceChildren(el('p', s.loadError), button(s.retry, () => load(state)));
    } finally {
      onResponse(client);
    }
  }

  return {
    show(client) {
      if (view?.client === client) return;
      view = { client, loaded: new Map(), requests: new Map(), failed: new Set() };
      if (client) load(view);
      else body.replaceChildren(link(strings.settings, '#settings'));
    },
    hide() { view = undefined; },
  };
}
