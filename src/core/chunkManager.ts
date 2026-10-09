import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { silentLogger, type Logger } from '../logging/logger.js';
import type { AutoChunkProgress, Storage } from './storage.js';

export interface ChunkProgressInfo {
  /** Full path of the chunk to process, or null when there is nothing to do. */
  chunkFile: string | null;
  chunkFileName: string;
  currentChunkNumber: number;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
}

export interface ChunkManagerConfig {
  chunkDirectory: string;
  chunkPrefix: string;
  enableCycling: boolean;
}

export type ChunkStore = Pick<
  Storage,
  | 'getAutoChunkProgress'
  | 'setCurrentChunk'
  | 'markChunkCompleted'
  | 'markChunkFailed'
  | 'clearAutoChunkProgress'
>;

/**
 * Picks the chunk file a run should process.
 *
 * Order: resume the current chunk if it is unfinished; otherwise the first chunk that is
 * neither completed nor failed; then failed chunks are retried; then, with cycling on,
 * progress is cleared and the first chunk starts again. Without cycling the run has nothing
 * to do and exits.
 */
export class ChunkManager {
  constructor(
    private readonly config: ChunkManagerConfig,
    private readonly store: ChunkStore,
    private readonly logger: Logger = silentLogger
  ) {}

  private chunkNumber(fileName: string): number {
    const match = fileName.match(
      new RegExp(`${escapeRegExp(this.config.chunkPrefix)}-(\\d+)\\.json$`)
    );
    return match ? parseInt(match[1], 10) : 0;
  }

  async findChunkFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.config.chunkDirectory);
      const pattern = new RegExp(
        `^${escapeRegExp(this.config.chunkPrefix)}-\\d+\\.json$`
      );
      return files.filter((f) => pattern.test(f)).sort();
    } catch (error) {
      this.logger.warn('Cannot read chunk directory', {
        directory: this.config.chunkDirectory,
        error,
      });
      return [];
    }
  }

  async chunkFileExists(fileName: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.config.chunkDirectory, fileName));
      return true;
    } catch {
      return false;
    }
  }

  async findNextChunkFile(): Promise<ChunkProgressInfo> {
    try {
      const progress = await this.store.getAutoChunkProgress();
      const chunkFiles = await this.findChunkFiles();
      this.logger.debug('Selecting chunk', {
        current: progress.currentChunk,
        completed: progress.completedChunks.length,
        failed: progress.failedChunks.length,
        available: chunkFiles.length,
      });

      if (chunkFiles.length === 0) {
        this.logger.warn('No chunk files found', {
          directory: this.config.chunkDirectory,
          prefix: this.config.chunkPrefix,
        });
        return this.emptyInfo(progress);
      }

      if (progress.currentChunk) {
        if (progress.completedChunks.includes(progress.currentChunk)) {
          this.logger.info('Current chunk already complete, moving on', {
            chunk: progress.currentChunk,
          });
          progress.currentChunk = null;
          await this.store.setCurrentChunk(null);
        } else if (chunkFiles.includes(progress.currentChunk)) {
          this.logger.info('Resuming current chunk', {
            chunk: progress.currentChunk,
          });
          return this.info(progress.currentChunk, chunkFiles, progress);
        } else {
          this.logger.warn('Current chunk file no longer exists', {
            chunk: progress.currentChunk,
          });
          progress.currentChunk = null;
          await this.store.setCurrentChunk(null);
        }
      }

      for (const file of chunkFiles) {
        if (
          progress.completedChunks.includes(file) ||
          progress.failedChunks.includes(file)
        )
          continue;
        this.logger.info('Next chunk selected', { chunk: file });
        await this.store.setCurrentChunk(file);
        return this.info(file, chunkFiles, progress);
      }

      for (const failed of progress.failedChunks) {
        if (await this.chunkFileExists(failed)) {
          this.logger.info('Retrying previously failed chunk', {
            chunk: failed,
          });
          await this.store.setCurrentChunk(failed);
          return this.info(failed, chunkFiles, progress);
        }
      }

      this.logger.info('All chunks complete', {
        completed: progress.completedChunks.length,
        failed: progress.failedChunks.length,
      });

      if (this.config.enableCycling) {
        this.logger.info(
          'Cycling: clearing chunk progress and restarting from the first chunk'
        );
        await this.store.clearAutoChunkProgress();
        const fresh = await this.store.getAutoChunkProgress();
        await this.store.setCurrentChunk(chunkFiles[0]);
        return this.info(chunkFiles[0], chunkFiles, fresh, true);
      }

      return this.emptyInfo(progress, chunkFiles.length);
    } catch (error) {
      this.logger.error('Failed to select next chunk', { error });
      return this.emptyInfo();
    }
  }

  async markChunkCompleted(fileName: string): Promise<void> {
    await this.store.markChunkCompleted(fileName);
  }

  async markChunkFailed(fileName: string): Promise<void> {
    await this.store.markChunkFailed(fileName);
  }

  async setCurrentChunk(fileName: string | null): Promise<void> {
    await this.store.setCurrentChunk(fileName);
  }

  private info(
    fileName: string,
    all: string[],
    progress: AutoChunkProgress,
    fresh = false
  ): ChunkProgressInfo {
    return {
      chunkFile: path.join(this.config.chunkDirectory, fileName),
      chunkFileName: fileName,
      currentChunkNumber: this.chunkNumber(fileName),
      totalChunks: all.length,
      completedChunks: fresh ? 0 : progress.completedChunks.length,
      failedChunks: fresh ? 0 : progress.failedChunks.length,
    };
  }

  private emptyInfo(
    progress?: AutoChunkProgress,
    totalChunks = 0
  ): ChunkProgressInfo {
    return {
      chunkFile: null,
      chunkFileName: '',
      currentChunkNumber: 0,
      totalChunks,
      completedChunks: progress?.completedChunks.length ?? 0,
      failedChunks: progress?.failedChunks.length ?? 0,
    };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
