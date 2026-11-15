import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A guest page is the legacy gate, the shell, or this instance's exact shared-account redirect. */
export function validatePageResponse(pageUrl, reportedStatus, rawHeaders) {
  const page = new URL(pageUrl);
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password || page.search || page.hash ||
      !['/AcctMind/', '/test/AcctMind/'].includes(page.pathname)) throw new Error('invalid AcctMind page URL');
  const blocks = rawHeaders.trimEnd().split(/\r?\n\r?\n/).filter(Boolean);
  const lines = (blocks.at(-1) ?? '').split(/\r?\n/);
  const status = /^HTTP\/\S+ ([0-9]{3})(?:\s.*)?$/.exec(lines.shift() ?? '')?.[1];
  if (!status || status !== String(reportedStatus)) throw new Error('inconsistent HTTP status');
  const locations = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (/^[ \t]/.test(line) || colon <= 0 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(line.slice(0, colon))) throw new Error('malformed response headers');
    if (line.slice(0, colon).toLowerCase() === 'location') locations.push(line.slice(colon + 1).trim());
  }
  if (status === '200' || status === '401') return status;
  if (status !== '303') throw new Error(`unexpected HTTP ${status}`);
  if (locations.length !== 1 || !locations[0]) throw new Error('shared sign-in requires one Location header');
  const location = locations[0];
  if (/[\x00-\x20\x7f\\]/.test(location) || !(/^(?:https?:\/\/|\/(?!\/))/.test(location))) throw new Error('invalid account redirect URL');
  const target = new URL(location, page);
  const accountPath = page.pathname === '/test/AcctMind/' ? '/test/account/' : '/account/';
  const rawPath = location.startsWith('/') ? location.split(/[?#]/)[0] : /^https?:\/\/[^/?#]+([^?#]*)/.exec(location)?.[1];
  if (rawPath !== accountPath) throw new Error('redirect must use the exact account path');
  if (target.origin !== page.origin || target.username || target.password || target.pathname !== accountPath || target.hash) throw new Error('redirect must stay on this instance account page');
  const entries = [...target.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'next' || entries[0][1] !== page.pathname) throw new Error('redirect must return only to this AcctMind page');
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [, , pageUrl, status, headersFile] = process.argv;
    process.stdout.write(validatePageResponse(pageUrl, status, readFileSync(headersFile, 'utf8')));
  } catch (error) {
    console.error(`guard: page verification refused: ${error.message}`);
    process.exitCode = 1;
  }
}
