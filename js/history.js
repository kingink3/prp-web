import { eveningDate } from './util.js';

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(date) {
  return dayPattern.test(date) && Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date;
}

export function historyDates(names) {
  return [...new Set(names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(isDay))]
    .sort().reverse();
}

export function parseHistoryDay(text, date) {
  const plan = JSON.parse(text);
  const postponed = (plan.postponed ?? []).filter(item => !item.postponed_on || item.postponed_on === date);
  return { date, done: (plan.items ?? []).filter(item => item.done), postponed,
    todos: (plan.todos ?? []).filter(item => item.done !== false) };
}

export function currentHistoryDay(plan, todoList) {
  const todos = (todoList.todos ?? []).filter(item => {
    if (!item.done || !item.done_at) return false;
    const at = new Date(item.done_at);
    return Number.isFinite(at.getTime()) && eveningDate(at) === plan.date;
  });
  return parseHistoryDay(JSON.stringify({ ...plan, todos }), plan.date);
}

export function searchHistory(days, query) {
  const terms = query.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return [...days].sort((a, b) => b.date.localeCompare(a.date)).flatMap(day => {
    const rows = [...day.done, ...day.postponed, ...day.todos].filter(item => {
      const text = [day.date, item.title, item.task, item.text, item.comment, item.blocker]
        .filter(Boolean).join(' ').toLocaleLowerCase('ru');
      return terms.every(term => text.includes(term));
    });
    return rows.length ? [{ date: day.date, rows }] : [];
  });
}

export function monthCells(month) {
  const start = new Date(month + '-01T00:00:00Z');
  const offset = (start.getUTCDay() + 6) % 7;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const count = end.getUTCDate();
  return Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, index) => {
    const day = index - offset + 1;
    return day > 0 && day <= count ? month + '-' + String(day).padStart(2, '0') : null;
  });
}

export function adjacentMonth(month, offset) {
  const start = new Date(month + '-01T00:00:00Z');
  start.setUTCMonth(start.getUTCMonth() + offset);
  return start.toISOString().slice(0, 7);
}
