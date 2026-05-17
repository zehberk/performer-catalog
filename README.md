# Performer Catalog

A simple tool that catalogues performer data

## Playwright proxy (development)

IAFD blocks some automated requests. To get fully-rendered HTML (including dynamic content), run the local Playwright proxy and have the app query it before falling back to the reader proxy.

Start the proxy by itself:

```bash
npm run start:proxy
```

Start the proxy and the dev server together:

```bash
npm run start:dev
```

Quick check (starts a temporary proxy and verifies it can fetch a page):

```bash
npm run proxy:check
```

Notes:

- The proxy uses Playwright and launches a headless Chromium instance.
- Install dependencies after pulling these changes: `npm install`.
- Keep the proxy running in development while testing IAFD fetches.
