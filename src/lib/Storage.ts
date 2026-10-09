import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as fs from 'fs';
import { resolve } from 'path';

type StorageData = {
  pinnedCollections: Record<
    string,
    {
      assets: number;
      page: number;
      completed: number;
      failed: number;
      lastUpdated: string;
    }
  >;
  pinningCollections: Record<
    string,
    {
      assets: number;
      page: number;
      completed: number;
      failed: number;
      lastUpdated: string;
    }
  >;
  failedAssets: Record<
    string,
    Array<{
      assetId?: string;
      hash?: string;
      tokenAddress?: string;
      error: string;
      retryCount: number;
      lastAttempt: string;
    }>
  >;
  pinnedTokens: string[];
  // Persistent tracking of confirmed pinned hashes
  confirmedPinnedHashes: {
    hashes: Record<
      string,
      {
        pinnedAt: string; // ISO timestamp when confirmed
        provider: string; // pinata, local, etc.
      }
    >;
    totalCount: number;
  };
  apiFailures: {
    atomicAssets: number;
    pinataList: number;
    pinataPin: number;
    hashVerification: number;
    total: number;
  };
  // Auto-chunk progression tracking
  autoChunkProgress: {
    completedChunks: string[]; // Array of completed chunk filenames
    failedChunks: string[]; // Array of failed chunk filenames (to retry later)
    currentChunk: string | null; // Currently processing chunk filename
    lastUpdated: string;
  };
};

export class Storage {
  db: Low<StorageData>;
  private dbFile: string;

