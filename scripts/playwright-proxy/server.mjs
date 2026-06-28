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
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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

    if (urlObj.pathname === '/performers/lookup-missing' && method === 'POST') {
      if (!braveSearchApiKey) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Missing BRAVE_SEARCH_API_KEY in proxy environment.' }));
        return;
      }

      const payload = await readJsonBody(req);
      const performers = Array.isArray(payload?.performers) ? payload.performers : [];
      const forceLookup = Boolean(payload?.force);
      const summaries = [];
      const debugLogs = [];

      for (const performer of performers) {
        const trace = [];
        const summary = await lookupMissingPerformerInfo(performer, {
          forceLookup,
          log: (message) => trace.push(message),
        });

        if (trace.length > 0) {
          debugLogs.push(...trace);
        }

        if (summary) {
          summaries.push(summary);
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ summaries, debugLogs }));
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

    const content = await fetchHtmlThroughPlaywright(target);

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
    noInfoFound: Boolean(profile.noInfoFound),
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

async function lookupMissingPerformerInfo(rawPerformer, options = {}) {
  const performer = normalizeLookupPerformer(rawPerformer);
  const forceLookup = Boolean(options.forceLookup);
  const log = typeof options.log === 'function' ? options.log : () => {};

  if (!performer) {
    log('Skipped invalid performer payload.');
    return undefined;
  }
  log(`[${performer.id}] Starting lookup for "${performer.name}".`);

  if (!forceLookup && (performer.completed || performer.noInfoFound)) {
    log(`[${performer.id}] Skipped: already completed or no-info-found.`);
    return undefined;
  }

  const existingProfile = await readPerformerProfile(performer.id);
  const currentProfile = buildWorkingProfile(performer, existingProfile);
  log(
    `[${performer.id}] Existing profile loaded: ${
      existingProfile ? 'yes' : 'no'
    }, dataLinks: ${currentProfile.dataLinks?.length ?? 0}.`,
  );

  // Source 1: Brave "<performer> babepedia" -> Babepedia Playwright parse.
  const babepediaUrl = await findBabepediaUrlFromBrave(currentProfile.name);
  log(
    `[${performer.id}] Source 1 Brave(Babepedia): ${
      babepediaUrl ? `found ${babepediaUrl}` : 'no valid Babepedia URL found'
    }.`,
  );
  const babepediaProfile = babepediaUrl
    ? await tryLoadBabepediaProfile(currentProfile, babepediaUrl)
    : undefined;

  if (babepediaProfile) {
    log(`[${performer.id}] Source 1 Babepedia parse succeeded. Saving profile.`);
    return savePerformerProfile(babepediaProfile);
  }
  log(`[${performer.id}] Source 1 Babepedia parse returned no usable data.`);

  // Source 2: Pornhub data-link fallback.
  const pornhubLink = findPornhubProfileLink(currentProfile.dataLinks);
  log(
    `[${performer.id}] Source 2 Pornhub data-link: ${
      pornhubLink ? `using ${pornhubLink}` : 'no Pornhub profile data-link present'
    }.`,
  );
  const pornhubProfile = pornhubLink
    ? await tryLoadPornhubProfile(currentProfile, pornhubLink)
    : undefined;

  if (pornhubProfile) {
    log(`[${performer.id}] Source 2 Pornhub parse succeeded. Saving profile.`);
    return savePerformerProfile(pornhubProfile);
  }
  log(`[${performer.id}] Source 2 Pornhub parse returned no usable data.`);

  // Neither source returned usable data.
  const noInfoProfile = removeEmptyValues({
    ...currentProfile,
    completed: false,
    noInfoFound: true,
  });
  log(`[${performer.id}] No usable data from either source. Marking noInfoFound.`);

  return savePerformerProfile(noInfoProfile);
}

