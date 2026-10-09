import type { IPFSProvider, PinMetadata } from '../ipfs/provider.js';
import type { HashVerifier } from '../ipfs/verify.js';
import type { Logger } from '../logging/logger.js';
import { sleep as defaultSleep } from '../net/fetchRetry.js';

/**
 * What happened to a CID.
 * - cached:          confirmed pinned in an earlier run; no network call was made
 * - already-pinned:  the provider reports it pinned; now recorded in the cache
 * - missing:         no gateway can retrieve it, so it cannot be pinned
 * - pinned:          pinned in this run
 * - would-pin:       dry run; it exists and is not pinned
 */
export type PinOutcome =
  'cached' | 'already-pinned' | 'missing' | 'pinned' | 'would-pin';

export interface PinnedHashCache {
  isHashConfirmedPinned(cid: string): Promise<boolean>;
  recordConfirmedPinnedHash(cid: string, provider: string): Promise<void>;
}

export interface PinServiceDeps {
  cache: PinnedHashCache;
  provider: IPFSProvider;
  verifier: HashVerifier;
  logger: Logger;
  /** Pause after each provider or gateway call. */
  delayMs: number;
  dryRun: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The pin decision chain. Every layer exists to keep a job that re-walks the same
 * collections forever from hammering the provider:
 *
 *   1. persistent cache  → skip, no network
 *   2. provider lookup   → skip, record in cache (session-cached per CID)
 *   3. gateway existence → skip as missing
 *   4. pin               → record in cache
 */
export class PinService {
  private readonly sessionPinned = new Map<string, boolean>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: PinServiceDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  get providerName(): string {
    return this.deps.provider.name;
  }

  async process(cid: string, metadata: PinMetadata): Promise<PinOutcome> {
    const { cache, provider, verifier, logger, dryRun } = this.deps;

    if (await cache.isHashConfirmedPinned(cid)) {
      logger.debug('CID in confirmed-pinned cache', { cid });
      return 'cached';
    }

    let pinned = this.sessionPinned.get(cid);
    if (pinned === undefined) {
      pinned = await provider.isPinned(cid);
      this.sessionPinned.set(cid, pinned);
      await this.pause();
    }
    if (pinned) {
      await cache.recordConfirmedPinnedHash(cid, provider.name);
      logger.debug('CID already pinned on provider', { cid });
      return 'already-pinned';
    }

    const exists = await verifier.exists(cid);
    await this.pause();
    if (!exists) {
      logger.info('CID not retrievable from any gateway; skipping', { cid });
      return 'missing';
    }

    if (dryRun) {
      logger.info('[dry run] would pin', { cid });
      return 'would-pin';
    }

    await provider.pin(cid, metadata);
    await this.pause();
    this.sessionPinned.set(cid, true);
    await cache.recordConfirmedPinnedHash(cid, provider.name);
    logger.info('Pinned', { cid, provider: provider.name });
    return 'pinned';
  }

  private async pause(): Promise<void> {
    if (this.deps.delayMs > 0) await this.sleep(this.deps.delayMs);
  }
}
