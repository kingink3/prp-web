// Quick timers: a short label + minutes («чай», 5), independent of plan items. Kept on this device only.
const KEY = 'prp.quickTimers';

export function createQuickTimerList(saved = []) {
  return Array.isArray(saved) ? saved.filter(t => t && typeof t.id === 'string') : [];
}

export function addQuickTimer(list, label, minutes, now) {
  const mins = Math.min(600, Math.max(1, Math.round(Number(minutes) || 10)));
  const text = String(label ?? '').trim().slice(0, 60);
  return [...list, { id: 'qt-' + now + '-' + list.length, label: text, minutes: mins, end: now + mins * 60_000 }];
}

export function toggleQuickTimer(list, id, now) {
  return list.map(t => {
    if (t.id !== id || t.rang) return t;
    if (t.end) return { ...t, end: null, remaining: Math.max(0, t.end - now) };
    return { ...t, end: now + (t.remaining ?? t.minutes * 60_000), remaining: undefined };
  });
}

export const removeQuickTimer = (list, id) => list.filter(t => t.id !== id);

// Timers that ended since the last check (each rings once).
export function expireQuickTimers(list, now) {
  const rang = [];
  const next = list.map(t => {
    if (t.end && t.end <= now && !t.rang) { rang.push(t); return { ...t, rang: true }; }
    return t;
  });
  return { list: next, rang };
}

export function leftMs(t, now) {
  if (t.rang) return 0;
  return t.end ? Math.max(0, t.end - now) : (t.remaining ?? t.minutes * 60_000);
}

export function loadQuickTimers(storage) {
  try { return createQuickTimerList(JSON.parse(storage?.getItem(KEY) ?? '[]')); } catch { return []; }
}

export function saveQuickTimers(storage, list) {
  try { storage?.setItem(KEY, JSON.stringify(list)); } catch { /* Keep the session state. */ }
}

// Reminders that became due and have not rung on this device yet.
export function dueReminders(reminders, rangKeys, now, localNow) {
  return (reminders ?? []).filter(r => !r.done && r.at && r.at <= localNow && !rangKeys.has(r.id + '@' + r.at) &&
    now - Date.parse(r.at) < 12 * 3600_000);
}
