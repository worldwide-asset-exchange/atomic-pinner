import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TokenProcessor } from './tokens.js';
import type { PinService, PinOutcome } from './pinService.js';
import type { PinMetadata } from '../ipfs/provider.js';
import { HashTracker, RunStats } from './stats.js';
import { Storage } from './storage.js';
import { silentLogger } from '../logging/logger.js';
import { noopProgress } from '../logging/progress.js';

const META = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const IMG = 'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB';
const NESTED = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';

let dir: string;
let progress: Storage;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-tokens-'));
  progress = new Storage(path.join(dir, 'progress.json'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(
  outcome: PinOutcome | ((cid: string) => Promise<PinOutcome>) = 'pinned',
  dryRun = false
) {
  const process = vi.fn(
    async (cid: string, _meta: PinMetadata): Promise<PinOutcome> =>
      typeof outcome === 'function' ? outcome(cid) : outcome
  );
  const pins = { process } as unknown as PinService;
  const stats = new RunStats();
  const tracker = new HashTracker({ trackUnique: true, trackNotFound: true });
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ image: `ipfs://${NESTED}` }), {
        status: 200,
      })
  );
  const processor = new TokenProcessor(
    { dryRun },
    {
      pins,
      progress,
      stats,
      tracker,
      logger: silentLogger,
      reporter: noopProgress,
      fetch,
    }
  );
  return { processor, process, stats, tracker, fetch };
}

describe('TokenProcessor', () => {
  it('pins CIDs from inline metadata and marks the token done', async () => {
    const { processor, process, stats } = setup();
    await processor.processAll([
      {
        chain: 'solana',
        address: 'tokenaddr',
        metadata: { image: `ipfs://${IMG}` },
      },
    ]);
    expect(process).toHaveBeenCalledWith(IMG, {
      name: `token-inline-metadata-tokenadd-${IMG}`,
      keyvalues: {
        tokenAddress: 'tokenaddr',
        chain: 'solana',
        source: 'atomic-pinner-token-inline-metadata',
        cid: IMG,
      },
    });
    expect(stats.tokens).toMatchObject({ hashesFound: 1, pinned: 1 });
    expect(await progress.isTokenPinned('solana:tokenaddr')).toBe(true);
  });

  it('pins the metadata file and the CIDs inside it', async () => {
    const { processor, process, fetch } = setup();
    await processor.processOne({
      chain: 'eth',
      address: '0xabc',
      metadataUrl: `https://ipfs.io/ipfs/${META}`,
    });
    expect(fetch).toHaveBeenCalledWith(`https://ipfs.io/ipfs/${META}`);
    expect(process.mock.calls.map((c) => c[0])).toEqual([META, NESTED]);
    expect(process.mock.calls[1][1].name).toBe(`token-nested-0xabc-${NESTED}`);
  });

  it('skips tokens that are already done', async () => {
    await progress.markTokenPinned('solana:done');
    const { processor, process } = setup();
    await processor.processAll([
      {
        chain: 'solana',
        address: 'done',
        metadata: { image: `ipfs://${IMG}` },
      },
    ]);
    expect(process).not.toHaveBeenCalled();
  });

  it('does not mark a token done in a dry run', async () => {
    const { processor } = setup('would-pin', true);
    await processor.processAll([
      { chain: 'solana', address: 'x', metadata: { image: `ipfs://${IMG}` } },
    ]);
    expect(await progress.isTokenPinned('solana:x')).toBe(false);
  });

  it('counts failures and missing content without stopping', async () => {
    const { processor, stats, tracker } = setup(async (cid) => {
      if (cid === IMG) throw new Error('boom');
      return 'missing';
    });
    await processor.processOne({
      chain: 'solana',
      address: 'x',
      metadata: { image: `ipfs://${IMG}`, banner: `ipfs://${NESTED}` },
    });
    expect(stats.tokens).toMatchObject({
      hashesFound: 2,
      failed: 1,
      missing: 1,
    });
    expect(tracker.report().notFound).toEqual([
      { cid: NESTED, source: { kind: 'token', id: 'solana:x' } },
    ]);
  });
});
