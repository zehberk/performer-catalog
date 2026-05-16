import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright';

const braveSearchUrl = 'https://api.search.brave.com/res/v1/web/search';
const iafdOrigin = 'https://www.iafd.com';
const iafdUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36';
const iafdExtraHttpHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};
const envPath = new URL('../.env', import.meta.url);
const listPath = new URL('../list.txt', import.meta.url);
const dataRootPath = new URL('../public/data/', import.meta.url);
const performersPath = new URL('../public/data/performers/', import.meta.url);
const studiosPath = new URL('../public/data/studios/', import.meta.url);
const channelsPath = new URL('../public/data/channels/', import.meta.url);
const logsPath = new URL('../logs/', import.meta.url);

const args = new Map(
  process.argv
    .slice(2)
    .map((arg, index, allArgs) => (arg.startsWith('--') ? [arg.slice(2), allArgs[index + 1]] : null))
    .filter(Boolean),
);

const positionalLimit = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
const limit = args.has('limit') ? Number(args.get('limit')) : Number(positionalLimit);
const checkpointInterval = 10;
const requestTimeoutMs = 10_000;
const timeoutRetryDelayMs = 10_000;
const maxTimeoutAttempts = 2;
const runId = createRunId();
const runLogPath = new URL(`collect-performers.${runId}.log`, logsPath);
const localEnv = await readLocalEnv();
const apiKey = process.env.BRAVE_SEARCH_API_KEY ?? localEnv.BRAVE_SEARCH_API_KEY;

if (!apiKey) {
  throw new Error('Missing BRAVE_SEARCH_API_KEY. Create a local .env file or set the env var before running.');
}

const entries = (await readFile(listPath, 'utf8'))
  .split(/\r?\n/)
  .map(parseListEntry)
  .filter(Boolean);

const entriesToCollect = Number.isFinite(limit) ? entries.slice(0, limit) : entries;
await initializeRunLog(entriesToCollect.length);

const existingCatalog = await readExistingCatalog();
const performers = [...existingCatalog.performers];
const studios = [...existingCatalog.studios];
const channels = [...existingCatalog.channels];
const processedPerformerIds = new Set(performers.map((profile) => profile.id));
const processedStudioIds = new Set(studios.map((profile) => profile.id));
const processedChannelIds = new Set(channels.map((profile) => profile.id));
let iafdBrowser;

try {
  await writeCatalogData({ performers, studios, channels });

  for (let index = 0; index < entriesToCollect.length; index += 1) {
    const entry = entriesToCollect[index];
    const entryId = createEntityId(entry.name);

    if (entry.kind === 'performer' || entry.kind === 'disambiguated') {
      if (processedPerformerIds.has(entryId)) {
        console.log(`skipped existing performer: ${entry.name}`);
        continue;
      }
    }

    if (entry.kind === 'studio') {
      if (processedStudioIds.has(entryId)) {
        console.log(`skipped existing studio: ${entry.name}`);
        continue;
      }
    }

    if (entry.kind === 'channel') {
      if (processedChannelIds.has(entryId)) {
        console.log(`skipped existing channel: ${entry.name}`);
        continue;
      }
    }

    try {
      await processEntry(entry, performers, studios, channels);
    } catch (error) {
      console.warn(
        `Entry failed for "${entry.name}": ${error instanceof Error ? error.message : String(error)}. Saving as missing.`,
      );
      performers.push(createIncompletePerformerProfile(entry));
    }

    if (entry.kind === 'performer' || entry.kind === 'disambiguated') {
      processedPerformerIds.add(entryId);
    } else if (entry.kind === 'studio') {
      processedStudioIds.add(entryId);
    } else if (entry.kind === 'channel') {
      processedChannelIds.add(entryId);
    }

    if ((index + 1) % checkpointInterval === 0) {
      await writeCatalogData({ performers, studios, channels });
      console.log(`checkpoint saved: ${index + 1}/${entriesToCollect.length}`);
    }
  }
} finally {
  await iafdBrowser?.close();
}

await writeCatalogData({ performers, studios, channels });

