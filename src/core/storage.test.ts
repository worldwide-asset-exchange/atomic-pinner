import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage } from './storage.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-storage-'));
  file = path.join(dir, 'progress.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Storage', () => {
  it('starts empty and persists across instances', async () => {
    const a = new Storage(file);
    expect(await a.getPinnedCollection('x')).toBeUndefined();
    await a.pinningCollection('x', 1000, 2, 900, 100);

    const b = new Storage(file);
    expect(await b.getPinningCollection('x')).toMatchObject({
      assets: 1000,
      page: 2,
      completed: 900,
      failed: 100,
    });
  });

  it('moves a collection from pinning to pinned', async () => {
    const s = new Storage(file);
    await s.pinningCollection('x', 10, 2);
    await s.pinnedCollection('x', 10, 3, 10, 0);
    expect(await s.getPinningCollection('x')).toBeUndefined();
    expect(await s.getPinnedCollection('x')).toMatchObject({
      page: 3,
      completed: 10,
    });
    expect(await s.isCollectionCompleted('x')).toBe(true);
  });

  it('accumulates page results and keeps failed assets', async () => {
    const s = new Storage(file);
    await s.pinningCollection('x', 0, 1);
    await s.updateCollectionProgress(
      'x',
      [{ assetId: '1' }, { assetId: '2' }],
      [{ assetId: '3', hash: 'Qm', error: 'boom' }]
    );
    expect(await s.getPinningCollection('x')).toMatchObject({
      completed: 2,
      failed: 1,
    });
    expect(await s.getFailedAssets('x')).toMatchObject([
      { assetId: '3', hash: 'Qm', error: 'boom', retryCount: 0 },
    ]);
    await s.clearFailedAssets('x');
    expect(await s.getFailedAssets('x')).toEqual([]);
  });

  it('records confirmed pins once', async () => {
    const s = new Storage(file);
    await s.recordConfirmedPinnedHash('Qm1', 'pinata');
    await s.recordConfirmedPinnedHash('Qm1', 'pinata');
    expect(await s.isHashConfirmedPinned('Qm1')).toBe(true);
    expect(await s.isHashConfirmedPinned('Qm2')).toBe(false);
    expect(await s.getConfirmedPinnedHashCount()).toBe(1);
    await s.clearConfirmedPinnedHashes();
    expect(await s.getConfirmedPinnedHashCount()).toBe(0);
  });

  it('tracks tokens and api failures', async () => {
    const s = new Storage(file);
    await s.markTokenPinned('solana:abc');
    await s.markTokenPinned('solana:abc');
    expect(await s.isTokenPinned('solana:abc')).toBe(true);
    await s.recordApiFailure('pinataPin');
    await s.recordApiFailure('hashVerification');
    expect(await s.getApiFailures()).toMatchObject({
      pinataPin: 1,
      hashVerification: 1,
      total: 2,
    });
    expect((await s.snapshot()).pinnedTokens).toEqual(['solana:abc']);
  });

  it('manages chunk state', async () => {
    const s = new Storage(file);
    await s.setCurrentChunk('c-01.json');
    await s.markChunkFailed('c-01.json');
    expect(await s.getAutoChunkProgress()).toMatchObject({
      currentChunk: null,
      failedChunks: ['c-01.json'],
    });
    await s.markChunkCompleted('c-01.json');
    expect(await s.getAutoChunkProgress()).toMatchObject({
      completedChunks: ['c-01.json'],
      failedChunks: [],
    });
    await s.clearAutoChunkProgress();
    expect(await s.getAutoChunkProgress()).toMatchObject({
      completedChunks: [],
      failedChunks: [],
      currentChunk: null,
    });
  });

  it('fills keys missing from files written by older versions', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        pinnedCollections: {
          old: {
            assets: 1,
            page: 2,
            completed: 1,
            failed: 0,
            lastUpdated: 'x',
          },
        },
      })
    );
    const s = new Storage(file);
    expect(await s.getPinnedCollection('old')).toMatchObject({ assets: 1 });
    expect(await s.getAutoChunkProgress()).toMatchObject({
      completedChunks: [],
    });
    await s.recordApiFailure('atomicAssets');
    expect((await s.getApiFailures()).total).toBe(1);
  });

  it('deletes the file on clearAllProgress', async () => {
    const s = new Storage(file);
    await s.pinningCollection('x', 1, 1);
    await s.clearAllProgress();
    expect(await s.getPinningCollection('x')).toBeUndefined();
    expect(
      JSON.parse(await fs.readFile(file, 'utf8')).pinningCollections
    ).toEqual({});
  });
});