  constructor(dbFile: string) {
    this.dbFile = dbFile;

    // Debug logging for progress file persistence
    const fileExists = fs.existsSync(dbFile);
    console.log(`📁 PROGRESS FILE DEBUG: ${dbFile}`);
    console.log(`   • File exists: ${fileExists ? '✅' : '❌'}`);
    console.log(`   • Working directory: ${process.cwd()}`);
    console.log(`   • Full path: ${resolve(dbFile)}`);

    this.db = new Low<StorageData>(new JSONFile(dbFile), {
      pinnedCollections: {},
      pinningCollections: {},
      failedAssets: {},
      pinnedTokens: [],
      confirmedPinnedHashes: {
        hashes: {},
        totalCount: 0,
      },
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
        lastUpdated: new Date().toISOString(),
      },
    });
  }

  async pinnedCollection(
    collectionName: string,
    assets: number,
    page: number,
    completed: number = assets,
    failed: number = 0
  ) {
    await this.db.read();
    delete this.db.data.pinningCollections[collectionName];
    this.db.data.pinnedCollections[collectionName] = {
      assets,
      page,
      completed,
      failed,
      lastUpdated: new Date().toISOString(),
    };

    await this.db.write();
  }

  async pinningCollection(
    collectionName: string,
    assets: number,
    page: number,
    completed: number = 0,
    failed: number = 0
  ) {
    await this.db.read();
    this.db.data.pinningCollections[collectionName] = {
      assets,
      page,
      completed,
      failed,
      lastUpdated: new Date().toISOString(),
    };
    await this.db.write();
  }

  async updateCollectionProgress(
    collectionName: string,
    completedAssets: any[],
    failedAssets: any[]
  ) {
    await this.db.read();

    if (this.db.data.pinningCollections[collectionName]) {
      this.db.data.pinningCollections[collectionName].completed +=
        completedAssets.length;
      this.db.data.pinningCollections[collectionName].failed +=
        failedAssets.length;
      this.db.data.pinningCollections[collectionName].lastUpdated =
        new Date().toISOString();
    }

    // Store failed assets for potential retry
    if (failedAssets.length > 0) {
      if (!this.db.data.failedAssets[collectionName]) {
        this.db.data.failedAssets[collectionName] = [];
      }

      for (const failed of failedAssets) {
        this.db.data.failedAssets[collectionName].push({
          assetId: failed.attribute?.asset_id || 'unknown',
          error: failed.error,
          retryCount: 0,
          lastAttempt: new Date().toISOString(),
        });
      }
    }

    await this.db.write();
  }

  async getFailedAssets(collectionName: string) {
    await this.db.read();
    return this.db.data.failedAssets[collectionName] || [];
  }

  async clearFailedAssets(collectionName: string) {
    await this.db.read();
    delete this.db.data.failedAssets[collectionName];
    await this.db.write();
  }

  async getPinningCollection(collectionName: string) {
    await this.db.read();
    return this.db.data.pinningCollections[collectionName];
  }

  async getPinnedCollection(collectionName: string) {
    await this.db.read();
    return this.db.data.pinnedCollections[collectionName];
  }

  async clearAllProgress() {
    console.log(`🗑️  Clearing all progress data due to FRESH_START=1`);

    // Delete the progress file if it exists
    if (fs.existsSync(this.dbFile)) {
      fs.unlinkSync(this.dbFile);
      console.log(`📁 Deleted progress file: ${this.dbFile}`);
    }

    // Reset the database to default state
    this.db.data = {
      pinnedCollections: {},
      pinningCollections: {},
      failedAssets: {},
      pinnedTokens: [],
      confirmedPinnedHashes: {
        hashes: {},
        totalCount: 0,
      },
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
        lastUpdated: new Date().toISOString(),
      },
    };

    await this.db.write();
    console.log(`✅ Progress state reset to fresh start`);
  }

  async recordApiFailure(
    apiType: 'atomicAssets' | 'pinataList' | 'pinataPin' | 'hashVerification'
  ) {
    await this.db.read();
    this.db.data.apiFailures[apiType]++;
    this.db.data.apiFailures.total++;
    await this.db.write();
  }

  async getApiFailures() {
    await this.db.read();
    return this.db.data.apiFailures;
  }

  // Confirmed pinned hashes methods
  async recordConfirmedPinnedHash(hash: string, provider: string) {
    await this.db.read();

    // Initialize confirmedPinnedHashes if it doesn't exist (for migration)
    if (!this.db.data.confirmedPinnedHashes) {
      this.db.data.confirmedPinnedHashes = {
        hashes: {},
        totalCount: 0,
      };
    }

    // Only add if not already recorded
    if (!this.db.data.confirmedPinnedHashes.hashes[hash]) {
      this.db.data.confirmedPinnedHashes.hashes[hash] = {
        pinnedAt: new Date().toISOString(),
        provider: provider,
      };
      this.db.data.confirmedPinnedHashes.totalCount++;
    }

    await this.db.write();
  }

  async isHashConfirmedPinned(hash: string): Promise<boolean> {
    await this.db.read();

    // Initialize confirmedPinnedHashes if it doesn't exist (for migration)
    if (!this.db.data.confirmedPinnedHashes) {
      this.db.data.confirmedPinnedHashes = {
        hashes: {},
        totalCount: 0,
      };
      await this.db.write();
    }

    return !!this.db.data.confirmedPinnedHashes.hashes[hash];
  }

  async getConfirmedPinnedHashCount(): Promise<number> {
    await this.db.read();
    return this.db.data.confirmedPinnedHashes?.totalCount || 0;
  }

  async clearConfirmedPinnedHashes() {
    await this.db.read();
    this.db.data.confirmedPinnedHashes = {
      hashes: {},
      totalCount: 0,
    };
    await this.db.write();
  }

  // Auto-chunk progression methods
  async setCurrentChunk(chunkFilename: string | null) {
    await this.db.read();
    this.db.data.autoChunkProgress.currentChunk = chunkFilename;
    this.db.data.autoChunkProgress.lastUpdated = new Date().toISOString();
    await this.db.write();
  }

  async markChunkCompleted(chunkFilename: string) {
    await this.db.read();

    console.log(`📁 DEBUG: Marking chunk as completed: ${chunkFilename}`);
    console.log(`   • Progress file: ${this.dbFile}`);
    console.log(
      `   • Before - Completed: ${this.db.data.autoChunkProgress.completedChunks.length}, Failed: ${this.db.data.autoChunkProgress.failedChunks.length}`
    );

    // Remove from failed chunks if it was there
    const failedIndex =
      this.db.data.autoChunkProgress.failedChunks.indexOf(chunkFilename);
    if (failedIndex > -1) {
      this.db.data.autoChunkProgress.failedChunks.splice(failedIndex, 1);
      console.log(`   • Removed from failed chunks list`);
    }

    // Add to completed chunks if not already there
    if (
      !this.db.data.autoChunkProgress.completedChunks.includes(chunkFilename)
    ) {
      this.db.data.autoChunkProgress.completedChunks.push(chunkFilename);
      console.log(`   • Added to completed chunks list`);
    } else {
      console.log(`   • Already in completed chunks list`);
    }

    this.db.data.autoChunkProgress.currentChunk = null;
    this.db.data.autoChunkProgress.lastUpdated = new Date().toISOString();

    console.log(
      `   • After - Completed: ${this.db.data.autoChunkProgress.completedChunks.length}, Failed: ${this.db.data.autoChunkProgress.failedChunks.length}`
    );
    console.log(`   • Writing to progress file: ${this.dbFile}`);

    await this.db.write();

    console.log(`   • ✅ Progress file updated successfully`);
  }

  async markChunkFailed(chunkFilename: string) {
    await this.db.read();
    // Add to failed chunks if not already there
    if (!this.db.data.autoChunkProgress.failedChunks.includes(chunkFilename)) {
      this.db.data.autoChunkProgress.failedChunks.push(chunkFilename);
    }

    this.db.data.autoChunkProgress.currentChunk = null;
    this.db.data.autoChunkProgress.lastUpdated = new Date().toISOString();
    await this.db.write();
  }

  async getAutoChunkProgress() {
    await this.db.read();

    console.log(`📁 DEBUG: Reading auto-chunk progress from: ${this.dbFile}`);

    // Initialize autoChunkProgress if it doesn't exist (for migration)
    if (!this.db.data.autoChunkProgress) {
      console.log(
        `   • Auto-chunk progress not found - initializing new structure`
      );
      this.db.data.autoChunkProgress = {
        completedChunks: [],
        failedChunks: [],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      };
      await this.db.write();
      console.log(`   • Auto-chunk progress structure created and saved`);
    } else {
      console.log(`   • Auto-chunk progress found:`);
      console.log(
        `     - Completed chunks: ${this.db.data.autoChunkProgress.completedChunks.length}`
      );
      console.log(
        `     - Failed chunks: ${this.db.data.autoChunkProgress.failedChunks.length}`
      );
      console.log(
        `     - Current chunk: ${this.db.data.autoChunkProgress.currentChunk || 'none'}`
      );
      console.log(
        `     - Last updated: ${this.db.data.autoChunkProgress.lastUpdated}`
      );
    }

    return this.db.data.autoChunkProgress;
  }

  async clearAutoChunkProgress() {
    await this.db.read();
    this.db.data.autoChunkProgress = {
      completedChunks: [],
      failedChunks: [],
      currentChunk: null,
      lastUpdated: new Date().toISOString(),
    };
    await this.db.write();
  }

  // Helper methods for orchestrator compatibility
  async isCollectionCompleted(collectionName: string): Promise<boolean> {
    await this.db.read();
    return !!this.db.data.pinnedCollections[collectionName];
  }

  async isTokenPinned(tokenId: string): Promise<boolean> {
    await this.db.read();
    return this.db.data.pinnedTokens.includes(tokenId);
  }

  async markCollectionCompleted(collectionName: string): Promise<void> {
    await this.db.read();
    // Move from pinning to pinned
    const pinning = this.db.data.pinningCollections[collectionName];
    if (pinning) {
      delete this.db.data.pinningCollections[collectionName];
      this.db.data.pinnedCollections[collectionName] = {
        ...pinning,
        completed: pinning.assets,
        lastUpdated: new Date().toISOString(),
      };
    } else {
      // If not in pinning, just mark as completed
      this.db.data.pinnedCollections[collectionName] = {
        assets: 0,
        page: 0,
        completed: 0,
        failed: 0,
        lastUpdated: new Date().toISOString(),
      };
    }
    await this.db.write();
  }

  async markTokenPinned(tokenId: string): Promise<void> {
    await this.db.read();
    if (!this.db.data.pinnedTokens.includes(tokenId)) {
      this.db.data.pinnedTokens.push(tokenId);
      await this.db.write();
    }
  }
}
