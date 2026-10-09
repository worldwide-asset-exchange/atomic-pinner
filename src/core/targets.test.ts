import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadTargets,
  splitTargets,
  writeChunks,
  TargetsError,
  tokenId,
} from './targets.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-targets-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('loadTargets', () => {
  it('loads a valid file and fills missing arrays', async () => {
    const file = path.join(dir, 't.json');
    await fs.writeFile(file, JSON.stringify({ collection: ['a', 'b'] }));
    expect(await loadTargets(file)).toEqual({
      collection: ['a', 'b'],
      token: [],
    });
  });

  it('reports a missing file with its path', async () => {
    await expect(loadTargets(path.join(dir, 'nope.json'))).rejects.toThrow(
      TargetsError
    );
    await expect(loadTargets(path.join(dir, 'nope.json'))).rejects.toThrow(
      /nope\.json: cannot read/
    );
  });

  it('reports invalid JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{ not json');
    await expect(loadTargets(file)).rejects.toThrow(/invalid JSON/);
  });

  it('reports schema problems with their path', async () => {
    const file = path.join(dir, 'schema.json');
    await fs.writeFile(
      file,
      JSON.stringify({ collection: ['ok', 42], token: [{ chain: 'solana' }] })
    );
    await expect(loadTargets(file)).rejects.toThrow(/collection\.1/);
    await expect(loadTargets(file)).rejects.toThrow(/token\.0\.address/);
  });
});

describe('splitTargets', () => {
  const targets = {
    collection: ['a', 'b', 'c', 'd', 'e'],
    token: [{ chain: 'solana', address: 'x' }],
  };

  it('splits collections evenly and keeps tokens in the first chunk', () => {
    const chunks = splitTargets(targets, 2);
    expect(chunks.map((c) => c.collection)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
    expect(chunks[0].token).toEqual(targets.token);
    expect(chunks[1].token).toEqual([]);
  });

  it('always yields at least one chunk', () => {
    expect(splitTargets({ collection: [], token: targets.token }, 10)).toEqual([
      { collection: [], token: targets.token },
    ]);
  });

  it('rejects a chunk size below one', () => {
    expect(() => splitTargets(targets, 0)).toThrow();
  });
});

describe('writeChunks', () => {
  it('writes zero-padded, sorted chunk files', async () => {
    const files = await writeChunks({
      targets: {
        collection: Array.from({ length: 23 }, (_, i) => `c${i}`),
        token: [],
      },
      directory: path.join(dir, 'chunks'),
      prefix: 'targets-chunk',
      perChunk: 2,
    });
    expect(files).toHaveLength(12);
    expect(path.basename(files[0])).toBe('targets-chunk-01.json');
    expect(path.basename(files[11])).toBe('targets-chunk-12.json');
    const last = JSON.parse(await fs.readFile(files[11], 'utf8'));
    expect(last).toEqual({ collection: ['c22'], token: [] });
  });
});

describe('tokenId', () => {
  it('joins chain and address', () => {
    expect(tokenId({ chain: 'solana', address: 'abc' })).toBe('solana:abc');
  });
});
