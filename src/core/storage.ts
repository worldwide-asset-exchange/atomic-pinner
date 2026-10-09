import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as fs from 'node:fs';
import type { ApiFailureKind } from '../ipfs/provider.js';
import { silentLogger, type Logger } from '../logging/logger.js';

export interface CollectionProgress {
  assets: number;
  page: number;
  completed: number;
  failed: number;
  lastUpdated: string;
}

export interface FailedAsset {
  assetId?: string;
  hash?: string;
  tokenAddress?: string;
  error: string;
  retryCount: number;
  lastAttempt: string;
}

export interface AutoChunkProgress {
  completedChunks: string[];
  failedChunks: string[];
  currentChunk: string | null;
  lastUpdated: string;
}

export interface ApiFailures extends Record<ApiFailureKind, number> {
  total: number;
}

/**
 * On-disk shape. Kept byte-compatible with the files written by earlier versions so an
 * existing progress.json or confirmed-pinned-hashes.json keeps working.
 */
export interface StorageData {
  pinnedCollections: Record<string, CollectionProgress>;
  pinningCollections: Record<string, CollectionProgress>;
  failedAssets: Record<string, FailedAsset[]>;
  pinnedTokens: string[];
  confirmedPinnedHashes: {
    hashes: Record<string, { pinnedAt: string; provider: string }>;
    totalCount: number;
  };
  apiFailures: ApiFailures;
  autoChunkProgress: AutoChunkProgress;
}

const now = () => new Date().toISOString();

export function emptyState(): StorageData {
  return {
    pinnedCollections: {},
    pinningCollections: {},
    failedAssets: {},
    pinnedTokens: [],
    confirmedPinnedHashes: { hashes: {}, totalCount: 0 },
    apiFailures: {
      atomicAssets: 0,
      pinataList: 0,
      pinataPin: 0,
      hashVerification: 0,
      total: 0,
    },
    autoChunkProgress: {
      completedChunks: [],
      failedChunks: [],
      currentChunk: null,
      lastUpdated: now(),
    },
  };
}

/**
 * JSON-file state store (lowdb). Two instances are used: one for run progress, one for the
 * long-lived confirmed-pinned cache. Every method re-reads the file first so sequential runs
 * sharing a volume stay consistent, and writes are atomic.
 */
export class Storage {
  readonly db: Low<StorageData>;

  constructor(
    readonly file: string,
    private readonly logger: Logger = silentLogger
  ) {
    this.db = new Low<StorageData>(
      new JSONFile<StorageData>(file),
      emptyState()
    );
  }

  private async read(): Promise<StorageData> {
    await this.db.read();
    // Fill keys missing from files written by older versions.
    const defaults = emptyState();
    for (const key of Object.keys(defaults) as (keyof StorageData)[]) {
      if (this.db.data[key] === undefined) {
        (this.db.data as unknown as Record<string, unknown>)[key] =
          defaults[key];
      }
    }
    return this.db.data;
  }

  private async write(): Promise<void> {
    await this.db.write();
  }

  // ----- collections -----

  async pinningCollection(
    name: string,
    assets: number,
    page: number,
    completed = 0,
    failed = 0
  ): Promise<void> {
    const data = await this.read();
    data.pinningCollections[name] = {
      assets,
      page,
      completed,
      failed,
      lastUpdated: now(),
    };
    await this.write();
  }

  async pinnedCollection(
    name: string,
    assets: number,
    page: number,
    completed = assets,
    failed = 0
  ): Promise<void> {
    const data = await this.read();
    delete data.pinningCollections[name];
    data.pinnedCollections[name] = {
      assets,
      page,
      completed,
      failed,
      lastUpdated: now(),
    };
    await this.write();
  }

  async updateCollectionProgress(
    name: string,
    completed: Array<{ assetId: string }>,
    failed: Array<{ assetId: string; hash?: string; error: string }>
  ): Promise<void> {
    const data = await this.read();
    const progress = data.pinningCollections[name];
    if (progress) {
      progress.completed += completed.length;
      progress.failed += failed.length;
      progress.lastUpdated = now();
    }
    if (failed.length > 0) {
      data.failedAssets[name] ??= [];
      for (const f of failed) {
        data.failedAssets[name].push({
          assetId: f.assetId,
          hash: f.hash,
          error: f.error,
          retryCount: 0,
          lastAttempt: now(),
        });
      }
    }
    await this.write();
  }

