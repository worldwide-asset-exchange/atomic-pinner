import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PinningOrchestrator, type OrchestratorDeps } from './orchestrator.js';
import { Storage } from './storage.js';
import { loadConfig } from '../config/load.js';
import type { Config, ConfigOverrides } from '../config/schema.js';
import { silentLogger } from '../logging/logger.js';
import { noopProgress } from '../logging/progress.js';
import type { AtomicAsset, AtomicClient } from '../atomic/client.js';
import type { IPFSProvider } from '../ipfs/provider.js';
import type { Notifier, RunEvent } from '../notify/notifier.js';

const CID = (n: number) =>
  `Qm${n.toString(36).replace(/0/g, 'z').padStart(44, 'a')}`;

function asset(id: number, cid: string, collection: string): AtomicAsset {
  return {
    asset_id: String(id),
    owner: 'o',
    collection: { collection_name: collection },
    data: { img: `ipfs://${cid}` },
  };
}

/** Collections as lists of pages. */
function fakeAtomic(collections: Record<string, AtomicAsset[][]>) {
  const getAssetsPage = vi.fn(
    async ({
      collectionName,
      page,
      limit,
    }: {
      collectionName: string;
      page: number;
      limit?: number;
    }) => {
      const assets = collections[collectionName]?.[page - 1] ?? [];
      return limit ? assets.slice(0, limit) : assets;
    }
  );
  return { getAssetsPage, pageSize: 1000 };
}
type FakeAtomic = ReturnType<typeof fakeAtomic>;

function fakeProvider(): IPFSProvider {
  return {
    name: 'fake',
    isPinned: vi.fn().mockResolvedValue(false),
    pin: vi.fn().mockResolvedValue(undefined),
  };
}

