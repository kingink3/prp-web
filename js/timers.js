import { chime, enableAudio, notify } from './sound.js';

const KEY = 'prp.timers';

export function createTimerStore(storage) {
  let timers = {};
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) timers = saved;
  } catch { /* The current session still works. */ }

  function write(key, value) {
    timers[key] = value;
    try { storage?.setItem(KEY, JSON.stringify(timers)); } catch { /* Keep the session state. */ }
  }

  return {
    get: key => timers[key] ?? { minutes: 20 },
    entries: () => Object.entries(timers),
    write,
    configure: (key, minutes) => write(key, { minutes }),
  };
}

export function createTimers({ persistent, onTick }) {
  let storage;
  try {
    if (persistent) storage = window.localStorage;
  } catch { /* Storage can be unavailable on this device. */ }
  const { get, entries, write, configure } = createTimerStore(storage);

  function tick() {
    const now = Date.now();
    const expired = entries().filter(([, timer]) => timer.end <= now && !timer.rang);
    for (const [key, timer] of expired) write(key, { ...timer, rang: true });
    if (expired.length) { chime('item'); notify('⏱ Время вышло', ''); }
    onTick(now);
  }

  setInterval(tick, 500);
  return {
    get, tick, configure,
    toggle(key) {
      const { minutes, end, remaining, rang } = get(key);
      if (rang) return;
      const now = Date.now();
      if (end > now) write(key, { minutes, remaining: end - now });
      else if (!end) {
        enableAudio();
        write(key, { minutes, end: now + (remaining ?? minutes * 60_000) });
      }
      tick();
    },
    reset(key) {
      const { minutes, end, remaining } = get(key);
      if (end || remaining !== undefined) configure(key, minutes);
    },
  };
}