  async getPinningCollection(
    name: string
  ): Promise<CollectionProgress | undefined> {
    return (await this.read()).pinningCollections[name];
  }

  async getPinnedCollection(
    name: string
  ): Promise<CollectionProgress | undefined> {
    return (await this.read()).pinnedCollections[name];
  }

  async isCollectionCompleted(name: string): Promise<boolean> {
    return Boolean((await this.read()).pinnedCollections[name]);
  }

  async getFailedAssets(name: string): Promise<FailedAsset[]> {
    return (await this.read()).failedAssets[name] ?? [];
  }

  async clearFailedAssets(name: string): Promise<void> {
    const data = await this.read();
    delete data.failedAssets[name];
    await this.write();
  }

  // ----- tokens -----

  async isTokenPinned(tokenId: string): Promise<boolean> {
    return (await this.read()).pinnedTokens.includes(tokenId);
  }

  async markTokenPinned(tokenId: string): Promise<void> {
    const data = await this.read();
    if (!data.pinnedTokens.includes(tokenId)) data.pinnedTokens.push(tokenId);
    await this.write();
  }

  // ----- confirmed pinned cache -----

  async recordConfirmedPinnedHash(
    hash: string,
    provider: string
  ): Promise<void> {
    const data = await this.read();
    if (!data.confirmedPinnedHashes.hashes[hash]) {
      data.confirmedPinnedHashes.hashes[hash] = { pinnedAt: now(), provider };
      data.confirmedPinnedHashes.totalCount += 1;
      await this.write();
    }
  }

  async isHashConfirmedPinned(hash: string): Promise<boolean> {
    return Boolean((await this.read()).confirmedPinnedHashes.hashes[hash]);
  }

  async getConfirmedPinnedHashCount(): Promise<number> {
    return (await this.read()).confirmedPinnedHashes.totalCount;
  }

  async clearConfirmedPinnedHashes(): Promise<void> {
    const data = await this.read();
    data.confirmedPinnedHashes = { hashes: {}, totalCount: 0 };
    await this.write();
  }

  // ----- api failures -----

  async recordApiFailure(kind: ApiFailureKind): Promise<void> {
    const data = await this.read();
    data.apiFailures[kind] += 1;
    data.apiFailures.total += 1;
    await this.write();
  }

  async getApiFailures(): Promise<ApiFailures> {
    return (await this.read()).apiFailures;
  }

  // ----- auto-chunk progress -----

  async getAutoChunkProgress(): Promise<AutoChunkProgress> {
    return (await this.read()).autoChunkProgress;
  }

  async setCurrentChunk(chunkFile: string | null): Promise<void> {
    const data = await this.read();
    data.autoChunkProgress.currentChunk = chunkFile;
    data.autoChunkProgress.lastUpdated = now();
    await this.write();
  }

  async markChunkCompleted(chunkFile: string): Promise<void> {
    const data = await this.read();
    const p = data.autoChunkProgress;
    p.failedChunks = p.failedChunks.filter((c) => c !== chunkFile);
    if (!p.completedChunks.includes(chunkFile))
      p.completedChunks.push(chunkFile);
    p.currentChunk = null;
    p.lastUpdated = now();
    await this.write();
    this.logger.debug('Chunk marked completed', {
      chunkFile,
      completed: p.completedChunks.length,
    });
  }

  async markChunkFailed(chunkFile: string): Promise<void> {
    const data = await this.read();
    const p = data.autoChunkProgress;
    if (!p.failedChunks.includes(chunkFile)) p.failedChunks.push(chunkFile);
    p.currentChunk = null;
    p.lastUpdated = now();
    await this.write();
  }

  async clearAutoChunkProgress(): Promise<void> {
    const data = await this.read();
    data.autoChunkProgress = {
      completedChunks: [],
      failedChunks: [],
      currentChunk: null,
      lastUpdated: now(),
    };
    await this.write();
  }

  // ----- whole-file -----

  /** Delete the file and reset to an empty state. Used by FRESH_START on the progress store only. */
  async clearAllProgress(): Promise<void> {
    if (fs.existsSync(this.file)) {
      fs.unlinkSync(this.file);
      this.logger.info('Deleted state file', { file: this.file });
    }
    this.db.data = emptyState();
    await this.write();
  }

  /** Read-only copy for summaries and notifications. */
  async snapshot(): Promise<StorageData> {
    return structuredClone(await this.read());
  }
}