async function tryLoadPornhubProfile(profile, url) {
  if (!isPornhubProfileUrl(url)) {
    return undefined;
  }

  const html = await fetchHtmlThroughPlaywright(url);

  if (!html || isPornhubAgeVerificationPage(html)) {
    return undefined;
  }

  const scanned = scanPornhubProfileHtml(html);

  if (!isUsableScanResult(scanned)) {
    return undefined;
  }

  return mergeScannedData(profile, {
    ...scanned,
    dataLinks: mergeDataLinks(profile.dataLinks, [{ label: 'Pornhub', source: 'ph', url }]),
    noInfoFound: false,
  });
}

async function tryLoadBabepediaProfile(profile, url) {
  if (!isValidBabepediaPerformerUrl(url)) {
    return undefined;
  }

  const html = await fetchHtmlThroughPlaywright(url);

  if (!html) {
    return undefined;
  }

  const scanned = scanBabepediaProfileHtml(html);

  if (!isUsableScanResult(scanned)) {
    return undefined;
  }

  return mergeScannedData(profile, {
    ...scanned,
    dataLinks: mergeDataLinks(profile.dataLinks, [{ label: 'Babepedia', source: 'web', url }]),
    noInfoFound: false,
  });
}

async function findBabepediaUrlFromBrave(name) {
  const trimmedName = String(name ?? '').trim();

  if (!trimmedName) {
    return undefined;
  }

  const url = new URL(braveSearchUrl);
  url.search = new URLSearchParams({
    q: `${trimmedName} babepedia`,
    count: '10',
    country: 'us',
    search_lang: 'en',
  });

  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': braveSearchApiKey,
      },
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const result = await response.json();
  const webResults = Array.isArray(result.web?.results) ? result.web.results : [];
  const candidate = webResults.find((item) => isValidBabepediaPerformerUrl(item?.url));

  return typeof candidate?.url === 'string' ? candidate.url : undefined;
}

async function fetchHtmlThroughPlaywright(target) {
  try {
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
    } catch {
      // Keep going and attempt to read HTML from partially loaded pages.
    }

    const content = await page.content();
    await context.close();
    return content;
  } catch {
    return undefined;
  }
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

function findPornhubProfileLink(dataLinks) {
  if (!Array.isArray(dataLinks)) {
    return undefined;
  }

  const link = dataLinks.find((entry) => isPornhubProfileUrl(entry?.url));
  return typeof link?.url === 'string' ? link.url : undefined;
}

function isPornhubProfileUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (!host.includes('pornhub.com')) {
      return false;
    }

    return /^\/(pornstars?|models?)\/[^/]+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isValidBabepediaPerformerUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    if (host !== 'babepedia.com') {
      return false;
    }

    return /^\/babe\/[^/]+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isPornhubAgeVerificationPage(html) {
  const title = extractTitle(html);
  const normalizedTitle = normalizeText(title);

  if (normalizedTitle.includes('age verification')) {
    return true;
  }

  return (
    normalizedTitle.includes('dear user') &&
    normalizeText(html).includes('this website is only intended for users over the age of 18')
  );
}

function scanPornhubProfileHtml(html) {
  const title = extractTitle(html);
  const normalizedTitle = normalizeText(title);
  const isPornhubProfilePage =
    normalizedTitle.includes('verified pornstar profile') ||
    normalizedTitle.includes('verified model profile') ||
    /\/(pornstars?|models?)\/[^/]+/i.test(extractMetaContent(html, 'og:url') ?? '');

  if (!isPornhubProfilePage) {
    return {};
  }

  const info = extractPornhubInfoMap(html);
  const description = extractPornhubDescription(html);
  const descriptionData = extractPornhubDescriptionData(description);

  const profile = removeEmptyValues({
    completed: true,
    birthday: descriptionData.birthday,
    ageStarted: descriptionData.ageStarted,
    ethnicity: cleanPornhubField(info.get('ethnicity') ?? descriptionData.ethnicity),
    nationality: cleanPornhubField(info.get('nationality') ?? descriptionData.nationality),
    height: cleanPornhubField(info.get('height') ?? descriptionData.height),
    measurements: cleanPornhubField(
      info.get('measurements') ?? info.get('body measurements') ?? descriptionData.measurements,
    ),
  });

  return hasAnyProfileData(profile) ? profile : {};
}

