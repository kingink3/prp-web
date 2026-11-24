import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

export function createFixtureServer(prefix = '/') {
  return createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || 'index.html' : '';
    const fixture = /^fixtures\/lab\/(?:[a-z]+\.json|(?:projects|learning|experiments|ideas)\/[\w-]+\.md)\.js$/.test(path);
    const asset = /^(?:index\.html|manifest\.webmanifest|(?:css|js|icons)\/[\w.-]+)$/.test(path);
    if (request.method !== 'GET' || (!fixture && !asset) || !types[extname(path)]) {
      response.writeHead(404).end();
      return;
    }
    try {
      // Same-origin modules are allowed by script-src. The production connect-src stays unchanged.
      const data = fixture
        ? 'export default ' + JSON.stringify(await readFile(new URL(path.slice(0, -3), root), 'utf8')) + ';\n'
        : await readFile(new URL(path, root));
      response.writeHead(200, { 'Content-Type': types[extname(path)], 'Cache-Control': 'no-store' }).end(data);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8000);
  createFixtureServer().listen(port, '127.0.0.1', () => {
    console.log('http://127.0.0.1:' + port + '/?fixtures=1#today');
  });
}
