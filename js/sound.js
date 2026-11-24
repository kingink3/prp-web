// Short WebAudio signals (no files). Browsers allow sound only after a user gesture,
// so audio is unlocked on the first tap/click anywhere on the page.
let audio;

export function enableAudio() {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Audio) return;
  try {
    audio ??= new Audio();
    audio.resume().catch(() => {});
  } catch { /* Audio can be unavailable on this device. */ }
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', enableAudio, { once: true, capture: true });
  document.addEventListener('keydown', enableAudio, { once: true, capture: true });
}

const PATTERNS = {
  item: [[660, 0], [880, 0.15]],                 // a plan item's timer
  timer: [[660, 0], [880, 0.25], [1046, 0.5]],   // a quick timer ended
  reminder: [[880, 0], [880, 0.3]],              // a reminder is due
};

export function chime(kind = 'item') {
  if (audio?.state !== 'running') return false;
  const start = audio.currentTime;
  for (const [frequency, at] of PATTERNS[kind] ?? PATTERNS.item) {
    const volume = audio.createGain();
    volume.connect(audio.destination);
    volume.gain.setValueAtTime(0.0001, start + at);
    volume.gain.exponentialRampToValueAtTime(0.14, start + at + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.35);
    const tone = audio.createOscillator();
    tone.frequency.value = frequency;
    tone.connect(volume);
    tone.start(start + at);
    tone.stop(start + at + 0.4);
    tone.onended = () => { tone.disconnect(); volume.disconnect(); };
  }
  return true;
}

// A system notification when the page is in the background (permission asked on the first quick timer).
export function notify(title, body) {
  try {
    if (globalThis.Notification?.permission === 'granted' && document.hidden) new Notification(title, { body });
  } catch { /* Not available (e.g. iOS without home-screen install). */ }
}

export function askNotifications() {
  try {
    if (globalThis.Notification?.permission === 'default') Notification.requestPermission().catch(() => {});
  } catch { /* Not available. */ }
}
