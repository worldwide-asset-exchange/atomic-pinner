import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunStats, HashTracker, writeHashReport } from './stats.js';

describe('RunStats', () => {
  it('maps outcomes onto counters per phase and totals them', () => {
    const stats = new RunStats();
    stats.recordOutcome('collections', 'pinned');
    stats.recordOutcome('collections', 'would-pin');
    stats.recordOutcome('collections', 'cached');
    stats.recordOutcome('tokens', 'already-pinned');
    stats.recordOutcome('tokens', 'missing');
    stats.tokens.failed += 1;
    expect(stats.collections).toMatchObject({
      pinned: 2,
      alreadyPinned: 1,
      missing: 0,
      failed: 0,
    });
    expect(stats.tokens).toMatchObject({
      pinned: 0,
      alreadyPinned: 1,
      missing: 1,
      failed: 1,
    });
    expect(stats.totals()).toMatchObject({
      pinned: 2,
      alreadyPinned: 2,
      missing: 1,
      failed: 1,
    });
    expect(stats.runtimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('HashTracker', () => {
  it('aggregates sources per CID and summarises', () => {
    const t = new HashTracker({ trackUnique: true, trackNotFound: true });
    t.seen('Qm1', { kind: 'collection', id: 'a', assetId: '1' });
    t.seen('Qm1', { kind: 'collection', id: 'a', assetId: '2' });
    t.seen('Qm1', { kind: 'token', id: 'solana:x' });
    t.seen('Qm2', { kind: 'collection', id: 'b', assetId: '3' });
    t.markNotFound({
      cid: 'Qm2',
      source: { kind: 'collection', id: 'b', assetId: '3' },
    });

    const report = t.report();
    expect(report.hashes).toEqual({
      Qm1: { collections: ['a'], tokens: ['solana:x'], assets: ['1', '2'] },
      Qm2: { collections: ['b'], tokens: [], assets: ['3'] },
    });
    expect(report.summary).toEqual({
      uniqueHashes: 2,
      inCollections: 2,
      inTokens: 1,
      notFound: 1,
      notFoundPercent: 50,
    });
    expect(t.uniqueCount).toBe(2);
    expect(t.notFoundCount).toBe(1);
  });

  it('records nothing when disabled', () => {
    const t = new HashTracker({ trackUnique: false, trackNotFound: false });
    t.seen('Qm1', { kind: 'collection', id: 'a' });
    t.markNotFound({ cid: 'Qm1', source: { kind: 'collection', id: 'a' } });
    expect(t.report()).toMatchObject({
      hashes: {},
      notFound: [],
      summary: { uniqueHashes: 0, notFound: 0, notFoundPercent: 0 },
    });
  });
});

describe('writeHashReport', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-report-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a timestamped JSON file, creating the directory', async () => {
    const report = new HashTracker({
      trackUnique: true,
      trackNotFound: true,
    }).report();
    const file = await writeHashReport(
      path.join(dir, 'nested', 'reports'),
      report
    );
    expect(path.basename(file)).toMatch(
      /^hash-report-\d{4}-\d{2}-\d{2}T.*\.json$/
    );
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(report);
  });
});
