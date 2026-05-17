#!/usr/bin/env node
import http from 'http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 3789);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootPath = path.resolve(__dirname, '../..');
const publicDataPath = path.join(projectRootPath, 'public', 'data');
const performersDirectoryPath = path.join(publicDataPath, 'performers');
const performersIndexPath = path.join(publicDataPath, 'performers.index.json');
const braveSearchUrl = 'https://api.search.brave.com/res/v1/web/search';
const localEnv = await readLocalEnv();
const braveSearchApiKey = process.env.BRAVE_SEARCH_API_KEY ?? localEnv.BRAVE_SEARCH_API_KEY;

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }

  return browser;
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method ?? 'GET';
    const urlObj = new URL(req.url ?? '', `http://${req.headers.host}`);

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (urlObj.pathname === '/performers/save' && method === 'POST') {
      const payload = await readJsonBody(req);
      const profile = payload?.profile;

      if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Invalid payload.' }));
        return;
      }

      const summary = await savePerformerProfile(profile);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ summary }));
      return;
    }

    const performerDeleteMatch =
      method === 'DELETE' ? urlObj.pathname.match(/^\/performers\/([^/]+)$/) : null;

    if (performerDeleteMatch) {
      const performerId = decodeURIComponent(performerDeleteMatch[1] ?? '').trim();

      if (!performerId) {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Missing performer id.' }));
        return;
      }

      await deletePerformerProfile(performerId);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (urlObj.pathname === '/brave/model-links' && method === 'GET') {
      if (!braveSearchApiKey) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Missing BRAVE_SEARCH_API_KEY in proxy environment.' }));
        return;
      }

      const name = urlObj.searchParams.get('name')?.trim();

      if (!name) {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Missing name parameter.' }));
        return;
      }

      const links = await fetchModelLinksFromBrave(name);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ links }));
      return;
    }

    if (urlObj.pathname !== '/fetch' || method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const target = urlObj.searchParams.get('url');

    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing url parameter');
      return;
    }

    const b = await getBrowser();
    const context = await b.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'accept-language': 'en-US,en;q=0.9',
      },
    });

    const page = await context.newPage();

    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      // continue and try to get content even if navigation had non-fatal errors
    }

    const content = await page.content();
    await context.close();

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(String(error));
  }
});

process.on('SIGINT', async () => {
  console.log('Shutting down proxy...');
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
});

server.listen(PORT, () => console.log(`Playwright proxy listening on http://localhost:${PORT}`));

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function savePerformerProfile(profile) {
  await mkdir(performersDirectoryPath, { recursive: true });
  const performerPath = path.join(performersDirectoryPath, `${profile.id}.json`);
  await writeFile(performerPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');

  const existingIndex = await readPerformersIndex();
  const nextSummary = {
    id: profile.id,
    name: profile.name,
    searchName: profile.searchName,
    aliases: Array.isArray(profile.aka) ? profile.aka : undefined,
    completed: Boolean(profile.completed),
    type: 'performer',
    profilePath: `data/performers/${profile.id}.json`,
  };
  const withoutCurrent = existingIndex.filter((entry) => entry.id !== profile.id);
  const updated = [...withoutCurrent, nextSummary].sort((first, second) =>
    String(first.name ?? '').localeCompare(String(second.name ?? '')),
  );
  await writeFile(performersIndexPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

  return nextSummary;
}

async function readPerformersIndex() {
  try {
    const content = await readFile(performersIndexPath, 'utf8');
    const parsed = JSON.parse(content);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchModelLinksFromBrave(name) {
  const url = new URL(braveSearchUrl);
  url.search = new URLSearchParams({
    q: `${name} porn`,
    count: '10',
    country: 'us',
    search_lang: 'en',
  });

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': braveSearchApiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave search failed with status ${response.status}.`);
  }

  const result = await response.json();
  const webResults = Array.isArray(result.web?.results) ? result.web.results : [];
  const links = webResults
    .filter((item) => typeof item?.url === 'string' && isModelProfileUrl(item.url))
    .map((item) => searchResultToDataLink(item))
    .filter(
      (link, index, candidates) =>
        Boolean(link.url) &&
        candidates.findIndex((candidate) => candidate.url === link.url) === index,
    );

  return links;
}

async function deletePerformerProfile(performerId) {
  const performerPath = path.join(performersDirectoryPath, `${performerId}.json`);

  try {
    await unlink(performerPath);
  } catch {}

  const existingIndex = await readPerformersIndex();
  const updated = existingIndex.filter((entry) => entry?.id !== performerId);
  await writeFile(performersIndexPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

function searchResultToDataLink(result) {
  return removeEmptyValues({
    label: cleanValue(result.title) ?? getHostname(result.url),
    source: inferDataSource(result.url),
    url: result.url,
  });
}

function isModelProfileUrl(value) {
  try {
    const { pathname } = new URL(value);
    return /(^|\/)(models?|pornstars?)(\/|$)/i.test(pathname);
  } catch {
    return false;
  }
}

function inferDataSource(url) {
  const hostname = getHostname(url);

  if (hostname.includes('iafd.com')) {
    return 'iafd';
  }

  if (hostname.includes('xvideos.com')) {
    return 'xv';
  }

  if (hostname.includes('pornhub.com')) {
    return 'ph';
  }

  return 'web';
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url);
  }
}

function cleanValue(value) {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function removeEmptyValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return entryValue.length > 0;
      }

      return entryValue !== undefined && entryValue !== '';
    }),
  );
}

async function readLocalEnv() {
  try {
    const envPath = path.join(projectRootPath, '.env');
    const content = await readFile(envPath, 'utf8');
    const entries = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      });

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}
