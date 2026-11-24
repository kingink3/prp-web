const API_ORIGIN = 'https://api.github.com';
const MAX_ATTEMPTS = 3;
const REPOSITORY_PATTERN = /^[a-z0-9-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/i;

export function isRepository(value) {
  return REPOSITORY_PATTERN.test(value);
}

export class GitHubError extends Error {
  constructor(status, rateLimited = false) {
    super(`GitHub request failed (${status})`);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(content) {
  const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function createGitHubClient({ repository, token, branch = 'main', fetchImpl = globalThis.fetch }) {
  if (!isRepository(repository) || !token || !branch) throw new TypeError('Invalid GitHub settings');
  const endpoint = `${API_ORIGIN}/repos/${repository}/contents`;
  const cache = new Map();
  let tokenExpiration = null;

  function contentsUrl(path, method) {
    const segments = path === '' && method === 'GET' ? [] : path.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw new TypeError('Expected a relative repository path');
    }
    const suffix = segments.map(encodeURIComponent).join('/');
    const url = new URL(suffix ? `${endpoint}/${suffix}` : endpoint);
    if (method === 'GET') url.searchParams.set('ref', branch);
    return url.href;
  }

  async function request(path, { method = 'GET', body, signal, cachedFile, withEtag } = {}) {
    const url = contentsUrl(path, method);
    const cached = method === 'GET' && cache.get(path);
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const etagSent = cachedFile?.etag ?? cached?.etag;
    if (etagSent) headers['If-None-Match'] = etagSent;
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetchImpl(url, {
      method, headers, body, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
    const expiration = response.headers.get('github-authentication-token-expiration');
    if (expiration !== null) tokenExpiration = expiration;
    if (response.status === 304 && etagSent) {
      if (cachedFile?.etag === etagSent) return null; // Reuse the persisted decoded file.
      return withEtag ? { data: cached.data, etag: cached.etag } : cached.data;
    }
    if (!response.ok) {
      if (method === 'GET' && response.status === 404) cache.delete(path);
      throw new GitHubError(response.status, response.status === 429 || (
        response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after'))
      ));
    }
    const data = await response.json();
    const etag = response.headers.get('etag');
    if (method === 'GET') {
      if (etag) cache.set(path, { etag, data });
      else cache.delete(path);
    }
    return withEtag ? { data, etag } : data;
  }

  async function getFile(path, { signal, cached, withEtag = false } = {}) {
    const result = await request(path, { signal, cachedFile: withEtag ? cached : undefined, withEtag });
    if (withEtag && result === null) return cached;
    const file = withEtag ? result.data : result;
    if (file?.type !== 'file' || file.encoding !== 'base64' ||
        typeof file.content !== 'string' || typeof file.sha !== 'string') {
      throw new Error('Expected a base64-encoded GitHub file');
    }
    const decoded = { text: decodeBase64(file.content), sha: file.sha };
    if (withEtag && result.etag) decoded.etag = result.etag;
    return decoded;
  }

  async function listDir(path = '') {
    const entries = await request(path);
    if (!Array.isArray(entries)) throw new TypeError('Expected a GitHub directory');
    return structuredClone(entries);
  }

  async function putFile(path, text, sha, message) {
    const body = { message, content: encodeBase64(text), branch };
    if (sha != null) body.sha = sha;
    const result = await request(path, { method: 'PUT', body: JSON.stringify(body) });
    // A write changes the file and the directory entries for all its ancestors.
    const segments = path.split('/');
    while (segments.length) {
      cache.delete(segments.join('/'));
      segments.pop();
    }
    cache.delete('');
    return result;
  }

  // A mutator may run again after a conflicting write. It should only transform the supplied text.
  async function update(path, mutateFn, message, { initial } = {}) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const current = await getFile(path).catch(error => {
        if (!(error instanceof GitHubError) || error.status !== 404 || initial === undefined) throw error;
        return { text: initial, sha: null };
      });
      const text = await mutateFn(current.text);
      if (typeof text !== 'string') throw new TypeError('Expected updated file text');
      if (text === current.text) return current;
      try {
        const result = await putFile(path, text, current.sha, message);
        return { text, sha: result.content.sha };
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === MAX_ATTEMPTS) throw error;
        cache.delete(path);
      }
    }
  }

  return { getFile, listDir, putFile, update, get tokenExpiration() { return tokenExpiration; } };
}
