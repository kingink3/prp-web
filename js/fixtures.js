export const fixtureMode = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
  new URLSearchParams(location.search).get('fixtures') === '1';

export function createFixtureClient() {
  const edits = new Map();
  let requests = 0;
  const fixtureModule = path => import(new URL('../fixtures/lab/' + path + '.js', import.meta.url));
  async function getFile(path) {
    requests++;
    if (edits.has(path)) return { text: edits.get(path) };
    try {
      const { default: text } = await fixtureModule(path);
      if (typeof text !== 'string') throw new Error('Fixture does not exist');
      return { text };
    } catch {
      throw Object.assign(new Error('Fixture unavailable'), { status: 404 });
    }
  }
  return {
    getFile,
    get requests() { return requests; },
    async listDir(path) {
      requests++;
      const { default: names } = await fixtureModule(path + '/.index');
      const all = new Set(names);
      for (const file of edits.keys()) {
        const [directory, name, nested] = file.split('/');
        if (directory === path && name && !nested) all.add(name);
      }
      return [...all].map(name => ({ type: 'file', name }));
    },
    async update(path, mutate, message, { initial } = {}) {
      const current = await getFile(path).catch(error => {
        if (initial === undefined || error.status !== 404) throw error;
        return { text: initial };
      });
      const text = mutate(current.text);
      if (text !== current.text) {
        requests++;
        edits.set(path, text);
      }
      return { text };
    },
  };
}
