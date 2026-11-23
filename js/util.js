const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value).replace(/[&<>"']/g, char => HTML_ENTITIES[char]);
}

const pad = number => String(number).padStart(2, '0');

export function today(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localIsoMinutes(date = new Date()) {
  return `${today(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shiftDay(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return today(result);
}

export function tomorrow(date = new Date()) {
  return shiftDay(date, 1);
}

export function eveningDate(date = new Date()) {
  return date.getHours() < 4 ? shiftDay(date, -1) : today(date);
}

function unixId(prefix, date) {
  return `${prefix}-${Math.floor(date.getTime() / 1000)}`;
}

export const todoId = (date = new Date()) => unixId('td', date);
export const postponedId = (date = new Date()) => unixId('pp', date);
export const reminderId = (date = new Date()) => unixId('r', date);
