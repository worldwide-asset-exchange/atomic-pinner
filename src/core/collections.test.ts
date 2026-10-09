import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CollectionProcessor,
  type CollectionProcessorOptions,
} from './collections.js';
import type { PinService, PinOutcome } from './pinService.js';
import { HashTracker, RunStats } from './stats.js';
import { Storage } from './storage.js';
import { silentLogger } from '../logging/logger.js';
import { noopProgress } from '../logging/progress.js';
import type { AtomicAsset } from '../atomic/client.js';

const CID = (n: number) =>
  `Qm${n.toString(36).replace(/0/g, 'z').padStart(44, 'a')}`;

function asset(id: number, cids: string[], collection = 'col'): AtomicAsset {
  return {
    asset_id: String(id),
    owner: 'owner',
    name: `asset ${id}`,
    collection: { collection_name: collection },
    schema: { schema_name: 'art' },
    template: { template_id: '7' },
    data: {
      img: cids[0] ? `ipfs://${cids[0]}` : undefined,
      extra: cids.slice(1).map((c) => `https://ipfs.io/ipfs/${c}`),
    },
  };
}

/** pages[n] is the page returned for page number n+1. */
function fakeAtomic(pages: AtomicAsset[][], pageSize = 1000) {
  const getAssetsPage = vi.fn(
    async ({
      page,
      limit,
    }: {
      collectionName: string;
      page: number;
      limit?: number;
    }) => {
      const assets = pages[page - 1] ?? [];
      return limit ? assets.slice(0, limit) : assets;
    }
  );
  return { getAssetsPage, pageSize };
}

function fakePins(
  outcome: PinOutcome | ((cid: string) => Promise<PinOutcome>) = 'pinned'
) {
  const process = vi.fn(
    typeof outcome === 'function' ? outcome : async () => outcome
  );
  return { process, providerName: 'fake' } as unknown as PinService;
}

