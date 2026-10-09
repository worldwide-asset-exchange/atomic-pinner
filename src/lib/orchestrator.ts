/**
 * Main orchestrator for the WAX IPFS Pinning Service
 * Coordinates all the modules to process collections and tokens
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import cliProgress from 'cli-progress';
import { Storage } from './Storage.js';
import { ChunkManager, ChunkProgressInfo } from './chunkManager.js';
import { EnvConfig } from './envParser.js';
import {
  getRateLimitConfig,
  displayRateLimitConfig,
  RateLimiter,
  sleep,
} from './rateLimitConfig.js';
import { sendSlackNotification, sendSlackStartNotification } from './slack.js';

import type { ChunkInfo } from './slack.js';
import Atomic from './atomicassets.js';
import {
  pinHashToPinata,
  verifyHashExists,
  isHashAlreadyPinned,
  setGlobalStorage,
} from './ipfsProvider.js';
import {
  extractHashesFromAsset,
  fetchAndExtractTokenHashes,
  extractHashesFromToken,
} from './hashExtractor.js';

export interface PinningObjectConfig {
  collection?: string[];
  token?: Array<{
    chain: string;
    address: string;
    metadata?: any;
  }>;
}

export interface OrchestratorConfig extends EnvConfig {
  progressFile: string;
  persistentCacheFile: string;
}

export class PinningOrchestrator {
  private progressStorage: Storage;
  private persistentCache: Storage;
  private chunkManager?: ChunkManager;
  private rateLimiter: RateLimiter;
  private startTime: number = Date.now();
  private atomic: Atomic;

  // Statistics tracking
  private collectionStats = {
    totalHashesFound: 0,
    uniqueHashesToPin: 0,
    actualPinsExecuted: 0,
    alreadyPinnedSkipped: 0,
    missingHashesSkipped: 0,
    notMissingFromIPFS: 0,
    pinsSaved: 0,
  };

  private tokenStats = {
    totalHashesFound: 0,
    actualPinsExecuted: 0,
    alreadyPinnedSkipped: 0,
    missingHashesSkipped: 0,
    notMissingFromIPFS: 0,
  };

  // Hash tracking for reporting
  private globalUniqueHashes = new Set<string>();
  private globalNotFoundHashes = new Set<string>();
  private globalHashSources = new Map<
    string,
    { collections: Set<string>; tokens: Set<string>; assets: Set<string> }
  >();

  constructor(private config: OrchestratorConfig) {
    this.progressStorage = new Storage(config.progressFile);
    this.persistentCache = new Storage(config.persistentCacheFile);
    this.atomic = new Atomic(config.atomicApiUrl, this.progressStorage);

    // Set up rate limiting
    const rateLimitConfig = getRateLimitConfig(
      config.pinataPlan,
      config.rateLimitDelayMs,
      config.batchSize
    );
    this.rateLimiter = new RateLimiter(rateLimitConfig);

    // Display configuration
    this.displayConfiguration(rateLimitConfig);

    // Set up chunk manager if in auto-chunk mode
    if (config.autoChunkMode) {
      this.chunkManager = new ChunkManager(
        {
          chunkDirectory: config.chunkDirectory,
          chunkPrefix: config.chunkPrefix,
          enableCycling: config.autoChunkCycle,
        },
        this.progressStorage
      );
    }
  }

  /**
   * Initialize the orchestrator
   */
  async initialize(): Promise<void> {
    // Initialize storage - Storage class handles reading internally
    // The db.read() is called automatically when needed by Storage methods

    // Set global storage for IPFS provider
    const { setGlobalStorage } = await import('./ipfsProvider.js');
    setGlobalStorage(this.persistentCache);

    // Handle fresh start mode
    if (this.config.shouldFreshStart) {
      console.log(`🔄 FRESH_START=1 detected - clearing all progress data`);
      console.log(`   • This will reset chunk progress back to the beginning!`);
      await this.progressStorage.clearAllProgress();
    } else {
      console.log(`📋 FRESH_START=false - continuing from existing progress`);
    }
  }

  /**
   * Main entry point for processing
   */
  async run(): Promise<void> {
    try {
      await this.initialize();

      // Send Slack start notification if configured
      if (this.config.slackToken) {
        await this.sendStartNotification();
      }

      // Determine what to process
      const pinningObject = await this.loadPinningObject();

      if (!pinningObject) {
        console.log('❌ No pinning object configuration found');
        return;
      }

      // Process collections if enabled
      if (this.config.uploadCollectionNft && pinningObject.collection) {
        await this.processCollections(pinningObject.collection);
      }

      // Process tokens if enabled
      if (this.config.uploadToken && pinningObject.token) {
        await this.processTokens(pinningObject.token);
      }

      // Send completion notification
      await this.sendCompletionNotification(true);
    } catch (error) {
      console.error('❌ Fatal error in orchestrator:', error);
      await this.sendCompletionNotification(false, error);
      throw error;
    }
  }

  /**
   * Load the pinning object configuration
   */
  private async loadPinningObject(): Promise<PinningObjectConfig | null> {
    if (this.config.autoChunkMode && this.chunkManager) {
      // Auto-chunk mode: find next chunk
      const chunkInfo = await this.chunkManager.findNextChunkFile();

      if (!chunkInfo.chunkFile) {
        console.log('✅ All chunks completed');
        return null;
      }

      this.chunkManager.displayChunkProgress(chunkInfo);
      await this.chunkManager.setCurrentChunk(chunkInfo.chunkFileName);

      // Load chunk file
      try {
        const content = await fs.readFile(chunkInfo.chunkFile, 'utf-8');
        const pinningObject = JSON.parse(content);
        console.log(`📦 Loaded chunk: ${chunkInfo.chunkFileName}`);
        return pinningObject;
      } catch (error) {
        console.error(
          `❌ Failed to load chunk ${chunkInfo.chunkFileName}:`,
          error
        );
        await this.chunkManager.markChunkFailed(chunkInfo.chunkFileName);
        return null;
      }
    } else {
      // Standard mode: load single object file
      try {
        const content = await fs.readFile(this.config.objectFile, 'utf-8');
        const pinningObject = JSON.parse(content);
        console.log(`📄 Loaded configuration from: ${this.config.objectFile}`);
        return pinningObject;
      } catch (error) {
        console.error(`❌ Failed to load ${this.config.objectFile}:`, error);
        return null;
      }
    }
  }

  /**
   * Process NFT collections
   */
  private async processCollections(collections: string[]): Promise<void> {
    console.log(`\n🎨 Processing ${collections.length} NFT collections...`);

    const isDryRun = this.config.dryRun;
    const dryRunLimit =
      this.config.dryRunLimit === -1 ? Infinity : this.config.dryRunLimit;

    if (isDryRun) {
      console.log(`🔍 DRY RUN MODE - No actual pinning will occur`);
      if (dryRunLimit !== Infinity) {
        console.log(`   • Limited to ${dryRunLimit} assets per collection`);
      }
    }

    // Initialize collection-level progress bar
    const collectionsProgressBar = new cliProgress.SingleBar({
      format:
        'Collections Progress |{bar}| {percentage}% | {value}/{total} | {collectionName} | ETA: {eta}s',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: true,
    });

    const totalCollections = collections.length;
    let completedCollections = 0;

    if (totalCollections > 0) {
      collectionsProgressBar.start(totalCollections, completedCollections, {
        collectionName: 'Starting...',
      });
    }

    for (const collectionName of collections) {
      collectionsProgressBar.update(completedCollections, {
        collectionName: collectionName,
      });

      if (await this.progressStorage.getPinnedCollection(collectionName)) {
        console.log(`Collection ${collectionName} hashes already pinned`);
        completedCollections++;
        collectionsProgressBar.update(completedCollections, {
          collectionName: `Skipped ${collectionName} (already pinned)`,
        });
        continue;
      }

      console.log(
        `\n=== Starting collection processing: ${collectionName} ===`
      );

      let page = 1;
      let totalProcessedAssets = 0;
      let totalCompletedAssets = 0;
      let totalFailedAssets = 0;

      // Resume from previous progress if available
      const pinningProgress =
        await this.progressStorage.getPinningCollection(collectionName);
      if (pinningProgress) {
        page = pinningProgress.page;
        totalProcessedAssets = pinningProgress.assets;
        totalCompletedAssets = pinningProgress.completed || 0;
        totalFailedAssets = pinningProgress.failed || 0;
        console.log(
          `Resuming from page ${page}, processed: ${totalProcessedAssets}, completed: ${totalCompletedAssets}, failed: ${totalFailedAssets}`
        );
      }

      const startTime = Date.now();
      let pageStartTime = Date.now();
      let collectionCompleteReason = 'natural';

      // Track pages processed in this run for page limit
      let pagesProcessedThisRun = 0;

      do {
        console.log(
          `\n--- Processing page ${page} for collection: ${collectionName} ---`
        );
        console.log(
          `Total progress: ${totalCompletedAssets} completed, ${totalFailedAssets} failed`
        );

        // Fetch assets from AtomicAssets API
        const assetParams: any = {
          collection_name: collectionName,
          page,
        };

        // Limit assets for dry run
        if (isDryRun && dryRunLimit !== Infinity) {
          assetParams.limit = Math.min(dryRunLimit, 1000);
        }

        const assets = await this.atomic.getAssetsPage(assetParams);
        const limitedAssets =
          isDryRun && dryRunLimit !== Infinity
            ? assets.slice(0, dryRunLimit)
            : assets;

        if (limitedAssets.length === 0) {
          console.log(`No more assets found for ${collectionName}`);
          break;
        }

        console.log(
          `Retrieved ${limitedAssets.length} assets from API${isDryRun && dryRunLimit !== Infinity ? ' (limited for dry run)' : ''}`
        );

        // Process assets and extract hashes
        const { completed, failed } = await this.processAssetsPage(
          collectionName,
          limitedAssets,
          isDryRun
        );

        // Update progress tracking
        await this.progressStorage.updateCollectionProgress(
          collectionName,
          completed,
          failed
        );

        page++;
        pagesProcessedThisRun++;
        totalProcessedAssets += limitedAssets.length;
        totalCompletedAssets += completed.length;
        totalFailedAssets += failed.length;

        // Stop after first page in dry run mode
        if (isDryRun) {
          console.log(
            `📋 DRY RUN: Stopping after first batch of ${limitedAssets.length} assets`
          );
          collectionCompleteReason = 'dry-run';
          break;
        }

        await this.progressStorage.pinningCollection(
          collectionName,
          totalProcessedAssets,
          page,
          totalCompletedAssets,
          totalFailedAssets
        );

        // Check page limit if configured - limit pages per run, not absolute page number
        if (
          this.config.maxPagesPerCollection > 0 &&
          pagesProcessedThisRun >= this.config.maxPagesPerCollection
        ) {
          console.log(
            `📄 PAGE LIMIT: Processed ${this.config.maxPagesPerCollection} pages for collection '${collectionName}' in this run (now at page ${page - 1})`
          );
          collectionCompleteReason = 'page-limit';
          break;
        }

        // Performance metrics
        const pageTime = Date.now() - pageStartTime;
        const avgTimePerAsset = pageTime / assets.length;
        const assetsPerSecond = (1000 / avgTimePerAsset).toFixed(2);

        console.log(`\n--- Page ${page - 1} Summary ---`);
        console.log(`✓ Page completed in ${(pageTime / 1000).toFixed(2)}s`);
        console.log(
          `✓ Average: ${avgTimePerAsset.toFixed(0)}ms per asset (${assetsPerSecond} assets/sec)`
        );
        console.log(
          `✓ Page results: ${completed.length} completed, ${failed.length} failed`
        );

        pageStartTime = Date.now();
      } while (true);

      const totalTime = Date.now() - startTime;
      console.log(`\n=== Collection ${collectionName} Complete ===`);
      console.log(
        `✓ Total time: ${(totalTime / 1000 / 60).toFixed(2)} minutes`
      );
      console.log(`✓ Total processed: ${totalProcessedAssets} assets`);
      console.log(
        `✓ Successfully pinned hashes for: ${totalCompletedAssets} assets`
      );
      console.log(`✗ Failed to pin hashes for: ${totalFailedAssets} assets`);

      // Only mark collection as "pinned" if it finished naturally
      if (collectionCompleteReason === 'natural') {
        console.log(
          `✅ Collection ${collectionName} FULLY COMPLETED - marking as pinned`
        );
        await this.progressStorage.pinnedCollection(
          collectionName,
          totalProcessedAssets,
          page,
          totalCompletedAssets,
          totalFailedAssets
        );
        completedCollections++;
        collectionsProgressBar.update(completedCollections, {
          collectionName: `Completed ${collectionName}`,
        });
      } else {
        console.log(
          `⏸️  Collection ${collectionName} PAUSED (reason: ${collectionCompleteReason})`
        );
        collectionsProgressBar.update(completedCollections, {
          collectionName: `Paused ${collectionName} (${collectionCompleteReason})`,
        });
      }
    }

    // Stop the collections progress bar
    if (totalCollections > 0) {
      collectionsProgressBar.stop();
    }

    // Collection processing complete - show global statistics
    console.log(`\n🏁 Collection Processing Complete - Pin Statistics:`);
    console.log(
      `📊 Total IPFS hashes found: ${this.collectionStats.totalHashesFound}`
    );
    console.log(
      `🎯 Unique hashes to pin: ${this.collectionStats.uniqueHashesToPin}`
    );
    console.log(`💰 Duplicate pins avoided: ${this.collectionStats.pinsSaved}`);

    if (isDryRun) {
      console.log(
        `📋 [DRY RUN] Would execute: ${this.collectionStats.actualPinsExecuted} pin requests`
      );
      console.log(
        `⏭️ Already pinned (skipped): ${this.collectionStats.alreadyPinnedSkipped}`
      );
      console.log(
        `✅ Not missing from IPFS: ${this.collectionStats.notMissingFromIPFS}`
      );
      console.log(
        `❌ Missing from IPFS (skipped): ${this.collectionStats.missingHashesSkipped}`
      );
    } else {
      console.log(
        `✅ Actual pins executed: ${this.collectionStats.actualPinsExecuted}`
      );
      console.log(
        `⏭️ Already pinned (skipped): ${this.collectionStats.alreadyPinnedSkipped}`
      );
      console.log(
        `✅ Not missing from IPFS: ${this.collectionStats.notMissingFromIPFS}`
      );
      console.log(
        `❌ Missing from IPFS (skipped): ${this.collectionStats.missingHashesSkipped}`
      );
    }
  }

  /**
   * Process a page of assets and extract/pin hashes
   */
  private async processAssetsPage(
    collectionName: string,
    assets: any[],
    isDryRun: boolean
  ): Promise<{ completed: any[]; failed: any[] }> {
    // Extract IPFS hashes from asset data
    const assetHashes: {
      assetId: string;
      hashes: string[];
      collectionName: string;
      schemaName?: string;
      templateId?: string;
      assetName?: string;
    }[] = [];
    let totalHashes = 0;

    for (const asset of assets) {
      const hashes = extractHashesFromAsset(asset);
      if (hashes.length > 0) {
        console.log(
          `      📊 Processing Asset ID: ${asset.asset_id} | Owner: ${asset.owner} | Collection: ${asset.collection.collection_name} | Hashes: ${hashes.length}`
        );

        assetHashes.push({
          assetId: asset.asset_id.toString(),
          hashes,
          collectionName: asset.collection.collection_name.toString(),
          schemaName: asset.schema?.schema_name?.toString(),
          templateId: asset.template?.template_id?.toString(),
          assetName: asset.data?.name || asset.immutable_data?.name,
        });
        totalHashes += hashes.length;
      }
    }

    console.log(
      `Found ${totalHashes} IPFS hashes across ${assetHashes.length} assets`
    );
    this.collectionStats.totalHashesFound += totalHashes;

    if (totalHashes === 0) {
      console.log(`No IPFS hashes found in assets, skipping page`);
      return { completed: [], failed: [] };
    }

    // Deduplicate hashes before pinning
    const uniqueHashes = new Set<string>();
    const hashToAssets = new Map<string, (typeof assetHashes)[0][]>();

    for (const assetData of assetHashes) {
      for (const hash of assetData.hashes) {
        uniqueHashes.add(hash);
        if (!hashToAssets.has(hash)) {
          hashToAssets.set(hash, []);
        }
        hashToAssets.get(hash)!.push(assetData);

        // Track unique hash
        this.trackUniqueHash(hash, 'collection', collectionName, [
          assetData.assetId,
        ]);
      }
    }

    const uniqueHashCount = uniqueHashes.size;
    const duplicatesAvoided = totalHashes - uniqueHashCount;
    this.collectionStats.uniqueHashesToPin += uniqueHashCount;
    this.collectionStats.pinsSaved += duplicatesAvoided;

    console.log(
      `📌 Pinning ${uniqueHashCount} unique IPFS hashes (deduplicated from ${totalHashes} total)...`
    );
    if (duplicatesAvoided > 0) {
      console.log(
        `💰 Cost savings: ${duplicatesAvoided} duplicate pin requests avoided`
      );
    }

    // Process hashes
    const completed: any[] = [];
    const failed: any[] = [];
    const uniqueHashArray = Array.from(uniqueHashes);
    const batchSize = this.config.batchSize || 10;
    const delayMs = this.config.rateLimitDelayMs || 1000;

    console.log(
      `📊 Processing ${uniqueHashArray.length} unique hashes in batches of ${batchSize} with ${delayMs}ms delays`
    );

    // Initialize hash processing progress bar
    const hashProgressBar = new cliProgress.SingleBar({
      format: `${collectionName} Hashes |{bar}| {percentage}% | {value}/{total} | {status} | ETA: {eta}s`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: true,
    });

    let processedHashes = 0;
    hashProgressBar.start(uniqueHashArray.length, processedHashes, {
      status: 'Starting...',
    });

    try {
      for (let i = 0; i < uniqueHashArray.length; i += batchSize) {
        const batch = uniqueHashArray.slice(i, i + batchSize);
        console.log(
          `🔄 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(uniqueHashArray.length / batchSize)} (${batch.length} hashes)`
        );

        for (const hash of batch) {
          const assetsForHash = hashToAssets.get(hash)!;
          try {
            const pinResult = await this.pinHash(hash, assetsForHash, isDryRun);

            // Record completion for all assets that use this hash
            for (const asset of assetsForHash) {
              completed.push({
                assetId: asset.assetId,
                hash,
                collection: collectionName,
              });
            }

            // Update progress bar
            processedHashes++;
            hashProgressBar.update(processedHashes, {
              status: `Processed ${hash.substring(0, 12)}...`,
            });
          } catch (error: any) {
            console.error(`✗ Failed to pin ${hash}:`, error.message);
            // Record failure for all assets that use this hash
            for (const asset of assetsForHash) {
              failed.push({
                assetId: asset.assetId,
                hash,
                error: error.message,
              });
            }

            // Update progress bar even for failed hashes
            processedHashes++;
            hashProgressBar.update(processedHashes, {
              status: `Failed ${hash.substring(0, 12)}...`,
            });
          }
        }

        // Additional delay between batches
        if (i + batchSize < uniqueHashArray.length) {
          console.log(
            `⏳ Batch complete, waiting ${delayMs * 2}ms before next batch...`
          );
          await sleep(delayMs * 2);
        }
      }
    } finally {
      hashProgressBar.stop();
    }

    console.log(`✅ ${isDryRun ? 'Analysis' : 'Pinning'} batch complete:`);
    console.log(
      `  ✓ ${isDryRun ? 'Would pin' : 'Successfully pinned'}: ${completed.length} hashes`
    );
    console.log(
      `  ✗ ${isDryRun ? 'Would fail' : 'Failed pins'}: ${failed.length} hashes`
    );

    return { completed, failed };
  }

  /**
   * Pin a single hash to IPFS
   */
  private async pinHash(
    hash: string,
    assetsForHash: any[],
    isDryRun: boolean
  ): Promise<void> {
    if (isDryRun) {
      // In dry run, still verify hash existence and check if already pinned
      console.log(`🔍 [DRY RUN] Checking hash ${hash}...`);

      // First check if hash is confirmed pinned locally
      const isConfirmedPinned =
        await this.persistentCache.isHashConfirmedPinned(hash);

      let alreadyPinned = isConfirmedPinned;
      if (!isConfirmedPinned) {
        alreadyPinned = await isHashAlreadyPinned(hash);
        await sleep(this.config.rateLimitDelayMs || 1000);

        // If we discovered it's already pinned, record it for future runs
        if (alreadyPinned) {
          const provider = this.config.ipfsProvider || 'pinata';
          await this.persistentCache.recordConfirmedPinnedHash(hash, provider);
        }
      } else {
        console.log(
          `    ✅ Hash ${hash} found in confirmed pinned cache - skipping API check`
        );
      }

      if (alreadyPinned) {
        const assetList = assetsForHash.map((a) => a.assetId).join(', ');
        console.log(
          `📋 [DRY RUN] Hash ${hash} already pinned - would skip (used by ${assetsForHash.length} assets: ${assetList})`
        );
        this.collectionStats.alreadyPinnedSkipped++;
        this.collectionStats.notMissingFromIPFS++;
      } else {
        const hashExists = await verifyHashExists(hash);
        await sleep(this.config.rateLimitDelayMs || 1000);

        if (!hashExists) {
          const assetList = assetsForHash.map((a) => a.assetId).join(', ');
          console.log(
            `📋 [DRY RUN] Hash ${hash} missing from IPFS - would skip (used by ${assetsForHash.length} assets: ${assetList})`
          );
          this.collectionStats.missingHashesSkipped++;

          // Track detailed missing hash info for each asset
          for (const asset of assetsForHash) {
            this.trackNotFoundHash(hash, {
              hash,
              collectionName: asset.collectionName,
              assetId: asset.assetId,
              schemaName: asset.schemaName,
              templateId: asset.templateId,
              assetName: asset.assetName,
              source: 'collection',
            });
          }
        } else {
          const assetList = assetsForHash.map((a) => a.assetId).join(', ');
          console.log(
            `📋 [DRY RUN] Would pin hash ${hash} (used by ${assetsForHash.length} assets: ${assetList})`
          );
          this.collectionStats.actualPinsExecuted++;
          this.collectionStats.notMissingFromIPFS++;
        }
      }
    } else {
      // Check if hash is confirmed pinned locally first
      const isConfirmedPinned =
        await this.persistentCache.isHashConfirmedPinned(hash);

      let result: any = null;

      if (isConfirmedPinned) {
        console.log(
          `📌 Hash ${hash} found in confirmed pinned cache - skipping pin attempt`
        );
        this.collectionStats.alreadyPinnedSkipped++;
        this.collectionStats.notMissingFromIPFS++;
        return;
      }

      console.log(
        `📌 Pinning hash ${hash} (used by ${assetsForHash.length} assets)`
      );

      // Create metadata with collection and asset information
      const firstAsset = assetsForHash[0];
      const metadata = {
        name: `${firstAsset.collectionName}-${hash}`,
        keyvalues: {
          collection: firstAsset.collectionName,
          assetCount: assetsForHash.length,
          source: 'WAX-NFT',
          ipfsHash: hash,
        },
      };

      result = await pinHashToPinata(hash, metadata);
      await sleep(this.config.rateLimitDelayMs || 1000);

      // Record successful pin for future runs
      if (!result.skipped) {
        const provider = this.config.ipfsProvider || 'pinata';
        await this.persistentCache.recordConfirmedPinnedHash(hash, provider);
        this.collectionStats.actualPinsExecuted++;
        this.collectionStats.notMissingFromIPFS++;
      } else if (result.error === 'not_found') {
        const assetList = assetsForHash.map((a) => a.assetId).join(', ');
        console.log(`  ❌ Missing from IPFS - benefits assets: ${assetList}`);
        this.collectionStats.missingHashesSkipped++;

        // Track detailed missing hash info for each asset
        for (const asset of assetsForHash) {
          this.trackNotFoundHash(hash, {
            hash,
            collectionName: asset.collectionName,
            assetId: asset.assetId,
            schemaName: asset.schemaName,
            templateId: asset.templateId,
            assetName: asset.assetName,
            source: 'collection',
          });
        }
      } else {
        const assetList = assetsForHash.map((a) => a.assetId).join(', ');
        console.log(`  ✅ Already pinned - benefits assets: ${assetList}`);
        this.collectionStats.alreadyPinnedSkipped++;
        this.collectionStats.notMissingFromIPFS++;
      }
    }
  }

  /**
   * Process fungible tokens
   */
  private async processTokens(tokens: any[]): Promise<void> {
    console.log(`\n🪙 Processing ${tokens.length} fungible tokens...`);

    const isDryRun = this.config.dryRun;

    if (isDryRun) {
      console.log(`🔍 DRY RUN MODE - No actual pinning will occur`);
    }

    // Initialize token-level progress bar
    let tokensProgressBar: cliProgress.SingleBar | null =
      new cliProgress.SingleBar({
        format:
          'Tokens Progress |{bar}| {percentage}% | {value}/{total} | {tokenName} | ETA: {eta}s',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: true,
      });

    const totalTokens = tokens.length;
    let processedTokens = 0;

    if (totalTokens > 0) {
      tokensProgressBar.start(totalTokens, processedTokens, {
        tokenName: 'Starting...',
      });
    }

    for (const token of tokens) {
      const tokenId = `${token.chain}:${token.address}`;

      tokensProgressBar.update(processedTokens, {
        tokenName: `${token.chain}:${token.address.substring(0, 8)}...`,
      });

      // Check if token is already pinned
      if (await this.progressStorage.isTokenPinned(tokenId)) {
        console.log(`Token ${tokenId} already pinned, skipping...`);
        processedTokens++;
        tokensProgressBar.update(processedTokens, {
          tokenName: `Skipped ${token.chain}:${token.address.substring(0, 8)}... (already pinned)`,
        });
        continue;
      }

      // Process token hashes
      await this.processTokenHashes(token, isDryRun);

      // Mark token as pinned after successful processing
      if (!isDryRun) {
        await this.progressStorage.markTokenPinned(tokenId);
      }

      processedTokens++;
      tokensProgressBar.update(processedTokens, {
        tokenName: `Completed ${token.chain}:${token.address.substring(0, 8)}...`,
      });
    }

    // Stop the tokens progress bar
    if (totalTokens > 0) {
      tokensProgressBar.stop();
    }

    // Show token processing statistics
    console.log(`\n🪙 Token Processing Complete - Pin Statistics:`);
    console.log(
      `📊 Total IPFS hashes found: ${this.tokenStats.totalHashesFound}`
    );

    if (isDryRun) {
      console.log(
        `📋 [DRY RUN] Would execute: ${this.tokenStats.actualPinsExecuted} pin requests`
      );
      console.log(
        `⏭️ Already pinned (skipped): ${this.tokenStats.alreadyPinnedSkipped}`
      );
      console.log(
        `✅ Not missing from IPFS: ${this.tokenStats.notMissingFromIPFS}`
      );
      console.log(
        `❌ Missing from IPFS (skipped): ${this.tokenStats.missingHashesSkipped}`
      );
    } else {
      console.log(
        `✅ Actual pins executed: ${this.tokenStats.actualPinsExecuted}`
      );
      console.log(
        `⏭️ Already pinned (skipped): ${this.tokenStats.alreadyPinnedSkipped}`
      );
      console.log(
        `✅ Not missing from IPFS: ${this.tokenStats.notMissingFromIPFS}`
      );
      console.log(
        `❌ Missing from IPFS (skipped): ${this.tokenStats.missingHashesSkipped}`
      );
    }
  }

  /**
   * Process hashes for a single token
   */
  private async processTokenHashes(
    token: any,
    isDryRun: boolean
  ): Promise<void> {
    // Check for local metadata hashes
    if (token.metadata?.image) {
      const localHashes = extractHashesFromToken(token.metadata);
      console.log(
        `Token ${token.address}: Found ${localHashes.length} hashes in local metadata`
      );

      this.tokenStats.totalHashesFound += localHashes.length;
      localHashes.forEach((hash) =>
        this.trackUniqueHash(hash, 'token', token.address)
      );

      for (const hash of localHashes) {
        await this.pinTokenHash(hash, token, isDryRun, 'local_metadata');
      }
    }

    // Check for metadata URL to fetch
    if (token.metadataUrl) {
      console.log(`Fetching token metadata from: ${token.metadataUrl}`);
      const { metadataHash, nestedHashes } = await fetchAndExtractTokenHashes(
        token.metadataUrl
      );

      // Pin the metadata hash itself
      if (metadataHash) {
        this.tokenStats.totalHashesFound++;
        this.trackUniqueHash(metadataHash, 'token', token.address);
        await this.pinTokenHash(metadataHash, token, isDryRun, 'metadata_file');
      }

      // Pin nested hashes
      if (nestedHashes.length > 0) {
        console.log(
          `Token ${token.address}: Found ${nestedHashes.length} nested hashes`
        );
        this.tokenStats.totalHashesFound += nestedHashes.length;
        nestedHashes.forEach((hash) =>
          this.trackUniqueHash(hash, 'token', token.address)
        );

        for (const hash of nestedHashes) {
          await this.pinTokenHash(hash, token, isDryRun, 'nested');
        }
      }
    }
  }

  /**
   * Pin a single token hash
   */
  private async pinTokenHash(
    hash: string,
    token: any,
    isDryRun: boolean,
    source: string
  ): Promise<void> {
    try {
      if (isDryRun) {
        console.log(
          `🔍 [DRY RUN] Checking ${source} hash ${hash} for token ${token.address}...`
        );
        const alreadyPinned = await isHashAlreadyPinned(hash);
        await sleep(this.config.rateLimitDelayMs || 1000);

        if (alreadyPinned) {
          console.log(`📋 [DRY RUN] Hash ${hash} already pinned - would skip`);
          this.tokenStats.alreadyPinnedSkipped++;
          this.tokenStats.notMissingFromIPFS++;
        } else {
          const hashExists = await verifyHashExists(hash);
          await sleep(this.config.rateLimitDelayMs || 1000);

          if (!hashExists) {
            console.log(
              `📋 [DRY RUN] Hash ${hash} missing from IPFS - would skip`
            );
            this.tokenStats.missingHashesSkipped++;
            this.trackNotFoundHash(hash, {
              hash,
              collectionName: 'Token Metadata',
              assetId: `token-${token.address}-${source}`,
              source: 'token',
              tokenAddress: token.address,
            });
          } else {
            console.log(`📋 [DRY RUN] Would pin ${source} hash ${hash}`);
            this.tokenStats.actualPinsExecuted++;
            this.tokenStats.notMissingFromIPFS++;
          }
        }
      } else {
        console.log(
          `📌 Pinning ${source} hash ${hash} for token ${token.address}`
        );

        const metadata = {
          name: `TOKEN-${source.toUpperCase()}-${token.address.slice(0, 8)}-${hash}`,
          keyvalues: {
            tokenAddress: token.address,
            chain: token.chain,
            source: `WAX-Token-${source}`,
            ipfsHash: hash,
            type: source,
          },
        };

        const result = await pinHashToPinata(hash, metadata);
        await sleep(this.config.rateLimitDelayMs || 1000);

        if (result.skipped) {
          if (result.error === 'not_found') {
            this.tokenStats.missingHashesSkipped++;
            this.trackNotFoundHash(hash, {
              hash,
              collectionName: 'Token Metadata',
              assetId: `token-${token.address}-${source}`,
              source: 'token',
              tokenAddress: token.address,
            });
          } else {
            this.tokenStats.alreadyPinnedSkipped++;
            this.tokenStats.notMissingFromIPFS++;
          }
        } else {
          this.tokenStats.actualPinsExecuted++;
          this.tokenStats.notMissingFromIPFS++;
        }
      }
    } catch (error: any) {
      console.error(
        `✗ Failed to pin ${source} hash ${hash} for token ${token.address}:`,
        error.message
      );
    }
  }

  /**
   * Track unique hash for reporting
   */
  private trackUniqueHash(
    hash: string,
    source: 'collection' | 'token',
    sourceId: string,
    assetIds?: string[]
  ): void {
    if (!this.config.trackUniqueHashes) return;

    this.globalUniqueHashes.add(hash);

    if (!this.globalHashSources.has(hash)) {
      this.globalHashSources.set(hash, {
        collections: new Set(),
        tokens: new Set(),
        assets: new Set(),
      });
    }

    const hashSource = this.globalHashSources.get(hash)!;

    if (source === 'collection') {
      hashSource.collections.add(sourceId);
      if (assetIds) {
        assetIds.forEach((assetId) => hashSource.assets.add(assetId));
      }
    } else if (source === 'token') {
      hashSource.tokens.add(sourceId);
    }
  }

  /**
   * Track not found hash for reporting
   */
  private trackNotFoundHash(hash: string, detail?: any): void {
    if (!this.config.trackNotFoundHashes) return;
    this.globalNotFoundHashes.add(hash);
    // Additional detailed tracking could be added here if needed
  }

  /**
   * Display configuration at startup
   */
  private displayConfiguration(rateLimitConfig: any): void {
    console.log('🏗️  WAX IPFS Pinning Service - Starting');
    console.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    );

    // Display environment configuration
    console.log('\n📋 CONFIGURATION:');
    console.log(`   • AtomicAssets API: ${this.config.atomicApiUrl}`);
    console.log(`   • IPFS Provider: ${this.config.ipfsProvider}`);
    console.log(
      `   • Upload Collections: ${this.config.uploadCollectionNft ? '✅' : '❌'}`
    );
    console.log(`   • Upload Tokens: ${this.config.uploadToken ? '✅' : '❌'}`);
    console.log(`   • Dry Run: ${this.config.dryRun ? '✅' : '❌'}`);

    if (this.config.autoChunkMode) {
      console.log('\n📦 AUTO-CHUNK MODE:');
      console.log(`   • Chunk Directory: ${this.config.chunkDirectory}`);
      console.log(`   • Chunk Prefix: ${this.config.chunkPrefix}`);
      console.log(`   • Cycling: ${this.config.autoChunkCycle ? '✅' : '❌'}`);
    }

    if (this.config.maxPagesPerCollection > 0) {
      console.log(`\n📄 PAGE LIMITING:`);
      console.log(
        `   • Max pages per collection: ${this.config.maxPagesPerCollection}`
      );
    }

    // Display rate limiting configuration
    console.log('');
    displayRateLimitConfig(rateLimitConfig);

    console.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
    );
  }

  /**
   * Send Slack start notification
   */
  private async sendStartNotification(): Promise<void> {
    if (!this.config.slackToken || !this.config.slackChannel) return;

    try {
      // Get chunk info if in auto-chunk mode
      let chunkInfo: ChunkInfo | undefined;
      if (this.chunkManager) {
        const progress = await this.progressStorage.getAutoChunkProgress();
        if (progress.currentChunk) {
          const allChunks = await this.chunkManager.findChunkFiles();

          // Gather collection progress details for start notification
          const collectionProgress = await this.gatherCollectionProgress();

          chunkInfo = {
            chunkFileName: progress.currentChunk,
            currentChunkNumber: allChunks.indexOf(progress.currentChunk) + 1,
            totalChunks: allChunks.length,
            completedChunks: progress.completedChunks.length,
            failedChunks: progress.failedChunks.length,
            collectionProgress,
          };
        }
      }

      await sendSlackStartNotification(this.config.dryRun, chunkInfo);
    } catch (error) {
      console.warn('⚠️  Failed to send Slack start notification:', error);
    }
  }

  /**
   * Send Slack completion notification
   */
  private async sendCompletionNotification(
    success: boolean,
    error?: any
  ): Promise<void> {
    if (!this.config.slackToken || !this.config.slackChannel) return;

    const runtime = this.formatRuntime(Date.now() - this.startTime);

    // Combine stats from collections and tokens
    const totalHashesFound =
      this.collectionStats.totalHashesFound + this.tokenStats.totalHashesFound;
    const pinsExecuted =
      this.collectionStats.actualPinsExecuted +
      this.tokenStats.actualPinsExecuted;
    const alreadyPinned =
      this.collectionStats.alreadyPinnedSkipped +
      this.tokenStats.alreadyPinnedSkipped;
    const missingHashes =
      this.collectionStats.missingHashesSkipped +
      this.tokenStats.missingHashesSkipped;
    const notMissingFromIPFS =
      this.collectionStats.notMissingFromIPFS +
      this.tokenStats.notMissingFromIPFS;
    const duplicatesAvoided = this.collectionStats.pinsSaved;

    try {
      // Get chunk info if in auto-chunk mode
      let chunkInfo: ChunkInfo | undefined;
      if (this.chunkManager) {
        const progress = await this.progressStorage.getAutoChunkProgress();
        if (progress.currentChunk) {
          const allChunks = await this.chunkManager.findChunkFiles();

          // Gather collection progress details
          const collectionProgress = await this.gatherCollectionProgress();

          chunkInfo = {
            chunkFileName: progress.currentChunk,
            currentChunkNumber: allChunks.indexOf(progress.currentChunk) + 1,
            totalChunks: allChunks.length,
            completedChunks: progress.completedChunks.length,
            failedChunks: progress.failedChunks.length,
            collectionProgress,
          };
        }
      }

      await sendSlackNotification({
        success,
        totalHashesFound,
        pinsExecuted,
        alreadyPinned,
        missingHashes,
        notMissingFromIPFS,
        duplicatesAvoided,
        runtime,
        isDryRun: this.config.dryRun,
        error: error?.message,
        chunkInfo,
      });
    } catch (notifyError) {
      console.warn(
        '⚠️  Failed to send Slack completion notification:',
        notifyError
      );
    }
  }

  /**
   * Gather collection progress information for Slack notification
   */
  private async gatherCollectionProgress(): Promise<any> {
    await this.progressStorage.db.read();
    const data = this.progressStorage.db.data;

    const pinningCollections = Object.entries(data.pinningCollections || {});
    const pinnedCollections = Object.keys(data.pinnedCollections || {});

    const totalCollections =
      pinningCollections.length + pinnedCollections.length;
    const collectionsWithProgress = pinningCollections.length;

    // Find the collection with the most progress (highest page number)
    let largestCollection: any = null;
    for (const [name, info] of pinningCollections) {
      const collectionInfo = info as any;
      if (
        !largestCollection ||
        collectionInfo.page > largestCollection.currentPage
      ) {
        largestCollection = {
          name,
          currentPage: collectionInfo.page - 1, // page is incremented after processing
          lastPage: collectionInfo.page - 1,
          assetsProcessed: collectionInfo.assets,
          completed: collectionInfo.completed || 0,
          failed: collectionInfo.failed || 0,
        };
      }
    }

    return {
      totalCollections,
      collectionsWithProgress,
      largestCollection,
      pinnedCollections: pinnedCollections.length,
      pinningCollections: pinningCollections.map(([name, info]) => {
        const col = info as any;
        return {
          name,
          currentPage: col.page - 1,
          assetsProcessed: col.assets,
          completed: col.completed || 0,
          failed: col.failed || 0,
        };
      }),
    };
  }

  /**
   * Format runtime duration
   */
  private formatRuntime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Check if current chunk is fully complete and mark it if so
   */
  async markChunkCompleted(): Promise<void> {
    if (this.config.autoChunkMode && this.chunkManager) {
      const progress = await this.progressStorage.getAutoChunkProgress();
      if (!progress.currentChunk) return;

      // Check if all collections in the chunk are fully complete
      const isChunkComplete = await this.isChunkFullyComplete();

      if (isChunkComplete) {
        await this.chunkManager.markChunkCompleted(progress.currentChunk);
        console.log(
          `✅ Chunk ${progress.currentChunk} marked as completed - all collections fully processed`
        );
      } else {
        console.log(
          `⏸️  Chunk ${progress.currentChunk} not yet complete - will resume on next run`
        );
      }
    }
  }

  /**
   * Check if all collections in current chunk are fully complete
   */
  private async isChunkFullyComplete(): Promise<boolean> {
    // Load the current chunk's pinning object
    const pinningObject = await this.loadPinningObject();
    if (!pinningObject) return true;

    // Check each collection in the chunk
    if (pinningObject.collection) {
      for (const collectionName of pinningObject.collection) {
        // Check if collection is in pinnedCollections (fully complete)
        const isPinned =
          await this.progressStorage.getPinnedCollection(collectionName);
        if (!isPinned) {
          // Check if it's still being processed (in pinningCollections)
          const pinningProgress =
            await this.progressStorage.getPinningCollection(collectionName);
          if (pinningProgress) {
            // Collection is still in pinningCollections, but we need to check if it's truly done
            // Try to fetch the next page to see if there are more assets
            console.log(
              `   • Collection ${collectionName} checking if more pages exist beyond page ${pinningProgress.page}...`
            );

            const nextPageAssets = await this.atomic.getAssetsPage({
              collection_name: collectionName,
              page: pinningProgress.page + 1,
              limit: 1, // Just check if any assets exist
            });

            if (nextPageAssets.length > 0) {
              console.log(
                `   • Collection ${collectionName} has more pages to process (currently at page ${pinningProgress.page})`
              );
              return false;
            } else {
              console.log(
                `   • Collection ${collectionName} is COMPLETE (no more assets after page ${pinningProgress.page})`
              );
              // Collection is actually done, just hasn't been moved to pinnedCollections yet
            }
          } else {
            console.log(
              `   • Collection ${collectionName} has not been started yet`
            );
            return false;
          }
        }
      }
    }

    // Check tokens if enabled
    if (this.config.uploadToken && pinningObject.token) {
      for (const token of pinningObject.token) {
        const tokenId = `${token.chain}:${token.address}`;
        const isPinned = await this.progressStorage.isTokenPinned(tokenId);
        if (!isPinned) {
          console.log(`   • Token ${tokenId} is not complete`);
          return false;
        }
      }
    }

    return true;
  }
}
