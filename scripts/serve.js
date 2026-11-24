import { readdir, readFile } from 'node:fs/promises';
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
    const fixture = /^fixtures\/lab\/(?:[a-z]+\.json|config\/areas\.yaml|(?:projects|learning|experiments|ideas|journal)\/[\w-]+\.md|history\/[\d-]+\.json)\.js$/.test(path);
    const listing = /^fixtures\/lab\/(?:projects|learning|experiments|ideas|history)\/\.index\.js$/.test(path);
    const asset = /^(?:index\.html|manifest\.webmanifest|(?:css|js|icons)\/[\w.-]+)$/.test(path);
    if (request.method !== 'GET' || (!fixture && !listing && !asset) || !types[extname(path)]) {
      response.writeHead(404).end();
      return;
    }
    try {
      // Same-origin modules are allowed by script-src. The production connect-src stays unchanged.
      let data;
      if (listing) {
        const entries = await readdir(new URL(path.replace(/\.index\.js$/, ''), root), { withFileTypes: true })
          .catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
        data = 'export default ' + JSON.stringify(entries.filter(entry => entry.isFile()).map(entry => entry.name)) + ';\n';
      } else if (fixture) {
        const text = await readFile(new URL(path.slice(0, -3), root), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        data = 'export default ' + JSON.stringify(text) + ';\n';
      } else data = await readFile(new URL(path, root));
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