async function processEntry(entry, performers, studios, channels) {
  const searchResults = await findProfileSearchResults(entry).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes(' with 402')) {
      console.warn(`Brave returned 402 for "${entry.name}". Continuing with missing profile.`);
      return { topResult: undefined, iafdResult: undefined };
    }

    throw error;
  });

  const primaryDataLink =
    entry.kind === 'studio' || entry.kind === 'channel' || entry.kind === 'disambiguated'
      ? searchResults.topResult && searchResultToDataLink(searchResults.topResult)
      : undefined;

  if (entry.kind === 'studio') {
    studios.push(createEntityProfile(entry, 'studio', primaryDataLink));
    console.log(`studio: ${entry.name}`);
    return;
  }

  if (entry.kind === 'channel') {
    channels.push(createEntityProfile(entry, 'channel', primaryDataLink));
    console.log(`channel: ${entry.name}`);
    return;
  }

  const secondaryDataLinks = await findPornModelDataLinks(entry).catch((error) => {
    console.warn(
      `Secondary search failed for "${entry.name}": ${error instanceof Error ? error.message : String(error)}`,
    );

    return [];
  });
  const baseDataLinks = mergeDataLinks(primaryDataLink ? [primaryDataLink] : [], secondaryDataLinks);
  const iafdUrl = searchResults.iafdResult ? normalizeIafdUrl(searchResults.iafdResult.url) : undefined;

  if (!iafdUrl) {
    performers.push(createIncompletePerformerProfile(entry, baseDataLinks));
    console.log(`missing: ${entry.name}`);
    return;
  }

  const profile = await fetchIafdProfile(entry, iafdUrl, baseDataLinks);
  performers.push(profile);

  console.log(`${profile.completed ? 'fetched' : 'linked only'}: ${entry.name}`);
}

function parseListEntry(line) {
  const value = line.trim();

  if (!value) {
    return undefined;
  }

  const parentheticalMatch = value.match(/\(([^)]+)\)\s*$/);
  const qualifier = parentheticalMatch?.[1]?.trim().toLowerCase();
  const name = parentheticalMatch ? value.slice(0, parentheticalMatch.index).trim() : value;

  if (qualifier === 'studio') {
    return { kind: 'studio', name, query: value, includeIafdInQuery: false };
  }

  if (qualifier === 'channel') {
    return { kind: 'channel', name, query: value, includeIafdInQuery: false };
  }

  if (qualifier === 'iafd') {
    return { kind: 'performer', name, query: value, includeIafdInQuery: false };
  }

  if (qualifier) {
    return { kind: 'disambiguated', name, query: value, includeIafdInQuery: false };
  }

  return { kind: 'performer', name: value, query: value, includeIafdInQuery: true };
}

async function findProfileSearchResults(entry) {
  const url = new URL(braveSearchUrl);
  url.search = new URLSearchParams({
    q: entry.includeIafdInQuery ? `${entry.query} iafd` : entry.query,
    count: '10',
    country: 'us',
    search_lang: 'en',
  });

  const response = await fetchWithTimeoutRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
    { entryName: entry.name, apiName: 'brave.search.primary' },
  );

  if (!response.ok) {
    throw new Error(`Brave search failed for "${entry.query}" with ${response.status}`);
  }

  const result = await response.json();
  const webResults = Array.isArray(result.web?.results) ? result.web.results : [];
  const topResult = webResults.find((item) => typeof item.url === 'string');
  const iafdResult = webResults.find((item) => typeof item.url === 'string' && item.url.includes('iafd.com/person.rme'));

  return { topResult, iafdResult };
}

async function findPornModelDataLinks(entry) {
  const url = new URL(braveSearchUrl);
  url.search = new URLSearchParams({
    q: `${entry.name} porn`,
    count: '10',
    country: 'us',
    search_lang: 'en',
  });

  const response = await fetchWithTimeoutRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
    { entryName: entry.name, apiName: 'brave.search.secondary' },
  );

  if (!response.ok) {
    throw new Error(`Brave fallback search failed for "${entry.name}" with ${response.status}`);
  }

  const result = await response.json();
  const webResults = Array.isArray(result.web?.results) ? result.web.results : [];

  return webResults
    .filter((item) => typeof item.url === 'string' && isModelProfileUrl(item.url))
    .map(searchResultToDataLink)
    .filter((link, index, links) => links.findIndex((candidate) => candidate.url === link.url) === index);
}

