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

export function routinePayload(input) {
  const text = input.trim();
  if (text === 'extra_lesson') return text;
  const [, command, value] = /^(ideas|critic|кодекс|codex-review|ок):\s*([\s\S]+)$/.exec(text) ?? [];
  if (command === 'ideas' || command === 'кодекс') return text;
  if (command === 'critic' && /^idea-\d{8}-[\p{L}\p{N}_-]+$/u.test(value)) return text;
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
