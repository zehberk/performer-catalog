# Data Collection

This folder is for local-only data collection. Keep API keys out of Angular code.

## Start

1. Create a local `.env` file based on `.env.example`.
2. Add your Brave Search API key as `BRAVE_SEARCH_API_KEY`.
3. Run:

```bash
npm run collect:data -- --limit 10
```

Omit `--limit` to process every name in `list.txt`.

The script reads `list.txt`, searches Brave for each name plus `iafd`, finds an `iafd.com/person.rme` result, fetches that profile page, and writes starter records to `public/performers.json`.

For the current test loop, use:

```bash
npm run collect:data -- --limit 1
```

The parser currently extracts basic profile fields. Add movie-credit extraction after the profile fetch and field matching are reliable.