async function fetchIafdProfile(entry, iafdUrl, baseDataLinks) {
  const iafdDataLink = { label: 'IAFD', source: 'iafd', url: iafdUrl };
  const dataLinks = mergeDataLinks(baseDataLinks, [iafdDataLink]);
  const browser = await getIafdBrowser();
  const context = await browser.newContext({
    extraHTTPHeaders: iafdExtraHttpHeaders,
    locale: 'en-US',
    timezoneId: 'America/Denver',
    userAgent: iafdUserAgent,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  try {
    const response = await withTimeoutRetry(
      () => page.goto(iafdUrl, { waitUntil: 'domcontentloaded', timeout: requestTimeoutMs }),
      `IAFD profile fetch for "${entry.name}"`,
    );

    if (!response?.ok()) {
      return createIncompletePerformerProfile(entry, dataLinks[0]);
    }

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    const html = await page.content();

    if (isChallengePage(html)) {
      return createIncompletePerformerProfile(entry, dataLinks[0]);
    }

    const profile = parseIafdProfile(html, entry, dataLinks);

    if (!doesIafdProfileMatchEntry(profile, entry)) {
      console.warn(`IAFD result did not match "${entry.name}". Using fallback data links.`);

      return createIncompletePerformerProfile(entry, baseDataLinks);
    }

    return profile;
  } catch (error) {
    console.warn(`IAFD fetch failed for "${entry.name}": ${error instanceof Error ? error.message : String(error)}`);

    return createIncompletePerformerProfile(entry, dataLinks[0]);
  } finally {
    await context.close();
  }
}

async function fetchWithTimeoutRetry(url, options, metadata) {
  return withTimeoutRetry(async () => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      await logApiCall({
        event: 'request_start',
        api: metadata.apiName,
        entry: metadata.entryName,
        url: url.toString(),
      });
      const response = await fetch(url, { ...options, signal: controller.signal });
      await logApiCall({
        event: 'request_success',
        api: metadata.apiName,
        entry: metadata.entryName,
        url: url.toString(),
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      await logApiCall({
        event: 'request_error',
        api: metadata.apiName,
        entry: metadata.entryName,
        url: url.toString(),
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }, `request to ${url.toString()}`);
}

async function withTimeoutRetry(task, label) {
  for (let attempt = 1; attempt <= maxTimeoutAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        await appendRunLog(`[retry] ${label} attempt ${attempt}/${maxTimeoutAttempts}`);
      }
      return await task();
    } catch (error) {
      if (!isTimeoutError(error) || attempt === maxTimeoutAttempts) {
        throw error;
      }

      console.warn(`${label} timed out. Retrying in ${timeoutRetryDelayMs / 1000} seconds...`);
      await sleep(timeoutRetryDelayMs);
    }
  }
}

function isTimeoutError(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    /timed out|timeout|aborted/i.test(error.message)
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function initializeRunLog(entryCount) {
  await mkdir(logsPath, { recursive: true });
  await appendRunLog(`collect-performers run started`);
  await appendRunLog(`run_id=${runId}`);
  await appendRunLog(`entries=${entryCount}`);
}

async function logApiCall(details) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...details,
  });
  await appendRunLog(line);
}

async function appendRunLog(message) {
  const timestamp = new Date().toISOString();
  await writeFile(runLogPath, `[${timestamp}] ${message}\n`, { flag: 'a' });
}

function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
    return url;
  }
}

