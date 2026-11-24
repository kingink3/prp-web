const KEY = 'prp.timers';

export function createTimers({ persistent, onTick }) {
  let timers = {};
  let audio;
  try {
    if (persistent) timers = JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch { /* The current session still works. */ }

  function write(key, value) {
    if (value) timers[key] = value;
    else delete timers[key];
    if (persistent) {
      try { localStorage.setItem(KEY, JSON.stringify(timers)); } catch { /* Keep the session state. */ }
    }
  }

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

  const get = key => timers[key] ?? { minutes: 20 };

  function tick() {
    const now = Date.now();
    const expired = Object.entries(timers).filter(([, timer]) => timer.end <= now && !timer.rang);
    for (const [key, timer] of expired) write(key, { ...timer, rang: true });
    if (expired.length) chime();
    onTick(now);
  }

  setInterval(tick, 500);
  return {
    get, tick,
    configure: (key, minutes) => write(key, { minutes }),
    start(key) {
      enableAudio();
      const { minutes } = get(key);
      write(key, { minutes, end: Date.now() + minutes * 60_000 });
      tick();
    },
    stop(key) { write(key, { minutes: get(key).minutes }); },
    clear: key => write(key, null),
  };
}
