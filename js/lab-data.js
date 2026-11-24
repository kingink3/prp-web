import { indexEntryFromMarkdown, loadLegacyObjectEntries, parseObjectIndex } from './objects.js';

export const indexPath = 'objects.json';
export const areasPath = 'config/areas.yaml';
const CACHE_PREFIX = 'prp.lab.';
const PATCH_WINDOW = 120_000;

function cacheStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function createLabData(client, { namespace, storage = cacheStorage(), now = Date.now } = {}) {
  const key = namespace && CACHE_PREFIX + namespace;
  let saved;
  try { if (key) saved = JSON.parse(storage?.getItem(key)); } catch { /* Start with an empty cache. */ }
  const files = new Map(Object.entries(saved?.files ?? {}));
  const patches = new Map(Object.entries(saved?.patches ?? {}));
  const requests = new Map();
  let legacy = saved?.legacy;
  let historyDates = saved?.historyDates;
  let objectRequest;
  let cleared = false;

  function persist() {
    if (!key || cleared) return;
    try {
      storage?.setItem(key, JSON.stringify({
        files: Object.fromEntries(files), patches: Object.fromEntries(patches), legacy, historyDates,
      }));
    } catch { /* Keep the current session usable when storage is full or unavailable. */ }
  }

  const peek = path => files.get(path);
  const peekHistoryDates = () => historyDates;

  function rememberHistoryDates(dates) {
    historyDates = dates;
    persist();
  }

  function remember(path, file) {
    files.set(path, file);
    persist();
    return file;
  }

  function refresh(path, initial) {
    if (requests.has(path)) return requests.get(path);
    const cached = peek(path);
    const request = client.getFile(path, { cached, withEtag: true }).catch(error => {
      if (error.status === 404 && initial !== undefined) return { text: initial };
      throw error;
    }).then(file => {
      // A completed write takes precedence over a read already in flight.
      if (peek(path) !== cached) return peek(path);
      if (path === indexPath) parseObjectIndex(file.text);
      else if (path.endsWith('.json')) JSON.parse(file.text);
      return remember(path, file);
    }).finally(() => requests.delete(path));
    requests.set(path, request);
    return request;
  }

  function applyPatches(entries) {
    const byPath = new Map(entries.map(entry => [entry.path, entry]));
    for (const [path, { entry, expires }] of patches) {
      const indexed = byPath.get(path);
      const matches = indexed && Object.entries(entry).every(([key, value]) => indexed[key] === value);
      if (matches || expires <= now()) patches.delete(path);
      else byPath.set(path, entry);
    }
    return [...byPath.values()];
  }

  function peekObjects() {
    const index = peek(indexPath);
    if (index) return applyPatches(parseObjectIndex(index.text));
    if (legacy) return applyPatches(legacy);
    if (patches.size) return applyPatches([]);
  }

  function refreshObjects() {
    if (objectRequest) return objectRequest;
    objectRequest = refresh(indexPath).then(() => { legacy = undefined; }).catch(async error => {
      if (error.status !== 404) throw error;
      // Older Lab repositories may not generate an index yet.
      legacy = await loadLegacyObjectEntries(client);
      files.delete(indexPath);
    }).then(() => {
      const entries = peekObjects();
      persist();
      return entries;
    }).finally(() => { objectRequest = undefined; });
    return objectRequest;
  }

  function patchObject(path, text) {
    const entry = indexEntryFromMarkdown(path, text);
    if (!entry) return;
    patches.set(path, { entry, expires: now() + PATCH_WINDOW });
    persist();
  }

  function clear() {
    cleared = true;
    files.clear();
    patches.clear();
    legacy = undefined;
    historyDates = undefined;
    if (!key) return;
    try { storage?.removeItem(key); } catch { /* Storage can be unavailable. */ }
  }

  return { peek, refresh, remember, peekObjects, refreshObjects, patchObject, peekHistoryDates, rememberHistoryDates, clear };
}