function createEntityId(name) {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function readExistingCatalog() {
  const performers = await readExistingProfiles('performers');
  const studios = await readExistingProfiles('studios');
  const channels = await readExistingProfiles('channels');

  return { performers, studios, channels };
}

async function readExistingProfiles(type) {
  const indexUrl = new URL(`${type}.index.json`, dataRootPath);

  try {
    const indexContent = await readFile(indexUrl, 'utf8');
    const summaries = JSON.parse(indexContent);

    if (!Array.isArray(summaries)) {
      return [];
    }

    const profiles = await Promise.all(
      summaries.map(async (summary) => {
        if (!summary || typeof summary.profilePath !== 'string') {
          return undefined;
        }

        try {
          const profileUrl = new URL(`../${summary.profilePath}`, dataRootPath);
          const profileContent = await readFile(profileUrl, 'utf8');

          return JSON.parse(profileContent);
        } catch {
          return undefined;
        }
      }),
    );

    return profiles.filter(Boolean);
  } catch {
    return [];
  }
}

function createIncompletePerformerProfile(entry, dataLinks) {
  return removeEmptyValues({
    id: createEntityId(entry.name),
    name: entry.name,
    searchName: entry.query,
    completed: false,
    isPerformer: true,
    dataLinks: normalizeDataLinks(dataLinks),
  });
}

function createEntityProfile(entry, type, primaryDataLink) {
  return removeEmptyValues({
    id: createEntityId(entry.name),
    name: entry.name,
    searchName: entry.query,
    completed: false,
    type,
    profilePath: `data/${type}s/${createEntityId(entry.name)}.json`,
    dataLinks: primaryDataLink ? [primaryDataLink] : undefined,
  });
}

function normalizeDataLinks(dataLinks) {
  if (!dataLinks) {
    return undefined;
  }

  return mergeDataLinks(Array.isArray(dataLinks) ? dataLinks : [dataLinks]);
}

function mergeDataLinks(...linkGroups) {
  const links = linkGroups.flat().filter(Boolean);

  return links.filter((link, index) => links.findIndex((candidate) => candidate.url === link.url) === index);
}

async function writeCatalogData(catalog) {
  await ensureDataDirectories();
  await writeProfileCollection('performer', performersPath, catalog.performers);
  await writeProfileCollection('studio', studiosPath, catalog.studios);
  await writeProfileCollection('channel', channelsPath, catalog.channels);
}

async function ensureDataDirectories() {
  await mkdir(dataRootPath, { recursive: true });
  await mkdir(performersPath, { recursive: true });
  await mkdir(studiosPath, { recursive: true });
  await mkdir(channelsPath, { recursive: true });
}

async function writeProfileCollection(type, directory, profiles) {
  const summaries = [];

  for (const profile of profiles) {
    const profilePath = `data/${type}s/${profile.id}.json`;
    summaries.push({
      id: profile.id,
      name: profile.name,
      searchName: profile.searchName,
      aliases: profile.aka,
      completed: profile.completed,
      type,
      profilePath,
    });

    const profileUrl = new URL(`${profile.id}.json`, directory);
    const profileExists = await fileExists(profileUrl);

    if (!profileExists) {
      await writeFile(profileUrl, `${JSON.stringify(profile, null, 2)}\n`);
    }
  }

  summaries.sort((first, second) => first.name.localeCompare(second.name));
  await writeFile(new URL(`${type}s.index.json`, dataRootPath), `${JSON.stringify(summaries, null, 2)}\n`);
}

async function fileExists(pathOrUrl) {
  try {
    await access(pathOrUrl);
    return true;
  } catch {
    return false;
  }
}

async function getIafdBrowser() {
  iafdBrowser ??= await chromium.launch({ headless: true });

  return iafdBrowser;
}

function parseIafdProfile(html, entry, dataLinks) {
  const { document } = new JSDOM(html).window;
  const bio = collectBioFields(document);
  const birthday = removeParentheticalAge(bio.get('birthday'));
  const yearsActive = bio.get('years active');
  const name = cleanValue(document.querySelector('h1')?.textContent) ?? entry.name;

  return removeEmptyValues({
    id: createEntityId(name),
    name,
    searchName: entry.query,
    completed: true,
    isPerformer: true,
    aka: splitLines(bio.get('performer aka')),
    birthday,
    yearsActive,
    ageStarted: extractAgeStarted(yearsActive),
    databases: extractDatabases(document),
    ethnicity: bio.get('ethnicity'),
    nationality: bio.get('nationality'),
    hairColor: bio.get('hair colors') ?? bio.get('hair color'),
    eyeColor: bio.get('eye color'),
    height: bio.get('height'),
    weight: bio.get('weight'),
    measurements: bio.get('measurements'),
    shoeSize: bio.get('shoe size'),
    credits: extractMovieCreditsFromDocument(document),
    dataLinks,
  });
}

function doesIafdProfileMatchEntry(profile, entry) {
  const expectedName = normalizeNameForMatch(entry.name);
  const candidateNames = [profile.name, ...(profile.aka ?? [])].map(normalizeNameForMatch);

  return candidateNames.includes(expectedName);
}

function normalizeNameForMatch(value) {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function collectBioFields(document) {
  const fields = new Map();

  for (const heading of document.querySelectorAll('.bioheading')) {
    const label = normalizeText(heading.textContent);
    const values = [];
    let sibling = heading.nextSibling;

    while (sibling) {
      if (sibling.nodeType === 1 && sibling.classList.contains('bioheading')) {
        break;
      }

      if (sibling.nodeType === 1 && ['corrections', 'persontitlead'].includes(sibling.id)) {
        break;
      }

      const text = cleanMultilineValue(nodeToText(sibling));

      if (text) {
        values.push(text);
      }

      sibling = sibling.nextSibling;
    }

    const value = cleanMultilineValue(values.join('\n'));

    if (label && value) {
      fields.set(label, value);
    }
  }

  return fields;
}

function extractAgeStarted(yearsActive) {
  const match = yearsActive?.match(/Started around (\d+) years old/i);

  return match ? Number(match[1]) : undefined;
}

function removeParentheticalAge(birthday) {
  return cleanValue(birthday?.replace(/\s*\(\d+ years old\)/i, ''));
}

function extractDatabases(document) {
  const databaseHeading = Array.from(document.querySelectorAll('.bioheading')).find(
    (heading) => normalizeText(heading.textContent) === 'databases',
  );

  if (!databaseHeading) {
    return undefined;
  }

  const links = [];
  let sibling = databaseHeading.nextSibling;

  while (sibling) {
    if (sibling.nodeType === 1 && sibling.classList.contains('bioheading')) {
      break;
    }

    if (sibling.nodeType === 1) {
      for (const anchor of sibling.matches('a') ? [sibling] : sibling.querySelectorAll('a')) {
        const label = cleanValue(anchor.textContent);
        const url = anchor.href;

        if (label && url) {
          links.push({ label, url });
        }
      }
    }

    sibling = sibling.nextSibling;
  }

  return links.length > 0 ? links : undefined;
}

function nodeToText(node) {
  if (node.nodeType !== 1) {
    return node.textContent ?? '';
  }

  const clone = node.cloneNode(true);

  for (const lineBreak of clone.querySelectorAll('br')) {
    lineBreak.replaceWith('\n');
  }

  return clone.textContent ?? '';
}

function cleanMultilineValue(value) {
  const lines = value
    ?.replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  return lines?.length ? lines.join('\n') : undefined;
}

function extractMovieCreditsFromDocument(document) {
  const rows = Array.from(document.querySelectorAll('#personal tbody tr'));
  const credits = rows
    .map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      const year = Number(cleanValue(cells[1]?.textContent));

      return removeEmptyValues({
        title: cleanValue(cells[0]?.textContent),
        year,
        distributor: cleanValue(cells[2]?.textContent) ?? '',
        notes: cleanValue(cells[3]?.textContent),
      });
    })
    .filter((credit) => credit.title && Number.isFinite(credit.year));

  return credits.length > 0 ? credits : undefined;
}

