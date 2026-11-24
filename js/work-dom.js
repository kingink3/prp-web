export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(text, action, className) {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function link(text, href, className) {
  const node = el('a', text, className);
  node.href = href;
  return node;
}

export function showNotice(element, message, kind = '') {
  element.textContent = message;
  element.className = kind ? 'notice ' + kind : 'notice';
  element.hidden = !message;
}

export function appendLinkedText(parent, text) {
  const pattern = /\[([^\]\r\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|https?:\/\/[^\s<>"'`]+/gi;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const [token, label, destination] = match;
    parent.append(text.slice(start, match.index));
    let url = destination ?? token.replace(/[.,!?;:\]}>]+$/, '');
    if (!destination) {
      while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1);
    }
    let parsed;
    if (/^https?:\/\//i.test(url)) {
      try { parsed = new URL(url); } catch { /* Keep invalid URLs as text. */ }
    }
    if (parsed && ['http:', 'https:'].includes(parsed.protocol)) {
      const anchor = link(label ?? url, parsed.href);
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      parent.append(anchor, destination ? '' : token.slice(url.length));
    } else parent.append(token);
    start = match.index + token.length;
  }
  parent.append(text.slice(start));
}
