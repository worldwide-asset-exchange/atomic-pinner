import type { AtomicAsset, AtomicClient } from '../atomic/client.js';
import type { Logger } from '../logging/logger.js';
import type { ProgressReporter } from '../logging/progress.js';
import { sleep as defaultSleep } from '../net/fetchRetry.js';
import { extractHashesFromAsset } from './hashExtractor.js';
import type { PinService } from './pinService.js';
import type { HashTracker, RunStats } from './stats.js';
import type { Storage } from './storage.js';

export interface CollectionProcessorOptions {
  dryRun: boolean;
  /** Assets inspected per collection in a dry run; -1 = whole first page. */
  dryRunLimit: number;
  /** Pages per collection per run; -1 = unlimited. */
  maxPagesPerCollection: number;
  batchSize: number;
  delayMs: number;
}

export interface CollectionProcessorDeps {
  atomic: Pick<AtomicClient, 'getAssetsPage' | 'pageSize'>;
  pins: PinService;
  progress: Pick<
    Storage,
    | 'getPinnedCollection'
    | 'getPinningCollection'
    | 'pinningCollection'
    | 'pinnedCollection'
    | 'updateCollectionProgress'
  >;
  stats: RunStats;
  tracker: HashTracker;
  logger: Logger;
  reporter: ProgressReporter;
  sleep?: (ms: number) => Promise<void>;
}

export type CollectionStopReason =
  'completed' | 'page-limit' | 'dry-run' | 'already-completed';

export interface CollectionResult {
  collection: string;
  reason: CollectionStopReason;
  pagesThisRun: number;
  assetsThisRun: number;
}

interface AssetRef {
  assetId: string;
  collectionName: string;
  schemaName?: string;
  templateId?: string;
  assetName?: string;
}

/**
 * Walks a collection page by page, extracts CIDs, dedupes them per page and sends each
 * through the PinService. Progress is written after every page so a run can stop at any
 * point and resume at the same page.
 */