function scanBabepediaProfileHtml(html) {
  const canonical = extractCanonicalHref(html);
  const isPerformerPage =
    Boolean(canonical && isValidBabepediaPerformerUrl(canonical)) ||
    normalizeText(extractTitle(html)).includes(' at babepedia');

  if (!isPerformerPage) {
    return {};
  }

  const info = extractBabepediaInfoMap(html);
  const yearsActiveRaw =
    info.get('years active') ?? extractBabepediaFieldFromHtml(html, 'Years active');
  const nationalityRaw =
    info.get('nationality') ?? extractBabepediaFieldFromHtml(html, 'Nationality');
  const weightRaw = info.get('weight') ?? extractBabepediaFieldFromHtml(html, 'Weight');
  const bornRaw = info.get('born') ?? info.get('birthday') ?? extractBabepediaFieldFromHtml(html, 'Born');
  const aliases = splitBabepediaAliases(info.get('aliases') ?? info.get('alias'));
  const birthday = extractBabepediaBirthday(bornRaw);
  const yearsActive = cleanBabepediaField(
    yearsActiveRaw ?? info.get('career start') ?? info.get('career status'),
  );
  const ageStarted = extractAgeStartedFromYearsActive(yearsActive);
  const normalizedYearsActive = stripTrailingParenthetical(yearsActive);

  const profile = removeEmptyValues({
    completed: true,
    aka: aliases,
    birthday,
    yearsActive: normalizedYearsActive,
    ageStarted,
    ethnicity: cleanBabepediaField(info.get('ethnicity')),
    nationality: normalizeBabepediaNationality(nationalityRaw),
    hairColor: cleanBabepediaField(info.get('hair color')),
    eyeColor: cleanBabepediaField(info.get('eye color')),
    height: cleanBabepediaField(info.get('height')),
    weight: cleanBabepediaField(weightRaw),
    measurements: cleanBabepediaField(info.get('measurements')),
  });

  return hasAnyProfileData(profile) ? profile : {};
}

function mergeScannedData(profile, scanned) {
  return removeEmptyValues({
    ...profile,
    // Preserve the existing canonical performer name from the catalog/profile.
    name: profile.name ?? scanned.name,
    completed: Boolean(scanned.completed),
    noInfoFound: scanned.noInfoFound,
    aka: scanned.aka ?? profile.aka,
    birthday: scanned.birthday ?? profile.birthday,
    ageStarted: scanned.ageStarted ?? profile.ageStarted,
    yearsActive: scanned.yearsActive ?? profile.yearsActive,
    ethnicity: scanned.ethnicity ?? profile.ethnicity,
    nationality: scanned.nationality ?? profile.nationality,
    hairColor: scanned.hairColor ?? profile.hairColor,
    eyeColor: scanned.eyeColor ?? profile.eyeColor,
    height: scanned.height ?? profile.height,
    weight: scanned.weight ?? profile.weight,
    measurements: scanned.measurements ?? profile.measurements,
    dataLinks: scanned.dataLinks ?? profile.dataLinks,
  });
}

function isUsableScanResult(scanned) {
  return Boolean(scanned?.completed && hasAnyProfileData(scanned));
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return cleanValue(match?.[1]);
}

function extractMetaContent(html, name) {
  const escapedName = escapeRegex(name);
  const direct =
    html.match(
      new RegExp(
        `<meta[^>]+(?:name|property)=["']${escapedName}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`,
        'i',
      ),
    ) ??
    html.match(
      new RegExp(
        `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+(?:name|property)=["']${escapedName}["'][^>]*>`,
        'i',
      ),
    );

  return cleanValue(direct?.[1]);
}

function extractCanonicalHref(html) {
  const match =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i) ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
  return cleanValue(match?.[1]);
}

function cleanProfileName(value) {
  const cleaned = cleanValue(value);

  if (!cleaned) {
    return undefined;
  }

  return cleaned
    .replace(/\s+-\s+free nude pics.*$/i, '')
    .replace(/\s+Porn Videos\s+-\s+Verified Pornstar Profile.*$/i, '')
    .trim();
}

