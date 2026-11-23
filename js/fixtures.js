export const fixtureMode = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
  new URLSearchParams(location.search).get('fixtures') === '1';

export function createFixtureClient() {
  const edits = new Map();
  async function getFile(path) {
    if (edits.has(path)) return { text: edits.get(path) };
    try {
      const { default: text } = await import(new URL('../fixtures/lab/' + path + '.js', import.meta.url));
      return { text };
    } catch {
      throw Object.assign(new Error('Fixture unavailable'), { status: 404 });
    }
  }
  return {
    getFile,
    async update(path, mutate, message, { initial } = {}) {
      const current = await getFile(path).catch(error => {
        if (initial === undefined || error.status !== 404) throw error;
        return { text: initial };
      });
      const text = mutate(current.text);
      edits.set(path, text);
      return { text };
    },
  };
}
