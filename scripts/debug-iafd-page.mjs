import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
const outputDirectory = new URL('../debug/iafd/', import.meta.url);
const performersPath = new URL('../public/performers.json', import.meta.url);

const args = new Map(
  process.argv
    .slice(2)
    .map((arg, index, allArgs) => (arg.startsWith('--') ? [arg.slice(2), allArgs[index + 1]] : null))
    .filter(Boolean),
);

const performers = JSON.parse(await readFile(performersPath, 'utf8'));
const targetUrl = args.get('url');
const targetName = args.get('name');
const headed = args.has('headed') || process.env.npm_config_headed === 'true';
const waitMs = Number(args.get('wait-ms') ?? process.env.npm_config_wait_ms ?? (headed ? 10_000 : 0));
const performer = targetUrl ? undefined : findPerformer(performers, targetName);
const iafdUrl = targetUrl ?? performer?.dataLinks?.find((link) => link.source === 'iafd')?.url;

if (!iafdUrl) {
  throw new Error(
    targetName
      ? `No IAFD URL found in performers.json for "${targetName}".`
      : 'No incomplete IAFD-linked performer found in performers.json.',
  );
}

await mkdir(outputDirectory, { recursive: true });

const label = slugify(targetName ?? performer?.name ?? new URL(iafdUrl).pathname);
const browser = await chromium.launch({ headless: !headed });
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
  const response = await page.goto(iafdUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(Number.isFinite(waitMs) ? waitMs : 0);

  const html = await page.content();
  const metadata = {
    name: performer?.name ?? targetName,
    headed,
    requestedUrl: iafdUrl,
    finalUrl: page.url(),
    status: response?.status(),
    statusText: response?.statusText(),
    title: await page.title(),
    challengeDetected: isChallengePage(html),
    capturedAt: new Date().toISOString(),
  };

  const htmlPath = new URL(`${label}.html`, outputDirectory);
  const screenshotPath = new URL(`${label}.png`, outputDirectory);
  const metadataPath = new URL(`${label}.json`, outputDirectory);

  await writeFile(htmlPath, html);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await page.screenshot({ path: fileURLToPath(screenshotPath), fullPage: true });

  console.log(`Captured ${metadata.name ?? iafdUrl}`);
  console.log(`Status: ${metadata.status ?? 'unknown'} ${metadata.statusText ?? ''}`.trim());
  console.log(`Final URL: ${metadata.finalUrl}`);
  console.log(`Challenge detected: ${metadata.challengeDetected ? 'yes' : 'no'}`);
  console.log(`HTML: ${htmlPath.pathname}`);
  console.log(`Screenshot: ${screenshotPath.pathname}`);
  console.log(`Metadata: ${metadataPath.pathname}`);
} finally {
  await context.close();
  await browser.close();
}

function findPerformer(performers, name) {
  if (name) {
    return performers.find((performer) => performer.name.toLowerCase() === name.toLowerCase());
  }

  return performers.find(
    (performer) => !performer.completed && performer.dataLinks?.some((link) => link.source === 'iafd'),
  );
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

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