function extractValue(text, labels) {
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);
    const lineMatch = text.match(new RegExp(`(?:^|\\n)${escapedLabel}\\s*:?\\s*([^\\n]+)`, 'i'));
    const nextLineMatch = text.match(new RegExp(`(?:^|\\n)${escapedLabel}\\s*\\n\\s*([^\\n]+)`, 'i'));
    const nestedMatch = text.match(new RegExp(`${escapedLabel}\\s*:?\\s+([^\\n:]+?)(?=\\s+[A-Z][A-Za-z ]{2,}:|\\n|$)`, 'i'));
    const value = cleanValue(lineMatch?.[1] ?? nextLineMatch?.[1] ?? nestedMatch?.[1]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function extractMovieCredits(html) {
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) ?? [];

  for (const table of tables) {
    const rows = parseTableRows(table);
    const header = rows[0]?.map(normalizeText) ?? [];
    const yearIndex = header.findIndex((cell) => cell === 'year' || cell.includes('release year'));
    const titleIndex = header.findIndex((cell) => cell === 'title' || cell.includes('movie'));
    const distributorIndex = header.findIndex((cell) => cell.includes('distributor') || cell.includes('studio'));

    if (yearIndex < 0 || titleIndex < 0) {
      continue;
    }

    return rows
      .slice(1)
      .map((row) =>
        removeEmptyValues({
          title: cleanValue(row[titleIndex]),
          year: Number(row[yearIndex]),
          distributor: cleanValue(row[distributorIndex]) ?? '',
        }),
      )
      .filter((credit) => credit.title && Number.isFinite(credit.year));
  }

  return undefined;
}

function parseTableRows(table) {
  return (table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [])
    .map((row) =>
      (row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) ?? [])
        .map((cell) => htmlToText(cell))
        .filter(Boolean),
    )
    .filter((row) => row.length > 0);
}

function splitList(value) {
  if (!value) {
    return undefined;
  }

  return value
    .split(/,|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value) {
  if (!value) {
    return undefined;
  }

  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isChallengePage(html) {
  if (isIafdProfilePage(html)) {
    return false;
  }

  return (
    html.includes('Enable JavaScript and cookies to continue') ||
    html.includes('Checking if the site connection is secure') ||
    /<title>\s*Just a moment/i.test(html)
  );
}

function isIafdProfilePage(html) {
  return (
    html.includes('<link rel="canonical" href="https://www.iafd.com/person.rme/') ||
    (html.includes('id="headshot"') && html.includes('Performer Credits'))
  );
}

function normalizeIafdUrl(value) {
  const url = new URL(value);
  url.protocol = 'https:';
  url.hostname = 'www.iafd.com';
  url.hash = '';

  return url.href.startsWith(iafdOrigin) ? url.href : undefined;
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(br|div|li|p|td|th|tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim(),
  );
}

function normalizeText(value) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readLocalEnv() {
  try {
    const content = await readFile(envPath, 'utf8');

    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separatorIndex = line.indexOf('=');
          return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
        }),
    );
  } catch {
    return {};
  }
}
