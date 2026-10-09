import type { Logger } from '../logging/logger.js';
import type { ProgressReporter } from '../logging/progress.js';
import {
  extractHashesFromToken,
  fetchAndExtractTokenHashes,
} from './hashExtractor.js';
import type { PinService } from './pinService.js';
import type { HashTracker, RunStats } from './stats.js';
import type { Storage } from './storage.js';
import { tokenId, type TokenTarget } from './targets.js';

export interface TokenProcessorOptions {
  dryRun: boolean;
}

export interface TokenProcessorDeps {
  pins: PinService;
  progress: Pick<Storage, 'isTokenPinned' | 'markTokenPinned'>;
  stats: RunStats;
  tracker: HashTracker;
  logger: Logger;
  reporter: ProgressReporter;
  fetch?: typeof globalThis.fetch;
}

export type TokenHashSource = 'inline-metadata' | 'metadata-file' | 'nested';

/**
 * Pins the CIDs referenced by fungible-token metadata: anything in the inline `metadata`
 * object, the metadata file itself when `metadataUrl` points at IPFS, and every CID inside
 * that file. A token is marked done once all of its CIDs have been handled.
 */
export class TokenProcessor {
  constructor(
    private readonly options: TokenProcessorOptions,
    private readonly deps: TokenProcessorDeps
  ) {}

  async processAll(tokens: TokenTarget[]): Promise<void> {
    const bar = this.deps.reporter.bar('Tokens', tokens.length);
    let done = 0;
    for (const token of tokens) {
      const id = tokenId(token);
      bar.update(done, id);
      if (await this.deps.progress.isTokenPinned(id)) {
        this.deps.logger.info('Token already completed; skipping', {
          token: id,
        });
      } else {
        await this.processOne(token);
        if (!this.options.dryRun) await this.deps.progress.markTokenPinned(id);
      }
      done += 1;
      bar.update(done, id);
    }
    bar.stop();
  }

  async processOne(token: TokenTarget): Promise<void> {
    const id = tokenId(token);
    const log = this.deps.logger.child({ token: id });

    if (token.metadata) {
      const cids = extractHashesFromToken(token.metadata);
      log.info('CIDs in inline metadata', { count: cids.length });
      for (const cid of cids) await this.pin(cid, token, 'inline-metadata');
    }

    if (token.metadataUrl) {
      const { metadataHash, nestedHashes } = await fetchAndExtractTokenHashes(
        token.metadataUrl,
        {
          fetch: this.deps.fetch,
          logger: log,
        }
      );
      if (metadataHash) await this.pin(metadataHash, token, 'metadata-file');
      log.info('CIDs in metadata file', { count: nestedHashes.length });
      for (const cid of nestedHashes) await this.pin(cid, token, 'nested');
    }
  }

  private async pin(
    cid: string,
    token: TokenTarget,
    source: TokenHashSource
  ): Promise<void> {
    const id = tokenId(token);
    const { stats, tracker, logger } = this.deps;
    stats.tokens.hashesFound += 1;
    stats.tokens.uniqueHashes += 1;
    tracker.seen(cid, { kind: 'token', id });
    try {
      const outcome = await this.deps.pins.process(cid, {
        name: `token-${source}-${token.address.slice(0, 8)}-${cid}`,
        keyvalues: {
          tokenAddress: token.address,
          chain: token.chain,
          source: `atomic-pinner-token-${source}`,
          cid,
        },
      });
      stats.recordOutcome('tokens', outcome);
      if (outcome === 'missing')
        tracker.markNotFound({ cid, source: { kind: 'token', id } });
    } catch (error) {
      stats.tokens.failed += 1;
      logger.error('Token CID pin failed', { token: id, cid, source, error });
    }
  }
}
