import type { Logger } from '../logging/logger.js';
import type { RetryFetch } from '../net/fetchRetry.js';

export interface PinMetadata {
  name: string;
  keyvalues?: Record<string, string | number>;
}

/**
 * A pinning backend. Implementations are plain HTTP clients: the decision logic
 * (caches, existence checks, rate limiting) lives in PinService, so a provider only
 * has to answer "is this pinned?" and "pin this".
 */
export interface IPFSProvider {
  readonly name: string;
  /** True when the CID is already pinned on this provider. Must not throw on API errors. */
  isPinned(cid: string): Promise<boolean>;
  /** Pin a CID the provider fetches from the network itself. Throws when all attempts fail. */
  pin(cid: string, metadata?: PinMetadata): Promise<void>;
}

/** Counters that end up in progress.json under `apiFailures`. */
export type ApiFailureKind =
  'atomicAssets' | 'pinataList' | 'pinataPin' | 'hashVerification';

export interface ProviderDeps {
  fetch: RetryFetch;
  logger: Logger;
  /** Attempts per pin request. */
  retries: number;
  onFailure?: (kind: ApiFailureKind) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}
