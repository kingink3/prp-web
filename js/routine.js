import { isRepository } from './github.js';

const ROUTINE_ORIGIN = 'https://api.anthropic.com';
const FIRE_URL_PREFIX = /^https:\/\/api\.anthropic\.com\//;

export function isRoutineUrl(value) {
  if (!FIRE_URL_PREFIX.test(value) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === ROUTINE_ORIGIN && !url.hash;
  } catch {
    return false;
  }
}

export function isPullNumber(value) {
  return (typeof value === 'number' || typeof value === 'string') &&
    /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

// What people type → the exact form the routine accepts («идеи - тема» → «ideas: тема», «урок» → extra_lesson).
export function normalizeRequest(input) {
  const t = String(input ?? '').trim();  // keep line breaks inside a task description
  if (/^((ещё|еще)\s+)?урок$|^extra_lesson$|^lesson$/i.test(t)) return 'extra_lesson';
  const forms = [['(?:идеи|идея|ideas?)', 'ideas: '], ['(?:критик|critic)', 'critic: '], ['(?:тест|test)', 'test: '],
    ['(?:codex-review|ревью)', 'codex-review: '], ['(?:кодекс|codex)(?!-)', 'кодекс: '], ['(?:ок|ok)', 'ок: ']];
  for (const [word, form] of forms) {
    const m = new RegExp('^' + word + '\\s*(?:[:\\-–—]\\s*|\\s+)(.+)$', 'isu').exec(t);
    if (m) return form + m[1].trim();
  }
  return t;
}

export function routinePayload(input) {
  const text = normalizeRequest(input);
  if (text === 'extra_lesson') return text;
  const [, command, value] = /^(ideas|critic|test|кодекс|codex-review|ок):\s*([\s\S]+)$/.exec(text) ?? [];
  if (command === 'ideas' || command === 'кодекс') return text;
  if ((command === 'critic' || command === 'test') && /^idea-\d{8}-[\p{L}\p{N}_-]+$/u.test(value)) return text;
  if (command === 'codex-review' || command === 'ок') {
    const [repo, pr, extra] = value.split('#');
    if (extra === undefined && (pr === undefined ? isPullNumber(repo) : isRepository(repo) && isPullNumber(pr))) {
      return text;
    }
  }
  return null;
}

export async function fireRoutine({ url, token }, input, fetchImpl = globalThis.fetch) {
  const text = routinePayload(input);
  if (!text || !isRoutineUrl(url) || !token) throw new TypeError('Invalid routine request');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  return response.ok ? null : response.status;
}
