// Render the supplied Console stylesheet against the same fixture content for visual review.
export function consoleMarkup(route, theme) {
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  const page = node('html');
  page.lang = 'ru';
  page.dataset.theme = theme;
  const viewport = node('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  const head = node('head');
  head.append(viewport);
  const body = node('body');
  const header = node('header');
  const brand = node('h1');
  brand.append(node('span', '', 'logo'), document.querySelector('.brand').textContent);
  const tabs = node('nav');
  tabs.id = 'tabs';
  for (const link of document.querySelectorAll('.tabs a')) {
    tabs.append(node('button', link.textContent, link.hasAttribute('aria-current') ? 'on' : ''));
  }
  header.append(brand, tabs);
  const main = node('main');
  const panelName = route === 'directions' ? 'objects' : route;
  const panel = document.getElementById(panelName + '-panel').cloneNode(true);
  panel.querySelectorAll('dialog, [hidden]').forEach(element => element.remove());
  panel.querySelectorAll('button:not(.chk, .tbtn, .calendar-day, .work-tabs button)').forEach(button => button.classList.add('btn'));

  function mark(source, target) {
    panel.querySelectorAll(source).forEach(element => element.classList.add(target));
  }

  for (const [source, target] of [
    ['.today-grid', 'grid2'], ['.today-row-info', 'main'], ['.today-row-title', 'title'],
    ['.is-done', 'done'], ['.today-muted, .work-muted', 'meta'],
    ['.today-row-actions, .today-reminder-actions', 'item-actions'],
    ['.chk[aria-pressed="true"], .work-tabs [aria-current]', 'on'],
    ['.today-time', 'timer-edit'], ['.today-card, .today-summary, .work-object, .work-card', 'card'],
    ['.work-tabs', 'subtabs'], ['.work-column', 'col'], ['.work-object', 'compact'],
    ['.work-card-head', 'ct'], ['.work-card-head strong', 't'],
    ['.calendar-grid', 'cal'], ['.calendar-day', 'cal-d'], ['.calendar-weekday', 'cal-h'],
    ['.calendar-day[aria-current="date"]', 'today'], ['.calendar-day[aria-pressed="true"]', 'sel'],
    ['.calendar-count', 'c'], ['.actions, .today-form', 'inline'],
  ]) mark(source, target);
  if (innerWidth >= 700) mark('.work-grid', 'cards');
  if (route === 'settings') panel.classList.add('mbody');
  panel.querySelectorAll('.work-tabs button').forEach(button => { button.dataset.barea = ''; });
  panel.querySelectorAll('.badge').forEach(badge => {
    const status = badge.dataset.status;
    if (status && /^[a-z]+$/.test(status)) badge.classList.add(status === 'parked' ? 'paused' : status);
  });
  panel.querySelectorAll('.calendar-day').forEach(cell => {
    const number = cell.firstChild;
    if (number?.nodeType === Node.TEXT_NODE) number.replaceWith(node('div', number.textContent, 'n'));
  });
  panel.querySelectorAll('.today-rows').forEach(list => {
    list.replaceWith(...list.childNodes);
  });
  panel.querySelectorAll('progress').forEach(progress => {
    // Native progress retains the fixture value when rendered with the reference tokens.
    const bar = node('div', '', progress.className);
    progress.replaceWith(bar);
    bar.append(progress);
  });
  for (const select of panel.querySelectorAll('select')) {
    const original = select.id && document.getElementById(select.id);
    if (original) for (const option of select.options) option.toggleAttribute('selected', option.value === original.value);
  }
  main.append(panel);
  body.append(header, main);
  page.append(head, body);
  return '<!doctype html>' + page.outerHTML;
}

export function comparisonHtml(images) {
  const headings = { today: 'Сегодня', directions: 'Направления', calendar: 'Календарь', settings: 'Настройки' };
  const themes = { light: 'светлая тема', dark: 'тёмная тема' };
  const sections = images.map(({ route, width, theme, name }) =>
    '<h2>' + headings[route] + ' · ' + width + ' px · ' + themes[theme] + '</h2>' +
    '<table><thead><tr><th scope="col">PRP Web</th><th scope="col">CSS-референс консоли</th></tr></thead>' +
    '<tbody><tr><td valign="top"><a href="' + name + '.png"><img alt="PRP Web" width="' + Math.min(width, 640) +
    '" src="' + name + '.png"></a></td><td valign="top"><a href="' + name + '-reference.png"><img alt="CSS-референс консоли" width="' +
    Math.min(width, 640) + '" src="' + name + '-reference.png"></a></td></tr></tbody></table>');
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><title>PRP Web и консоль</title>' +
    '<h1>PRP Web и консоль</h1>' +
    '<p>Демо-данные. Референс визуализирован из docs/console-reference.css.</p>' +
    sections.join('\n') + '</html>\n';
}