export class CollectionProcessor {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly options: CollectionProcessorOptions,
    private readonly deps: CollectionProcessorDeps
  ) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async processAll(collections: string[]): Promise<CollectionResult[]> {
    const results: CollectionResult[] = [];
    const bar = this.deps.reporter.bar('Collections', collections.length);
    for (const name of collections) {
      bar.update(results.length, name);
      results.push(await this.processOne(name));
      bar.update(results.length, name);
    }
    bar.stop();
    return results;
  }

  async processOne(collection: string): Promise<CollectionResult> {
    const { progress, logger } = this.deps;
    const log = logger.child({ collection });

    if (await progress.getPinnedCollection(collection)) {
      log.info('Collection already completed; skipping');
      return {
        collection,
        reason: 'already-completed',
        pagesThisRun: 0,
        assetsThisRun: 0,
      };
    }

    let page = 1;
    let totalAssets = 0;
    let totalCompleted = 0;
    let totalFailed = 0;

    const resume = await progress.getPinningCollection(collection);
    if (resume) {
      page = resume.page;
      totalAssets = resume.assets;
      totalCompleted = resume.completed ?? 0;
      totalFailed = resume.failed ?? 0;
      log.info('Resuming collection', { page, assets: totalAssets });
    } else {
      log.info('Starting collection');
    }

    const { dryRun, dryRunLimit, maxPagesPerCollection } = this.options;
    const limit =
      dryRun && dryRunLimit > 0
        ? Math.min(dryRunLimit, this.deps.atomic.pageSize)
        : undefined;
    let pagesThisRun = 0;
    let assetsThisRun = 0;
    let reason: CollectionStopReason = 'completed';

    for (;;) {
      const assets = await this.deps.atomic.getAssetsPage({
        collectionName: collection,
        page,
        limit,
      });
      if (assets.length === 0) {
        log.debug('No more assets', { page });
        break;
      }
      log.info('Processing page', { page, assets: assets.length });

      const { completed, failed } = await this.processPage(collection, assets);

      page += 1;
      pagesThisRun += 1;
      assetsThisRun += assets.length;
      totalAssets += assets.length;
      totalCompleted += completed.length;
      totalFailed += failed.length;

      if (dryRun) {
        log.info('[dry run] stopping after first page');
        reason = 'dry-run';
        break;
      }

      await progress.updateCollectionProgress(collection, completed, failed);
      await progress.pinningCollection(
        collection,
        totalAssets,
        page,
        totalCompleted,
        totalFailed
      );

      if (maxPagesPerCollection > 0 && pagesThisRun >= maxPagesPerCollection) {
        log.info(
          'Page limit reached for this run; collection will resume next run',
          {
            pages: pagesThisRun,
            nextPage: page,
          }
        );
        reason = 'page-limit';
        break;
      }
    }

    if (reason === 'completed') {
      await progress.pinnedCollection(
        collection,
        totalAssets,
        page,
        totalCompleted,
        totalFailed
      );
      log.info('Collection completed', {
        assets: totalAssets,
        completed: totalCompleted,
        failed: totalFailed,
      });
    }
    return { collection, reason, pagesThisRun, assetsThisRun };
  }

  private async processPage(
    collection: string,
    assets: AtomicAsset[]
  ): Promise<{
    completed: Array<{ assetId: string; hash: string }>;
    failed: Array<{ assetId: string; hash: string; error: string }>;
  }> {
    const { stats, tracker, logger } = this.deps;
    const phase = stats.collections;
    const log = logger.child({ collection });

    const cidToAssets = new Map<string, AssetRef[]>();
    let found = 0;
    for (const asset of assets) {
      const cids = extractHashesFromAsset(asset);
      if (cids.length === 0) continue;
      const ref: AssetRef = {
        assetId: String(asset.asset_id),
        collectionName: asset.collection?.collection_name ?? collection,
        schemaName: asset.schema?.schema_name,
        templateId: asset.template?.template_id,
        assetName: asset.name ?? (asset.data?.name as string | undefined),
      };
      for (const cid of cids) {
        found += 1;
        let refs = cidToAssets.get(cid);
        if (!refs) {
          refs = [];
          cidToAssets.set(cid, refs);
        }
        refs.push(ref);
        tracker.seen(cid, {
          kind: 'collection',
          id: collection,
          assetId: ref.assetId,
        });
      }
    }

    phase.hashesFound += found;
    phase.uniqueHashes += cidToAssets.size;
    phase.duplicatesAvoided += found - cidToAssets.size;
    if (cidToAssets.size === 0) {
      log.debug('No CIDs on this page');
      return { completed: [], failed: [] };
    }
    log.info('CIDs on page', { found, unique: cidToAssets.size });

    const completed: Array<{ assetId: string; hash: string }> = [];
    const failed: Array<{ assetId: string; hash: string; error: string }> = [];
    const cids = [...cidToAssets.keys()];
    const bar = this.deps.reporter.bar(`${collection} CIDs`, cids.length);

    try {
      for (let i = 0; i < cids.length; i += this.options.batchSize) {
        const batch = cids.slice(i, i + this.options.batchSize);
        for (const cid of batch) {
          const refs = cidToAssets.get(cid)!;
          try {
            const outcome = await this.deps.pins.process(cid, {
              name: `${collection}-${cid}`,
              keyvalues: {
                collection,
                assetCount: refs.length,
                source: 'atomic-pinner',
                cid,
              },
            });
            stats.recordOutcome('collections', outcome);
            if (outcome === 'missing') {
              for (const ref of refs) {
                tracker.markNotFound({
                  cid,
                  source: {
                    kind: 'collection',
                    id: collection,
                    assetId: ref.assetId,
                  },
                  schemaName: ref.schemaName,
                  templateId: ref.templateId,
                  assetName: ref.assetName,
                });
              }
            }
            for (const ref of refs)
              completed.push({ assetId: ref.assetId, hash: cid });
            bar.increment(cid.slice(0, 12));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            log.error('Pin failed', { cid, error: message });
            phase.failed += 1;
            for (const ref of refs)
              failed.push({ assetId: ref.assetId, hash: cid, error: message });
            bar.increment(`failed ${cid.slice(0, 12)}`);
          }
        }
        if (
          i + this.options.batchSize < cids.length &&
          this.options.delayMs > 0
        ) {
          await this.sleep(this.options.delayMs * 2);
        }
      }
    } finally {
      bar.stop();
    }
    return { completed, failed };
  }
}
