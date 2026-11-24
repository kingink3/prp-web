import { strings } from './strings.js';
import { todoPath } from './today-data.js';
import { button, el, link } from './work-dom.js';

const s = strings.todayView;

function focusLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.flatMap(entry => {
    if (typeof entry?.url !== 'string') return [];
    let url;
    try { url = new URL(entry.url); } catch { return []; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
    const anchor = link(entry.title || url.href, url.href, 'btn');
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return [anchor];
  });
}

export function createFocusView(onAction) {
  const element = el('dialog', undefined, 'focus-view');
  element.setAttribute('aria-labelledby', 'focus-title');
  element.addEventListener('cancel', event => {
    event.preventDefault();
    onAction('close');
  });
  const card = el('section', undefined, 'focus-card');
  const head = el('div', undefined, 'focus-head');
  const kind = el('p', undefined, 'focus-kind');
  const close = button('✕', () => onAction('close'), 'btn small focus-close');
  close.setAttribute('aria-label', s.closeFocus);
  head.append(kind, close);
  const title = el('h1');
  title.id = 'focus-title';
  title.tabIndex = -1;
  title.autofocus = true;
  const contents = el('div');
  const task = el('p', undefined, 'focus-subtitle');
  const links = el('div', undefined, 'actions focus-links');
  const timerArea = el('div', undefined, 'focus-timer');
  const notes = el('div', undefined, 'focus-notes');
  const fields = {};
  const original = {};
  for (const key of ['comment', 'blocker']) {
    const field = el('textarea');
    field.rows = 2;
    const label = el('label', s[key], 'today-field');
    label.append(field);
    notes.append(label);
    fields[key] = field;
  }
  const error = el('p', undefined, 'notice error');
  error.setAttribute('role', 'status');
  error.hidden = true;
  const actions = el('div', undefined, 'focus-actions');
  const done = button(s.focusDone, () => onAction('done'), 'btn primary');
  const tomorrow = button(s.postpone, () => onAction('postpone'), 'btn');
  const skip = button(s.focusSkip, () => onAction('skip'), 'btn');
  actions.append(done, tomorrow, skip);
  contents.append(task, links, timerArea, notes, error, actions);
  card.append(head, title, contents);
  element.append(card);

  return {
    element,
    show(row, timer) {
      const item = row?.item;
      const type = row?.path === todoPath ? 'todo' : item?.kind;
      const kindLabel = Object.hasOwn(s.focusKinds, type) ? s.focusKinds[type] : s.focusKinds.custom;
      kind.textContent = item ? kindLabel : '';
      title.textContent = item ? (item.title ?? item.text) : s.focusEnd;
      contents.hidden = !item;
      error.hidden = true;
      if (item) {
        task.textContent = item.task ?? '';
        task.hidden = !task.textContent || task.textContent === title.textContent;
        links.replaceChildren(...focusLinks(item.links));
        links.hidden = !links.childElementCount;
        timerArea.replaceChildren(timer);
        for (const key of Object.keys(fields)) fields[key].value = original[key] = item[key] ?? '';
        tomorrow.hidden = row.path === todoPath;
      }
      if (!element.open) element.showModal();
      element.scrollTop = 0;
      title.focus({ preventScroll: true });
    },
    readNotes() {
      return Object.fromEntries(Object.entries(fields)
        .filter(([key, field]) => field.value !== original[key])
        .map(([key, field]) => [key, field.value]));
    },
    busy(value) {
      for (const control of [close, done, tomorrow, skip]) control.disabled = value;
      for (const field of Object.values(fields)) field.readOnly = value;
      element.setAttribute('aria-busy', String(value));
    },
    showError(message) {
      error.textContent = message;
      error.hidden = !message;
    },
    close() { element.close(); },
  };
}
