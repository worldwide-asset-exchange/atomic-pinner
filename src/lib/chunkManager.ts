import * as fs from 'fs/promises';
import * as path from 'path';
import { Storage } from './Storage.js';

export interface ChunkProgressInfo {
  chunkFile: string | null;
  currentChunkNumber: number;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  chunkFileName: string;
}

export interface ChunkManagerConfig {
  chunkDirectory: string;
  chunkPrefix: string;
  enableCycling: boolean;
}

export class ChunkManager {
  constructor(
    private config: ChunkManagerConfig,
    private progressStorage: Storage
  ) {}

  /**
   * Extract chunk number from filename like "object-chunk-01.json" -> 1
   */
  private getChunkNumber(chunkFileName: string): number {
    const match = chunkFileName.match(
      new RegExp(`${this.config.chunkPrefix}-(\\d+)\\.json$`)
    );
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Find all chunk files in the configured directory
   */
  async findChunkFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.config.chunkDirectory);
      const pattern = new RegExp(`^${this.config.chunkPrefix}-\\d+\\.json$`);
      return files.filter((file) => pattern.test(file)).sort(); // Sort to ensure proper order (01, 02, 03, etc.)
    } catch (error) {
      console.error(
        `Error reading chunk directory ${this.config.chunkDirectory}:`,
        error
      );
      return [];
    }
  }

  /**
   * Check if a chunk file exists
   */
  async chunkFileExists(chunkFileName: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.config.chunkDirectory, chunkFileName);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find the next chunk file to process
   */
  async findNextChunkFile(): Promise<ChunkProgressInfo> {
    try {
      // Get current progress to see which chunks are completed/failed
      const progress = await this.progressStorage.getAutoChunkProgress();

      console.log(`\n🔍 DEBUG findNextChunkFile called:`);
      console.log(`   • Current chunk: ${progress.currentChunk || 'none'}`);
      console.log(
        `   • Completed chunks: [${progress.completedChunks.join(', ')}]`
      );
      console.log(`   • Failed chunks: [${progress.failedChunks.join(', ')}]`);

      // Find all chunk files in directory
      const chunkFiles = await this.findChunkFiles();

      if (chunkFiles.length === 0) {
        console.log(
          `⚠️  No chunk files found in ${this.config.chunkDirectory}/ with prefix '${this.config.chunkPrefix}'`
        );
        return this.createEmptyChunkInfo(progress);
      }

      // Check if there's a current chunk
      if (progress.currentChunk) {
        // If current chunk is already completed, clear it and find the next one
        if (progress.completedChunks.includes(progress.currentChunk)) {
          console.log(
            `✅ Current chunk ${progress.currentChunk} is complete, moving to next chunk...`
          );
          progress.currentChunk = null;
          await this.progressStorage.setCurrentChunk(null);
        }
        // If current chunk exists and is not completed, resume it
        else if (chunkFiles.includes(progress.currentChunk)) {
          console.log(
            `🔄 Resuming current chunk: ${progress.currentChunk} (not yet fully complete)`
          );
          return this.createChunkInfo(
            progress.currentChunk,
            chunkFiles,
            progress
          );
        }
        // If current chunk doesn't exist, clear it
        else {
          console.log(
            `⚠️  Current chunk ${progress.currentChunk} no longer exists, finding next...`
          );
          progress.currentChunk = null;
          await this.progressStorage.setCurrentChunk(null);
        }
      }

      // Find first chunk that's not completed and not currently failed
      console.log(
        `\n🔎 Searching through ${chunkFiles.length} chunk files: [${chunkFiles.join(', ')}]`
      );
      for (const chunkFile of chunkFiles) {
        // Skip if already completed
        if (progress.completedChunks.includes(chunkFile)) {
          console.log(`✅ Chunk ${chunkFile} already completed, skipping...`);
          continue;
        }

        // Skip if currently in failed state (will retry failed chunks after processing all new ones)
        if (progress.failedChunks.includes(chunkFile)) {
          console.log(
            `⚠️  Chunk ${chunkFile} previously failed, deferring for retry...`
          );
          continue;
        }

        // Found next chunk to process - set it as current
        console.log(`📦 Found next chunk to process: ${chunkFile}`);
        console.log(`   • Setting as current chunk in storage`);
        await this.progressStorage.setCurrentChunk(chunkFile);
        return this.createChunkInfo(chunkFile, chunkFiles, progress);
      }

      // If we get here, check if there are any failed chunks to retry
      for (const failedChunk of progress.failedChunks) {
        if (await this.chunkFileExists(failedChunk)) {
          console.log(`🔄 Retrying previously failed chunk: ${failedChunk}`);
          await this.progressStorage.setCurrentChunk(failedChunk);
          return this.createChunkInfo(failedChunk, chunkFiles, progress);
        } else {
          console.log(
            `⚠️  Failed chunk file ${failedChunk} no longer exists, skipping...`
          );
        }
      }

      // All chunks completed
      console.log(`🎉 All available chunks have been completed!`);
      console.log(`📊 Completed: ${progress.completedChunks.length} chunks`);
      console.log(`❌ Failed: ${progress.failedChunks.length} chunks`);

      // Debug: Show which chunks were completed
      console.log(
        `📋 Completed chunks: ${progress.completedChunks.join(', ')}`
      );
      console.log(`📁 Available chunks: ${chunkFiles.join(', ')}`);

      // Handle cycling mode
      if (this.config.enableCycling && chunkFiles.length > 0) {
        console.log(
          `🔄 AUTO_CHUNK_CYCLE=1: Clearing progress and starting over from first chunk...`
        );
        await this.progressStorage.clearAutoChunkProgress();

        // Re-get progress after clearing
        const freshProgress = await this.progressStorage.getAutoChunkProgress();

        // Return first chunk to restart the cycle
        const firstChunk = chunkFiles[0];
        console.log(`🔄 CYCLE: Restarting with chunk: ${firstChunk}`);
        await this.progressStorage.setCurrentChunk(firstChunk);
        return this.createChunkInfo(
          firstChunk,
          chunkFiles,
          freshProgress,
          true
        );
      }

      // All chunks completed and not cycling
      return this.createEmptyChunkInfo(progress, chunkFiles.length);
    } catch (error: any) {
      console.error(`❌ Error finding next chunk file:`, error.message);
      return this.createEmptyChunkInfo();
    }
  }

  /**
   * Mark a chunk as completed
   */
  async markChunkCompleted(chunkFileName: string): Promise<void> {
    await this.progressStorage.markChunkCompleted(chunkFileName);
  }

  /**
   * Mark a chunk as failed
   */
  async markChunkFailed(chunkFileName: string): Promise<void> {
    await this.progressStorage.markChunkFailed(chunkFileName);
  }

  /**
   * Set the current chunk being processed
   */
  async setCurrentChunk(chunkFileName: string | null): Promise<void> {
    await this.progressStorage.setCurrentChunk(chunkFileName);
  }

  /**
   * Create ChunkProgressInfo for a specific chunk
   */
  private createChunkInfo(
    chunkFileName: string,
    allChunks: string[],
    progress: any,
    isFreshStart: boolean = false
  ): ChunkProgressInfo {
    const fullPath = path.join(this.config.chunkDirectory, chunkFileName);
    const chunkNumber = this.getChunkNumber(chunkFileName);

    return {
      chunkFile: fullPath,
      currentChunkNumber: chunkNumber,
      totalChunks: allChunks.length,
      completedChunks: isFreshStart ? 0 : progress.completedChunks.length,
      failedChunks: isFreshStart ? 0 : progress.failedChunks.length,
      chunkFileName: chunkFileName,
    };
  }

  /**
   * Create empty ChunkProgressInfo when no chunks are available
   */
  private createEmptyChunkInfo(
    progress?: any,
    totalChunks: number = 0
  ): ChunkProgressInfo {
    return {
      chunkFile: null,
      currentChunkNumber: 0,
      totalChunks: totalChunks,
      completedChunks: progress?.completedChunks?.length || 0,
      failedChunks: progress?.failedChunks?.length || 0,
      chunkFileName: '',
    };
  }

  /**
   * Display chunk progress information
   */
  displayChunkProgress(chunkInfo: ChunkProgressInfo): void {
    if (!chunkInfo.chunkFile) return;

    console.log(`📦 AUTO-CHUNK PROGRESS:`);
    console.log(
      `   • Current Chunk: ${chunkInfo.chunkFileName} (${chunkInfo.currentChunkNumber}/${chunkInfo.totalChunks})`
    );
    console.log(
      `   • Completed Chunks: ${chunkInfo.completedChunks}/${chunkInfo.totalChunks}`
    );

    if (chunkInfo.failedChunks > 0) {
      console.log(
        `   • Failed Chunks: ${chunkInfo.failedChunks} (will retry after new chunks)`
      );
    }

    const progressPercent =
      chunkInfo.totalChunks > 0
        ? Math.round((chunkInfo.completedChunks / chunkInfo.totalChunks) * 100)
        : 0;
    console.log(`   • Overall Progress: ${progressPercent}% complete`);
  }
}