let dir: string;
let progress: Storage;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-collections-'));
  progress = new Storage(path.join(dir, 'progress.json'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const defaults: CollectionProcessorOptions = {
  dryRun: false,
  dryRunLimit: 25,
  maxPagesPerCollection: -1,
  batchSize: 10,
  delayMs: 0,
};

function processor(
  atomic: ReturnType<typeof fakeAtomic>,
  pins: PinService,
  options: Partial<CollectionProcessorOptions> = {},
  extras: { stats?: RunStats; tracker?: HashTracker } = {}
) {
  const stats = extras.stats ?? new RunStats();
  const tracker =
    extras.tracker ??
    new HashTracker({ trackUnique: true, trackNotFound: true });
  return {
    stats,
    tracker,
    run: new CollectionProcessor(
      { ...defaults, ...options },
      {
        atomic,
        pins,
        progress,
        stats,
        tracker,
        logger: silentLogger,
        reporter: noopProgress,
      }
    ),
  };
}

describe('CollectionProcessor', () => {
  it('dedupes CIDs within a page and pins each once', async () => {
    const atomic = fakeAtomic([
      [asset(1, [CID(1), CID(2)]), asset(2, [CID(1)]), asset(3, [])],
      [],
    ]);
    const pins = fakePins();
    const { run, stats } = processor(atomic, pins);

    const [result] = await run.processAll(['col']);

    expect(result.reason).toBe('completed');
    expect(pins.process).toHaveBeenCalledTimes(2);
    expect(stats.collections).toMatchObject({
      hashesFound: 3,
      uniqueHashes: 2,
      duplicatesAvoided: 1,
      pinned: 2,
    });
    expect(await progress.getPinnedCollection('col')).toMatchObject({
      assets: 3,
      page: 2,
      completed: 3,
      failed: 0,
    });
    expect(await progress.getPinningCollection('col')).toBeUndefined();
  });

  it('passes collection metadata to the pin service', async () => {
    const atomic = fakeAtomic([[asset(1, [CID(1)]), asset(2, [CID(1)])], []]);
    const pins = fakePins();
    await processor(atomic, pins).run.processOne('col');
    expect(pins.process).toHaveBeenCalledWith(CID(1), {
      name: `col-${CID(1)}`,
      keyvalues: {
        collection: 'col',
        assetCount: 2,
        source: 'atomic-pinner',
        cid: CID(1),
      },
    });
  });

  it('skips a collection that is already complete', async () => {
    await progress.pinnedCollection('col', 5, 2);
    const atomic = fakeAtomic([[asset(1, [CID(1)])]]);
    const pins = fakePins();
    const [result] = await processor(atomic, pins).run.processAll(['col']);
    expect(result.reason).toBe('already-completed');
    expect(atomic.getAssetsPage).not.toHaveBeenCalled();
  });

  it('resumes from the stored page', async () => {
    await progress.pinningCollection('col', 2000, 3, 2000, 0);
    const atomic = fakeAtomic([
      [asset(1, [CID(1)])],
      [asset(2, [CID(2)])],
      [asset(3, [CID(3)])],
      [],
    ]);
    const pins = fakePins();
    const [result] = await processor(atomic, pins).run.processAll(['col']);

    expect(atomic.getAssetsPage.mock.calls.map((c) => c[0].page)).toEqual([
      3, 4,
    ]);
    expect(result).toMatchObject({
      reason: 'completed',
      pagesThisRun: 1,
      assetsThisRun: 1,
    });
    expect(await progress.getPinnedCollection('col')).toMatchObject({
      assets: 2001,
      page: 4,
    });
  });

  it('stops at the page limit and leaves the collection resumable', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => [
      asset(i + 1, [CID(i + 1)]),
    ]);
    const atomic = fakeAtomic([...pages, []]);
    const pins = fakePins();
    const { run } = processor(atomic, pins, { maxPagesPerCollection: 2 });

    const first = await run.processOne('col');
    expect(first).toMatchObject({ reason: 'page-limit', pagesThisRun: 2 });
    expect(await progress.getPinningCollection('col')).toMatchObject({
      page: 3,
      assets: 2,
    });
    expect(await progress.getPinnedCollection('col')).toBeUndefined();

    const second = await run.processOne('col');
    expect(second).toMatchObject({ reason: 'page-limit', pagesThisRun: 2 });
    expect(await progress.getPinningCollection('col')).toMatchObject({
      page: 5,
    });

    const third = await run.processOne('col');
    expect(third).toMatchObject({ reason: 'completed', pagesThisRun: 1 });
    expect(await progress.getPinnedCollection('col')).toMatchObject({
      assets: 5,
      page: 6,
    });
    expect(atomic.getAssetsPage.mock.calls.map((c) => c[0].page)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('dry run inspects a limited first page and writes no progress', async () => {
    const atomic = fakeAtomic([
      Array.from({ length: 30 }, (_, i) => asset(i + 1, [CID(i + 1)])),
      [],
    ]);
    const pins = fakePins('would-pin');
    const { run, stats } = processor(atomic, pins, {
      dryRun: true,
      dryRunLimit: 5,
    });

    const [result] = await run.processAll(['col']);

    expect(atomic.getAssetsPage).toHaveBeenCalledWith({
      collectionName: 'col',
      page: 1,
      limit: 5,
    });
    expect(result).toMatchObject({ reason: 'dry-run', assetsThisRun: 5 });
    expect(stats.collections.pinned).toBe(5);
    expect(await progress.getPinningCollection('col')).toBeUndefined();
    expect(await progress.getPinnedCollection('col')).toBeUndefined();
  });

  it('records a failed pin against every asset using the CID and carries on', async () => {
    const atomic = fakeAtomic([
      [asset(1, [CID(1)]), asset(2, [CID(1)]), asset(3, [CID(2)])],
      [],
    ]);
    const pins = fakePins(async (cid) => {
      if (cid === CID(1)) throw new Error('pinata down');
      return 'pinned';
    });
    const { run, stats } = processor(atomic, pins);

    const [result] = await run.processAll(['col']);

    expect(result.reason).toBe('completed');
    expect(stats.collections).toMatchObject({ pinned: 1, failed: 1 });
    expect(await progress.getFailedAssets('col')).toMatchObject([
      { assetId: '1', hash: CID(1), error: 'pinata down' },
      { assetId: '2', hash: CID(1), error: 'pinata down' },
    ]);
    expect(await progress.getPinnedCollection('col')).toMatchObject({
      completed: 1,
      failed: 2,
    });
  });

  it('tracks missing CIDs with asset details', async () => {
    const atomic = fakeAtomic([[asset(1, [CID(1)])], []]);
    const { run, tracker, stats } = processor(atomic, fakePins('missing'));
    await run.processOne('col');
    expect(stats.collections.missing).toBe(1);
    const report = tracker.report();
    expect(report.notFound).toEqual([
      {
        cid: CID(1),
        source: { kind: 'collection', id: 'col', assetId: '1' },
        schemaName: 'art',
        templateId: '7',
        assetName: 'asset 1',
      },
    ]);
    expect(report.hashes[CID(1)]).toEqual({
      collections: ['col'],
      tokens: [],
      assets: ['1'],
    });
  });

  it('pauses between batches', async () => {
    const atomic = fakeAtomic([[asset(1, [CID(1), CID(2), CID(3)])], []]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = new CollectionProcessor(
      { ...defaults, batchSize: 2, delayMs: 100 },
      {
        atomic,
        pins: fakePins(),
        progress,
        stats: new RunStats(),
        tracker: new HashTracker({ trackUnique: false, trackNotFound: false }),
        logger: silentLogger,
        reporter: noopProgress,
        sleep,
      }
    );
    await run.processOne('col');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(200);
  });
});
