#!/usr/bin/env node

/**
 * Main entry point for the WAX IPFS Pinning Service
 * This is a cleaner, more testable replacement for pinIPFS.ts
 */

import 'dotenv/config';
import { PinningOrchestrator } from './lib/orchestrator.js';
import { loadEnvConfig } from './lib/envParser.js';

async function main() {
  try {
    // Load environment configuration
    const envConfig = loadEnvConfig();

    // Create orchestrator configuration
    // progress.json is the resume cursor, not a log: it records which chunks and collections are
    // done. The paths are env-configurable because that state must outlive the process. In a
    // container the filesystem is discarded on exit, so the files have to live on a mounted volume;
    // running without one restarts from the first chunk every time and re-hammers the IPFS provider
    // and the AtomicAssets API. Defaults are relative paths so local runs need no configuration.
    const progressFileName = process.env.PROGRESS_FILE || './progress.json';
    const persistentCacheFileName =
      process.env.PERSISTENT_CACHE_FILE || './confirmed-pinned-hashes.json';

    console.log(`📁 Using unified progress file: ${progressFileName}`);
    console.log(`   • Single source of truth for all progress tracking`);
    console.log(`   • Use FRESH_START=1 to clear progress when needed`);

    const config = {
      ...envConfig,
      progressFile: progressFileName,
      persistentCacheFile: persistentCacheFileName,
    };

    // Create and run orchestrator
    const orchestrator = new PinningOrchestrator(config);
    await orchestrator.run();

    // Mark chunk as completed if successful
    await orchestrator.markChunkCompleted();

    console.log('\n✅ Processing completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };
