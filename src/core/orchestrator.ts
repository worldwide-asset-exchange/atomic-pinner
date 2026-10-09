import * as path from 'node:path';
import { AtomicClient } from '../atomic/client.js';
import { redactConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { createProvider, createVerifier } from '../ipfs/index.js';
import type { IPFSProvider } from '../ipfs/provider.js';
import type { HashVerifier } from '../ipfs/verify.js';
import { createLogger, type Logger } from '../logging/logger.js';
import {
  createProgressReporter,
  progressEnabled,
  type ProgressReporter,
} from '../logging/progress.js';
import type { RetryFetch } from '../net/fetchRetry.js';
import {
  createNotifiers,
  notifyAll,
  type ChunkSummary,
  type Notifier,
  type RunFinishEvent,
} from '../notify/index.js';
import { ChunkManager, type ChunkProgressInfo } from './chunkManager.js';
import { CollectionProcessor, type CollectionResult } from './collections.js';
import { PinService } from './pinService.js';
import { resolveRateLimit, type RateLimit } from './rateLimit.js';
import { HashTracker, RunStats, writeHashReport } from './stats.js';
import { Storage } from './storage.js';
import { loadTargets, tokenId, type PinTargets } from './targets.js';
import { TokenProcessor } from './tokens.js';

export interface RunResult {
  success: boolean;
  dryRun: boolean;
  /** Null outside chunk mode. */
  chunk: ChunkProgressInfo | null;
  /** True when the chunk (or targets file) is fully processed. */
  completed: boolean;
  collections: CollectionResult[];
  stats: RunStats;
  reportFile?: string;
  /** Set when chunk mode found nothing to do. */
  nothingToDo?: boolean;
}

/** Everything the orchestrator talks to. Tests inject fakes; `createOrchestrator` builds the real ones. */
export interface OrchestratorDeps {
  logger: Logger;
  reporter: ProgressReporter;
  progress: Storage;
  cache: Storage;
  atomic: AtomicClient;
  provider: IPFSProvider;
  verifier: HashVerifier;
  notifiers: Notifier[];
  rateLimit: RateLimit;
  loadTargets?: (file: string) => Promise<PinTargets>;
  sleep?: (ms: number) => Promise<void>;
}

export class PinningOrchestrator {
  private readonly stats = new RunStats();
  private readonly tracker: HashTracker;
  private readonly pins: PinService;
  private readonly chunks?: ChunkManager;
  private readonly loadTargets: (file: string) => Promise<PinTargets>;

  constructor(
    private readonly config: Config,
    private readonly deps: OrchestratorDeps
  ) {
    this.tracker = new HashTracker({
      trackUnique: config.tracking.uniqueHashes,
      trackNotFound: config.tracking.notFoundHashes,
    });
    this.pins = new PinService({
      cache: deps.cache,
      provider: deps.provider,
      verifier: deps.verifier,
      logger: deps.logger.child({ component: 'pin' }),
      delayMs: deps.rateLimit.delayMs,
      dryRun: config.processing.dryRun,
      sleep: deps.sleep,
    });
    if (config.chunks.enabled) {
      this.chunks = new ChunkManager(
        {
          chunkDirectory: config.chunks.directory,
          chunkPrefix: config.chunks.prefix,
          enableCycling: config.chunks.cycle,
        },
        deps.progress,
        deps.logger.child({ component: 'chunks' })
      );
    }
    this.loadTargets = deps.loadTargets ?? loadTargets;
  }

  async run(): Promise<RunResult> {
    const { config, deps } = this;
    const log = deps.logger;
    const startedAt = new Date(this.stats.startedAt).toISOString();

    log.info('atomic-pinner starting', {
      provider: deps.provider.name,
      dryRun: config.processing.dryRun,
      chunkMode: config.chunks.enabled,
      plan: deps.rateLimit.plan,
      delayMs: deps.rateLimit.delayMs,
      batchSize: deps.rateLimit.batchSize,
    });
    log.debug('Effective configuration', { config: redactConfig(config) });

    if (config.processing.freshStart) {
      log.warn(
        'FRESH_START: clearing progress (the confirmed-pinned cache is kept)'
      );
      await deps.progress.clearAllProgress();
    }

    const { targets, chunk } = await this.selectTargets();
    if (!targets) {
      log.info('Nothing to do');
      return {
        success: true,
        dryRun: config.processing.dryRun,
        chunk,
        completed: true,
        collections: [],
        stats: this.stats,
        nothingToDo: true,
      };
    }

    const chunkSummary = chunk ? toSummary(chunk) : undefined;
    await notifyAll(deps.notifiers, {
      event: 'start',
      startedAt,
      dryRun: config.processing.dryRun,
      provider: deps.provider.name,
      targetsFile: chunk?.chunkFile ?? config.targets.file,
      chunk: chunkSummary,
      collections: targets.collection.length,
      tokens: targets.token.length,
    });

    let collections: CollectionResult[] = [];
    let error: Error | undefined;
    let completed = false;
    let reportFile: string | undefined;

    try {
      if (config.processing.collections && targets.collection.length > 0) {
        collections = await this.collectionProcessor().processAll(
          targets.collection
        );
      }
      if (config.processing.tokens && targets.token.length > 0) {
        await this.tokenProcessor().processAll(targets.token);
      }

      completed = await this.isComplete(targets);
      if (chunk && completed && !config.processing.dryRun) {
        await this.chunks!.markChunkCompleted(chunk.chunkFileName);
        log.info('Chunk completed', { chunk: chunk.chunkFileName });
      } else if (chunk && !completed) {
        log.info('Chunk not finished; it will resume next run', {
          chunk: chunk.chunkFileName,
        });
      }

      if (config.tracking.saveReport) {
        reportFile = await writeHashReport(
          config.tracking.reportDir,
          this.tracker.report()
        );
        log.info('Hash report written', { file: reportFile });
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      log.error('Run failed', { error: error.message });
      if (chunk) await this.chunks!.markChunkFailed(chunk.chunkFileName);
    }

    this.logSummary(error);

    const finish: RunFinishEvent = {
      event: 'finish',
      startedAt,
      finishedAt: new Date().toISOString(),
      runtimeMs: this.stats.runtimeMs,
      success: !error,
      error: error?.message,
      dryRun: config.processing.dryRun,
      provider: deps.provider.name,
      chunk: chunkSummary,
      chunkCompleted: chunk ? completed : undefined,
      totals: this.stats.totals(),
      collections: this.stats.collections,
      tokens: this.stats.tokens,
      uniqueHashes: this.tracker.uniqueCount,
      notFoundHashes: this.tracker.notFoundCount,
      apiFailures: await deps.progress.getApiFailures(),
      reportFile,
    };
    await notifyAll(deps.notifiers, finish);

    if (error) throw error;
    return {
      success: true,
      dryRun: config.processing.dryRun,
      chunk,
      completed,
      collections,
      stats: this.stats,
      reportFile,
    };
  }

  private async selectTargets(): Promise<{
    targets: PinTargets | null;
    chunk: ChunkProgressInfo | null;
  }> {
    if (!this.chunks) {
      const targets = await this.loadTargets(this.config.targets.file);
      this.deps.logger.info('Loaded targets', {
        file: this.config.targets.file,
        collections: targets.collection.length,
        tokens: targets.token.length,
      });
      return { targets, chunk: null };
    }

    const chunk = await this.chunks.findNextChunkFile();
    if (!chunk.chunkFile) return { targets: null, chunk };
    try {
      const targets = await this.loadTargets(chunk.chunkFile);
      this.deps.logger.info('Loaded chunk', {
        chunk: chunk.chunkFileName,
        number: chunk.currentChunkNumber,
        of: chunk.totalChunks,
        collections: targets.collection.length,
        tokens: targets.token.length,
      });
      return { targets, chunk };
    } catch (error) {
      this.deps.logger.error(
        'Chunk file could not be loaded; marking it failed',
        {
          chunk: chunk.chunkFileName,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      await this.chunks.markChunkFailed(chunk.chunkFileName);
      return { targets: null, chunk };
    }
  }

  /**
   * True when every collection in the targets is in pinnedCollections (or is paused on a page
   * with nothing after it) and every token is marked done. Dry runs never complete anything.
   */
  async isComplete(targets: PinTargets): Promise<boolean> {
    if (this.config.processing.dryRun) return false;
    const { progress, atomic, logger } = this.deps;

    if (this.config.processing.collections) {
      for (const name of targets.collection) {
        if (await progress.getPinnedCollection(name)) continue;
        const pinning = await progress.getPinningCollection(name);
        if (!pinning) {
          logger.debug('Collection not started', { collection: name });
          return false;
        }
        const more =
          (
            await atomic.getAssetsPage({
              collectionName: name,
              page: pinning.page,
              limit: 1,
            })
          ).length > 0;
        if (more) {
          logger.debug('Collection has more pages', {
            collection: name,
            nextPage: pinning.page,
          });
          return false;
        }
      }
    }

    if (this.config.processing.tokens) {
      for (const token of targets.token) {
        if (!(await progress.isTokenPinned(tokenId(token)))) {
          logger.debug('Token not finished', { token: tokenId(token) });
          return false;
        }
      }
    }
    return true;
  }

  private collectionProcessor(): CollectionProcessor {
    const { config, deps } = this;
    return new CollectionProcessor(
      {
        dryRun: config.processing.dryRun,
        dryRunLimit: config.processing.dryRunLimit,
        maxPagesPerCollection: config.processing.maxPagesPerCollection,
        batchSize: deps.rateLimit.batchSize,
        delayMs: deps.rateLimit.delayMs,
      },
      {
        atomic: deps.atomic,
        pins: this.pins,
        progress: deps.progress,
        stats: this.stats,
        tracker: this.tracker,
        logger: deps.logger.child({ component: 'collections' }),
        reporter: deps.reporter,
        sleep: deps.sleep,
      }
    );
  }

  private tokenProcessor(): TokenProcessor {
    return new TokenProcessor(
      { dryRun: this.config.processing.dryRun },
      {
        pins: this.pins,
        progress: this.deps.progress,
        stats: this.stats,
        tracker: this.tracker,
        logger: this.deps.logger.child({ component: 'tokens' }),
        reporter: this.deps.reporter,
      }
    );
  }

  private logSummary(error?: Error): void {
    const t = this.stats.totals();
    const label = this.config.processing.dryRun ? 'wouldPin' : 'pinned';
    this.deps.logger.info(error ? 'Run finished with errors' : 'Run finished', {
      runtime: `${Math.round(this.stats.runtimeMs / 1000)}s`,
      found: t.hashesFound,
      unique: t.uniqueHashes,
      [label]: t.pinned,
      alreadyPinned: t.alreadyPinned,
      missing: t.missing,
      failed: t.failed,
      duplicatesAvoided: t.duplicatesAvoided,
    });
  }
}

function toSummary(chunk: ChunkProgressInfo): ChunkSummary {
  return {
    chunkFileName: chunk.chunkFileName,
    currentChunkNumber: chunk.currentChunkNumber,
    totalChunks: chunk.totalChunks,
    completedChunks: chunk.completedChunks,
    failedChunks: chunk.failedChunks,
  };
}

export interface CreateOrchestratorOptions {
  logger?: Logger;
  /** Override the HTTP client used for every outbound call (tests). */
  fetch?: RetryFetch;
  overrides?: Partial<OrchestratorDeps>;
}

/** Wire the real dependencies from a Config. */
export function createOrchestrator(
  config: Config,
  options: CreateOrchestratorOptions = {}
): PinningOrchestrator {
  const logger =
    options.logger ??
    createLogger({
      level: config.logging.level,
      format: config.logging.format,
    });
  const progress = new Storage(
    path.resolve(config.state.progressFile),
    logger.child({ component: 'progress' })
  );
  const cache = new Storage(
    path.resolve(config.state.cacheFile),
    logger.child({ component: 'cache' })
  );
  const onFailure = (kind: Parameters<Storage['recordApiFailure']>[0]) =>
    progress.recordApiFailure(kind);
  const ipfsDeps = { logger, onFailure, fetch: options.fetch };

  const deps: OrchestratorDeps = {
    logger,
    reporter: createProgressReporter({
      enabled:
        progressEnabled(config.logging.progress) &&
        config.logging.level !== 'silent' &&
        config.logging.format === 'text',
    }),
    progress,
    cache,
    atomic: new AtomicClient(
      {
        apiUrl: config.atomic.apiUrl,
        pageSize: config.atomic.pageSize,
        timeoutMs: config.atomic.timeoutMs,
        retries: config.atomic.retries,
        retryAttempts: config.atomic.retryAttempts,
        retryBaseDelayMs: config.atomic.retryBaseDelayMs,
      },
      {
        logger: logger.child({ component: 'atomic' }),
        onFailure,
        fetch: options.fetch,
      }
    ),
    provider: createProvider(config, ipfsDeps),
    verifier: createVerifier(config, ipfsDeps),
    notifiers: createNotifiers(config, { logger, fetch: options.fetch }),
    rateLimit: resolveRateLimit({
      plan: config.provider.pinataPlan,
      delayMs: config.rateLimit.delayMs,
      batchSize: config.rateLimit.batchSize,
    }),
    ...options.overrides,
  };
  return new PinningOrchestrator(config, deps);
}
