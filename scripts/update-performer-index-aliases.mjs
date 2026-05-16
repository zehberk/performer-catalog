import { readFile, writeFile } from 'node:fs/promises';

const dataRootPath = new URL('../public/data/', import.meta.url);
const performersIndexPath = new URL('./performers.index.json', dataRootPath);

const index = await readPerformersIndex();
let updatedCount = 0;

for (const summary of index) {
  if (!summary || typeof summary.profilePath !== 'string') {
    continue;
  }

  if (!summary.profilePath.startsWith('data/performers/')) {
    continue;
  }

  const profile = await readProfile(summary.profilePath);
  const aliases = normalizeAliases(profile?.aka);
  const currentAliases = normalizeAliases(summary.aliases);

  if (areStringArraysEqual(aliases, currentAliases)) {
    continue;
  }

  summary.aliases = aliases;
  updatedCount += 1;
}

await writeFile(performersIndexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(`Updated aliases in performers.index.json for ${updatedCount} performers.`);

async function readPerformersIndex() {
  const content = await readFile(performersIndexPath, 'utf8');
  const index = JSON.parse(content);

  if (!Array.isArray(index)) {
    throw new Error('performers.index.json is not an array.');
  }

  return index;
}

async function readProfile(profilePath) {
  try {
    const profileUrl = new URL(`../${profilePath}`, dataRootPath);
    const content = await readFile(profileUrl, 'utf8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function normalizeAliases(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const aliases = [...new Set(value.map((alias) => (typeof alias === 'string' ? alias.trim() : '')).filter(Boolean))];
  return aliases.length > 0 ? aliases : undefined;
}

function areStringArraysEqual(left, right) {
  if (left === undefined && right === undefined) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
