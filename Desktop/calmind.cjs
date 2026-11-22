'use strict';

const { readFile } = require('node:fs/promises');
const { extname, join } = require('node:path');

const origin = 'https://seancheren.com';
const prefix = '/calmind/';
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function assetPath(url) {
  if (url.origin !== origin || !url.pathname.startsWith(prefix)) return null;
  if (url.pathname.startsWith(prefix + 'api/')) return null;
  if (url.pathname === prefix) return 'index.html';
  const name = decodeURIComponent(url.pathname.slice(prefix.length));
  if (name.split('/').some(part => !part || part.startsWith('.') || part.includes('\\'))) return '';
  return name;
}

function installCalMindProtocol(session, directory, { offline = false } = {}) {
  session.protocol.handle('https', async request => {
    if (request.method === 'GET') {
      let file;
      try { file = assetPath(new URL(request.url)); } catch { return new Response(null, { status: 400 }); }
      if (file !== null) {
        if (!file) return new Response(null, { status: 404 });
        try {
          const body = await readFile(join(directory, file));
          return new Response(body, {
            headers: { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' },
          });
        } catch { return new Response(null, { status: 404 }); }
      }
    }
    // The existing web export uses its own same-origin API and cookie sign-in.
    if (offline) return new Response(null, { status: 503 });
    return session.fetch(request, { bypassCustomProtocolHandlers: true });
  });
}

module.exports = { origin, assetPath, installCalMindProtocol };
