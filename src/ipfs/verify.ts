import type { Logger } from '../logging/logger.js';
import type { RetryFetch } from '../net/fetchRetry.js';
import type { ApiFailureKind } from './provider.js';

export interface HashVerifier {
  /** True when at least one gateway can serve the CID. Results are cached per process. */
  exists(cid: string): Promise<boolean>;
}

export interface VerifierOptions {
  /** Tried in order. */
  gateways: string[];
  /** Sent as a bearer token to gateways on pinata.cloud, which rate-limit anonymous requests harder. */
  pinataJwt?: string;
  fetch: RetryFetch;
  logger: Logger;
  onFailure?: (kind: ApiFailureKind) => void | Promise<void>;
}

const RETRY_WITH_GET = new Set([404, 405, 500, 504]);

/**
 * Existence check across public gateways.
 *
 * A HEAD that answers 2xx or a redirect counts as found (directories often redirect). When HEAD
 * fails with a status some gateways return for directories, a ranged GET is tried. A 429 moves on
 * to the next gateway. A CID is only reported missing after every gateway has said so or failed.
 */
export function createHashVerifier(options: VerifierOptions): HashVerifier {
  const cache = new Map<string, boolean>();
  const gateways = options.gateways.map((g) => g.replace(/\/$/, ''));

  const headersFor = (gateway: string): Record<string, string> => {
    const headers: Record<string, string> = { 'User-Agent': 'atomic-pinner' };
    if (options.pinataJwt && gateway.includes('pinata.cloud')) {
      headers.Authorization = `Bearer ${options.pinataJwt}`;
    }
    return headers;
  };

  async function checkGateway(
    cid: string,
    gateway: string
  ): Promise<'found' | 'missing' | 'unavailable'> {
    const url = `${gateway}/ipfs/${cid}`;
    const headers = headersFor(gateway);
    const head = await options.fetch(url, {
      method: 'HEAD',
      headers,
      redirect: 'manual',
    });

    if (head.ok || (head.status >= 300 && head.status < 400)) return 'found';
    if (head.status === 429) return 'unavailable';
    if (!RETRY_WITH_GET.has(head.status)) return 'missing';

    const get = await options.fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-1023' },
    });
    if (get.ok) return 'found';
    if (get.status === 429) return 'unavailable';
    return 'missing';
  }

  return {
    async exists(cid) {
      const cached = cache.get(cid);
      if (cached !== undefined) return cached;

      let sawDefinitiveMiss = false;
      for (const gateway of gateways) {
        try {
          const result = await checkGateway(cid, gateway);
          if (result === 'found') {
            options.logger.debug('CID retrievable', { cid, gateway });
            cache.set(cid, true);
            return true;
          }
          if (result === 'missing') sawDefinitiveMiss = true;
          options.logger.debug(`CID ${result} on gateway`, { cid, gateway });
        } catch (error) {
          options.logger.debug('Gateway check errored', {
            cid,
            gateway,
            error,
          });
        }
      }

      if (!sawDefinitiveMiss) {
        // Every gateway was rate limited or unreachable: that is an API failure, not missing content.
        await options.onFailure?.('hashVerification');
        options.logger.warn(
          'No gateway could be reached to verify CID; treating as missing for this run',
          { cid }
        );
      }
      cache.set(cid, false);
      return false;
    },
  };
}
