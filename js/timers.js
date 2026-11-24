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
  let audio;
  try {
    if (persistent) storage = window.localStorage;
  } catch { /* Storage can be unavailable on this device. */ }
  const { get, entries, write, configure } = createTimerStore(storage);

  function enableAudio() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    try {
      audio ??= new Audio();
      audio.resume().catch(() => {});
    } catch { /* Audio can be unavailable on this device. */ }
  }

  function chime() {
    if (audio?.state !== 'running') return;
    const start = audio.currentTime;
    const volume = audio.createGain();
    volume.connect(audio.destination);
    volume.gain.value = 0.12;
    volume.gain.exponentialRampToValueAtTime(0.001, start + 0.38);
    const tone = audio.createOscillator();
    tone.frequency.setValueAtTime(660, start);
    tone.frequency.setValueAtTime(880, start + 0.15);
    tone.connect(volume);
    tone.start(start);
    tone.stop(start + 0.4);
    tone.onended = () => { tone.disconnect(); volume.disconnect(); };
  }

  function tick() {
    const now = Date.now();
    const expired = entries().filter(([, timer]) => timer.end <= now && !timer.rang);
    for (const [key, timer] of expired) write(key, { ...timer, rang: true });
    if (expired.length) chime();
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