function extractBabepediaInfoMap(html) {
  const info = new Map();
  const labelValuePattern =
    /<div[^>]*class=["'][^"']*\binfo-item\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*\blabel\b[^"']*["'][^>]*>\s*([^<:]+):?\s*<\/span>\s*<span[^>]*class=["'][^"']*\bvalue\b[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<\/div>/gi;
  let match = labelValuePattern.exec(html);

  while (match) {
    const label = normalizeText(stripHtml(match[1]));
    const value = cleanValue(stripHtml(match[2]));

    if (label && value) {
      info.set(label, value);
    }

    match = labelValuePattern.exec(html);
  }

  return info;
}

function splitBabepediaAliases(value) {
  const cleaned = cleanBabepediaField(value);

  if (!cleaned) {
    return undefined;
  }

  const aliases = cleaned
    .split(/,|\/|\n/)
    .map((item) => cleanValue(item))
    .filter(Boolean);

  return aliases.length > 0 ? aliases : undefined;
}

function extractBabepediaBirthday(value) {
  const cleaned = cleanBabepediaField(value);

  if (!cleaned) {
    return undefined;
  }

  const dateMatch =
    cleaned.match(/[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+[A-Za-z]+\s+\d{4}/i) ??
    cleaned.match(/[A-Za-z]+\s+\d{1,2},\s+\d{4}/) ??
    cleaned.match(/\d{4}-\d{2}-\d{2}/) ??
    cleaned.match(/\d{1,2}\/\d{1,2}\/\d{4}/);

  const rawDate = cleanValue(dateMatch?.[0] ?? cleaned);
  if (!rawDate) {
    return undefined;
  }

  // Normalize "Sunday 30th of June 2002" -> "June 30, 2002" for reliable Date parsing in UI.
  const longForm = rawDate.match(
    /(?:[A-Za-z]+,\s*)?(?:[A-Za-z]+\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([A-Za-z]+)\s+(\d{4})/i,
  );
  if (longForm) {
    return cleanValue(`${longForm[2]} ${longForm[1]}, ${longForm[3]}`);
  }

  return rawDate;
}

function cleanBabepediaField(value) {
  const cleaned = cleanValue(value);

  if (!cleaned) {
    return undefined;
  }

  return cleaned.replace(/\u00a0/g, ' ').trim();
}

function normalizeBabepediaNationality(value) {
  const cleaned = cleanBabepediaField(value);

  if (!cleaned) {
    return undefined;
  }

  const match = cleaned.match(/\(([^)]+)\)/);
  return cleanValue(match?.[1] ?? cleaned);
}

function hasAnyProfileData(profile) {
  return Boolean(
    profile?.aka?.length ||
      profile?.birthday ||
      profile?.ageStarted ||
      profile?.yearsActive ||
      profile?.ethnicity ||
      profile?.nationality ||
      profile?.hairColor ||
      profile?.eyeColor ||
      profile?.height ||
      profile?.weight ||
      profile?.measurements,
  );
}

function extractBabepediaFieldFromHtml(html, label) {
  const escapedLabel = escapeRegex(label);
  const match = html.match(
    new RegExp(`${escapedLabel}:\\s*([\\s\\S]{1,200}?)\\s*(?:<br\\s*\\/?>|<\\/div>|<\\/p>|<span class=)`, 'i'),
  );

  return cleanBabepediaField(stripHtml(match?.[1] ?? ''));
}

function extractAgeStartedFromYearsActive(yearsActive) {
  if (!yearsActive) {
    return undefined;
  }

  const match = yearsActive.match(/started around (\d{1,2}) years?/i);
  return match ? Number(match[1]) : undefined;
}

function stripTrailingParenthetical(value) {
  const cleaned = cleanBabepediaField(value);

  if (!cleaned) {
    return undefined;
  }

  return cleaned.replace(/\s*\([^)]*\)\s*$/u, '').trim();
}

function stripHtml(value) {
  const withoutTags = String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');

  return withoutTags.replace(/\s+/g, ' ').trim();
}

function extractPornhubInfoMap(html) {
  const info = new Map();
  const infoPiecePattern =
    /<div[^>]*class=["'][^"']*\binfoPiece\b[^"']*["'][^>]*>\s*<span[^>]*>\s*([^<:]+):?\s*<\/span>\s*([\s\S]*?)\s*<\/div>/gi;
  let match = infoPiecePattern.exec(html);

  while (match) {
    const label = normalizeText(stripHtml(match[1]));
    const value = cleanValue(stripHtml(match[2]));

    if (label && value) {
      info.set(label, value);
    }

    match = infoPiecePattern.exec(html);
  }

  return info;
}

function extractPornhubDescription(html) {
  const descriptionMatch = html.match(
    /<div[^>]+itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  return cleanValue(stripHtml(descriptionMatch?.[1] ?? ''));
}

function extractPornhubDescriptionData(description) {
  if (!description) {
    return {};
  }

  const birthdayMatch = description.match(/born in ([A-Za-z]+\s+\d{4})/i);
  const ageStartedMatch = description.match(/at age (\d{1,2})/i);
  const heightFeetMatch = description.match(/(\d'\d{1,2})(?:\s*tall)?/i);
  const ethnicityMatch = description.match(/half\s+([a-z ]+),\s*half\s+([a-z ]+)/i);

  return removeEmptyValues({
    birthday: cleanValue(birthdayMatch?.[1]),
    ageStarted: ageStartedMatch ? Number(ageStartedMatch[1]) : undefined,
    height: cleanValue(heightFeetMatch?.[1]),
    ethnicity: ethnicityMatch
      ? cleanValue(`${ethnicityMatch[1]} / ${ethnicityMatch[2]}`)
      : undefined,
  });
}

function cleanPornhubField(value) {
  const cleaned = cleanValue(value);

  if (!cleaned) {
    return undefined;
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

async function readPerformerProfile(performerId) {
  try {
    const performerPath = path.join(performersDirectoryPath, `${performerId}.json`);
    const content = await readFile(performerPath, 'utf8');
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildWorkingProfile(performer, existingProfile) {
  if (existingProfile && typeof existingProfile === 'object') {
    const normalizedExistingName = normalizeExistingPerformerName(
      existingProfile.name,
      performer.searchName,
      performer.name,
    );

    return removeEmptyValues({
      ...existingProfile,
      id: performer.id,
      name: normalizedExistingName,
      searchName: existingProfile.searchName ?? performer.searchName,
      completed: Boolean(existingProfile.completed),
      isPerformer: true,
    });
  }

  return {
    id: performer.id,
    name: performer.name,
    searchName: performer.searchName,
    completed: false,
    noInfoFound: performer.noInfoFound,
    isPerformer: true,
  };
}

function normalizeLookupPerformer(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (typeof value.id !== 'string' || typeof value.name !== 'string') {
    return undefined;
  }

  return {
    id: value.id.trim(),
    name: value.name.trim(),
    searchName: cleanValue(value.searchName),
    completed: Boolean(value.completed),
    noInfoFound: Boolean(value.noInfoFound),
  };
}

function mergeDataLinks(...groups) {
  const links = groups.flat().filter((item) => item !== undefined);

  if (links.length === 0) {
    return undefined;
  }

  return links.filter(
    (link, index, candidates) =>
      Boolean(link?.url) && candidates.findIndex((candidate) => candidate.url === link.url) === index,
  );
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeExistingPerformerName(existingName, searchName, fallbackName) {
  const cleanedExisting = cleanValue(existingName);

  if (!cleanedExisting) {
    return cleanValue(searchName) ?? fallbackName;
  }

  const pollutedByTitle =
    /\s-\s+free pics,\s+galleries/i.test(cleanedExisting) ||
    /\sPorn Videos\s+-\s+Verified Pornstar Profile/i.test(cleanedExisting);

  if (!pollutedByTitle) {
    return cleanedExisting;
  }

  return cleanValue(searchName) ?? fallbackName;
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
