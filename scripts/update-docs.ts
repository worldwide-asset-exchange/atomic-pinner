/**
 * Regenerates the parts of the docs that derive from src/config/schema.ts:
 *   - README.md between <!-- config:start --> and <!-- config:end -->
 *   - .env.example (whole file)
 *
 * `yarn docs` writes them; `yarn docs --check` exits 1 when they are stale (CI).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as prettier from 'prettier';
import { renderConfigReference, renderEnvExample } from '../src/config/docs.js';

const check = process.argv.includes('--check');
const START = '<!-- config:start -->';
const END = '<!-- config:end -->';

function firstDifference(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i])
      return `line ${i + 1}:\n  have: ${JSON.stringify(al[i])}\n  want: ${JSON.stringify(bl[i])}`;
  }
  return 'no line differs (trailing whitespace?)';
}

async function updateReadme(): Promise<boolean> {
  const file = 'README.md';
  const current = readFileSync(file, 'utf8');
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${file}: missing ${START} / ${END} markers`);
  }
  const inserted =
    current.slice(0, start + START.length) +
    '\n\n' +
    renderConfigReference() +
    '\n' +
    current.slice(end);
  // The README is prettier-formatted (tables get padded), so format before comparing.
  const options = (await prettier.resolveConfig(file)) ?? {};
  const next = await prettier.format(inserted, { ...options, filepath: file });
  if (next === current) return false;
  if (check)
    console.error(`${file} differs at ${firstDifference(current, next)}`);
  else writeFileSync(file, next);
  return true;
}

function updateEnvExample(): boolean {
  const file = '.env.example';
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // first run
  }
  const next = renderEnvExample();
  if (next === current) return false;
  if (check)
    console.error(`${file} differs at ${firstDifference(current, next)}`);
  else writeFileSync(file, next);
  return true;
}

const changed = [
  (await updateReadme()) && 'README.md',
  updateEnvExample() && '.env.example',
].filter(Boolean);
if (check && changed.length > 0) {
  console.error(
    `Generated docs are stale: ${changed.join(', ')}. Run \`yarn docs\`.`
  );
  process.exit(1);
}
console.log(
  changed.length > 0 ? `Updated ${changed.join(', ')}` : 'Docs up to date'
);