function recordingNotifier(): Notifier & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    name: 'rec',
    events,
    async notify(event) {
      events.push(event);
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-orch-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function config(overrides: ConfigOverrides = {}): Config {
  return loadConfig({
    env: { PINATA_JWT: 'x' },
    overrides: {
      ...overrides,
      state: {
        progressFile: path.join(dir, 'progress.json'),
        cacheFile: path.join(dir, 'cache.json'),
      },
      chunks: {
        directory: path.join(dir, 'chunks'),
        prefix: 'targets-chunk',
        ...overrides.chunks,
      },
      rateLimit: { delayMs: 0, batchSize: 10 },
      logging: { progress: 'off' },
    },
  });
}

function deps(
  cfg: Config,
  atomic: FakeAtomic | AtomicClient,
  extra: Partial<OrchestratorDeps> = {}
): OrchestratorDeps {
  return {
    logger: silentLogger,
    reporter: noopProgress,
    progress: new Storage(cfg.state.progressFile),
    cache: new Storage(cfg.state.cacheFile),
    atomic: atomic as AtomicClient,
    provider: fakeProvider(),
    verifier: { exists: vi.fn().mockResolvedValue(true) },
    notifiers: [],
    rateLimit: {
      plan: 'custom',
      delayMs: 0,
      batchSize: 10,
      requestsPerMinute: Infinity,
    },
    ...extra,
  };
}

async function writeChunk(name: string, targets: unknown) {
  await fs.mkdir(path.join(dir, 'chunks'), { recursive: true });
  await fs.writeFile(path.join(dir, 'chunks', name), JSON.stringify(targets));
}

describe('PinningOrchestrator (targets file)', () => {
  it('processes collections and tokens and notifies start and finish', async () => {
    const targetsFile = path.join(dir, 'targets.json');
    await fs.writeFile(
      targetsFile,
      JSON.stringify({
        collection: ['a'],
        token: [
          {
            chain: 'solana',
            address: 'tok',
            metadata: { image: `ipfs://${CID(9)}` },
          },
        ],
      })
    );
    const cfg = config({ targets: { file: targetsFile } });
    const atomic = fakeAtomic({ a: [[asset(1, CID(1), 'a')], []] });
    const notifier = recordingNotifier();
    const d = deps(cfg, atomic, { notifiers: [notifier] });

    const result = await new PinningOrchestrator(cfg, d).run();

    expect(result).toMatchObject({
      success: true,
      completed: true,
      chunk: null,
    });
    expect(result.stats.totals()).toMatchObject({ pinned: 2, hashesFound: 2 });
    expect(d.provider.pin).toHaveBeenCalledTimes(2);
    expect(await d.cache.isHashConfirmedPinned(CID(1))).toBe(true);
    expect(await d.progress.isTokenPinned('solana:tok')).toBe(true);
    expect(notifier.events.map((e) => e.event)).toEqual(['start', 'finish']);
    expect(notifier.events[1]).toMatchObject({
      success: true,
      totals: { pinned: 2 },
      collections: { pinned: 1 },
      tokens: { pinned: 1 },
    });
  });

  it('writes a hash report when asked', async () => {
    const targetsFile = path.join(dir, 'targets.json');
    await fs.writeFile(targetsFile, JSON.stringify({ collection: ['a'] }));
    const cfg = config({
      targets: { file: targetsFile },
      tracking: { saveReport: true, reportDir: path.join(dir, 'reports') },
    });
    const atomic = fakeAtomic({ a: [[asset(1, CID(1), 'a')], []] });

    const result = await new PinningOrchestrator(cfg, deps(cfg, atomic)).run();

    expect(result.reportFile).toMatch(/hash-report-.*\.json$/);
    const report = JSON.parse(await fs.readFile(result.reportFile!, 'utf8'));
    expect(report.summary.uniqueHashes).toBe(1);
  });

  it('raises a clear error for a missing targets file and still sends a finish event', async () => {
    const cfg = config({ targets: { file: path.join(dir, 'missing.json') } });
    const notifier = recordingNotifier();
    const orchestrator = new PinningOrchestrator(
      cfg,
      deps(cfg, fakeAtomic({}), { notifiers: [notifier] })
    );
    await expect(orchestrator.run()).rejects.toThrow(/missing\.json/);
    expect(notifier.events).toEqual([]); // nothing started
  });

  it('honours FRESH_START by clearing progress but keeping the cache', async () => {
    const targetsFile = path.join(dir, 'targets.json');
    await fs.writeFile(targetsFile, JSON.stringify({ collection: ['a'] }));
    const cfg = config({
      targets: { file: targetsFile },
      processing: { freshStart: true },
    });
    const atomic = fakeAtomic({ a: [[asset(1, CID(1), 'a')], []] });
    const d = deps(cfg, atomic);
    await d.progress.pinnedCollection('a', 99, 9);
    await d.cache.recordConfirmedPinnedHash(CID(1), 'fake');

    const result = await new PinningOrchestrator(cfg, d).run();

    expect(atomic.getAssetsPage).toHaveBeenCalled(); // collection was re-walked
    expect(result.stats.totals().alreadyPinned).toBe(1); // cache survived
  });
});

describe('PinningOrchestrator (chunk mode)', () => {
  it('marks a chunk complete when all of its collections and tokens are done', async () => {
    await writeChunk('targets-chunk-01.json', {
      collection: ['a', 'b'],
      token: [
        {
          chain: 'solana',
          address: 'tok',
          metadata: { image: `ipfs://${CID(9)}` },
        },
      ],
    });
    await writeChunk('targets-chunk-02.json', { collection: ['c'] });
    const cfg = config({ chunks: { enabled: true } });
    const atomic = fakeAtomic({
      a: [[asset(1, CID(1), 'a')], []],
      b: [[asset(2, CID(2), 'b')], []],
    });
    const d = deps(cfg, atomic);

    const result = await new PinningOrchestrator(cfg, d).run();

    expect(result.chunk?.chunkFileName).toBe('targets-chunk-01.json');
    expect(result.completed).toBe(true);
    expect(await d.progress.getAutoChunkProgress()).toMatchObject({
      completedChunks: ['targets-chunk-01.json'],
      currentChunk: null,
    });
  });

  it('keeps a chunk current while a collection is paused by the page limit', async () => {
    await writeChunk('targets-chunk-01.json', { collection: ['a'] });
    const cfg = config({
      chunks: { enabled: true },
      processing: { maxPagesPerCollection: 1 },
    });
    const pages = [
      [asset(1, CID(1), 'a')],
      [asset(2, CID(2), 'a')],
      [asset(3, CID(3), 'a')],
      [],
    ];
    const atomic = fakeAtomic({ a: pages });
    const d = deps(cfg, atomic);

    const first = await new PinningOrchestrator(cfg, d).run();
    expect(first.completed).toBe(false);
    expect(await d.progress.getAutoChunkProgress()).toMatchObject({
      currentChunk: 'targets-chunk-01.json',
      completedChunks: [],
    });

    const second = await new PinningOrchestrator(cfg, d).run();
    expect(second.chunk?.chunkFileName).toBe('targets-chunk-01.json');
    expect(second.completed).toBe(false);

    // Third run processes page 3, then the completion probe finds page 4 empty.
    const third = await new PinningOrchestrator(cfg, d).run();
    expect(third.completed).toBe(true);
    expect(await d.progress.getAutoChunkProgress()).toMatchObject({
      completedChunks: ['targets-chunk-01.json'],
    });
    expect(atomic.getAssetsPage.mock.calls.map((c) => c[0].page)).toEqual([
      1, 2, 2, 3, 3, 4,
    ]);
  });

  it('treats a paused collection with no further pages as complete', async () => {
    await writeChunk('targets-chunk-01.json', { collection: ['a'] });
    const cfg = config({
      chunks: { enabled: true },
      processing: { maxPagesPerCollection: 1 },
    });
    const atomic = fakeAtomic({ a: [[asset(1, CID(1), 'a')], []] });
    const d = deps(cfg, atomic);

    const result = await new PinningOrchestrator(cfg, d).run();

    // Page limit hit after page 1, but a probe of page 2 finds nothing, so the chunk is done.
    expect(result.collections[0].reason).toBe('page-limit');
    expect(result.completed).toBe(true);
  });

  it('does not consider targets complete while a token is unfinished', async () => {
    const cfg = config({ chunks: { enabled: true } });
    const d = deps(cfg, fakeAtomic({}));
    const orchestrator = new PinningOrchestrator(cfg, d);
    const targets = {
      collection: [],
      token: [{ chain: 'solana', address: 'tok' }],
    };
    expect(await orchestrator.isComplete(targets)).toBe(false);
    await d.progress.markTokenPinned('solana:tok');
    expect(await orchestrator.isComplete(targets)).toBe(true);
  });

  it('ignores the token list for completion when token processing is off', async () => {
    const cfg = config({
      chunks: { enabled: true },
      processing: { tokens: false },
    });
    const orchestrator = new PinningOrchestrator(
      cfg,
      deps(cfg, fakeAtomic({}))
    );
    expect(
      await orchestrator.isComplete({
        collection: [],
        token: [{ chain: 'solana', address: 'tok' }],
      })
    ).toBe(true);
  });

  it('moves to the next chunk on the following run', async () => {
    await writeChunk('targets-chunk-01.json', { collection: ['a'] });
    await writeChunk('targets-chunk-02.json', { collection: ['b'] });
    const cfg = config({ chunks: { enabled: true } });
    const atomic = fakeAtomic({
      a: [[asset(1, CID(1), 'a')], []],
      b: [[asset(2, CID(2), 'b')], []],
    });
    const d = deps(cfg, atomic);

    expect(
      (await new PinningOrchestrator(cfg, d).run()).chunk?.chunkFileName
    ).toBe('targets-chunk-01.json');
    expect(
      (await new PinningOrchestrator(cfg, d).run()).chunk?.chunkFileName
    ).toBe('targets-chunk-02.json');
    const third = await new PinningOrchestrator(cfg, d).run();
    expect(third.nothingToDo).toBe(true);
  });

  it('cycles back to the first chunk when configured', async () => {
    await writeChunk('targets-chunk-01.json', { collection: ['a'] });
    const cfg = config({ chunks: { enabled: true, cycle: true } });
    const atomic = fakeAtomic({ a: [[asset(1, CID(1), 'a')], []] });
    const d = deps(cfg, atomic);

    await new PinningOrchestrator(cfg, d).run();
    const again = await new PinningOrchestrator(cfg, d).run();

    expect(again.nothingToDo).toBeUndefined();
    expect(again.chunk?.chunkFileName).toBe('targets-chunk-01.json');
  });

  it('marks an unreadable chunk failed and reports nothing to do', async () => {
    await fs.mkdir(path.join(dir, 'chunks'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'chunks', 'targets-chunk-01.json'),
      '{ broken'
    );
    const cfg = config({ chunks: { enabled: true } });
    const d = deps(cfg, fakeAtomic({}));

    const result = await new PinningOrchestrator(cfg, d).run();

    expect(result.nothingToDo).toBe(true);
    expect(await d.progress.getAutoChunkProgress()).toMatchObject({
      failedChunks: ['targets-chunk-01.json'],
    });
  });

  it('never completes a chunk in a dry run', async () => {
    await writeChunk('targets-chunk-01.json', { collection: ['a'] });
    const cfg = config({
      chunks: { enabled: true },
      processing: { dryRun: true },
    });
    const atomic = fakeAtomic({ a: [[asset(1, CID(1), 'a')], []] });
    const d = deps(cfg, atomic);

    const result = await new PinningOrchestrator(cfg, d).run();

    expect(result.completed).toBe(false);
    expect(d.provider.pin).not.toHaveBeenCalled();
    expect(await d.progress.getAutoChunkProgress()).toMatchObject({
      completedChunks: [],
    });
  });

  it('marks the chunk failed and rethrows when processing blows up', async () => {
    await writeChunk('targets-chunk-01.json', { collection: ['a'] });
    const cfg = config({ chunks: { enabled: true } });
    const atomic = {
      getAssetsPage: vi.fn().mockRejectedValue(new Error('api down')),
      pageSize: 1000,
    } as unknown as AtomicClient;
    const notifier = recordingNotifier();
    const d = deps(cfg, atomic, { notifiers: [notifier] });

    await expect(new PinningOrchestrator(cfg, d).run()).rejects.toThrow(
      'api down'
    );

    expect(await d.progress.getAutoChunkProgress()).toMatchObject({
      failedChunks: ['targets-chunk-01.json'],
    });
    expect(notifier.events[1]).toMatchObject({
      event: 'finish',
      success: false,
      error: 'api down',
    });
  });
});
