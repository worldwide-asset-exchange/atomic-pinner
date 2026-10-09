import type { ApiFailureKind } from '../ipfs/provider.js';
import type { Logger } from '../logging/logger.js';
import {
  createRetryFetch,
  sleep as defaultSleep,
  type RetryFetch,
} from '../net/fetchRetry.js';

/** The subset of an AtomicAssets `/v1/assets` row this tool reads. */
export interface AtomicAsset {
  asset_id: string;
  owner: string;
  name?: string;
  collection: { collection_name: string };
  schema?: { schema_name: string };
  template?: {
    template_id: string;
    immutable_data?: Record<string, unknown>;
  } | null;
  immutable_data?: Record<string, unknown>;
  mutable_data?: Record<string, unknown>;
  data?: Record<string, unknown>;
  backed_tokens?: unknown[];
}

export interface AtomicClientOptions {
  apiUrl: string;
  pageSize: number;
  timeoutMs: number;
  /** HTTP attempts per request. */
  retries: number;
  /** Attempts per page on top of HTTP retries, for API-level errors. */
  retryAttempts: number;
  retryBaseDelayMs: number;
}

export interface AtomicClientDeps {
  logger: Logger;
  fetch?: RetryFetch;
  onFailure?: (kind: ApiFailureKind) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface AssetsPageQuery {
  collectionName: string;
  page: number;
  /** Override the configured page size (dry runs ask for fewer). */
  limit?: number;
}

export class AtomicApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'AtomicApiError';
  }
}

/**
 * Minimal AtomicAssets API client. Pages are requested in ascending asset_id order so a
 * resumed run sees a stable sequence even while the collection is still minting.
 */
export class AtomicClient {
  private readonly fetch: RetryFetch;
  private readonly base: string;

  constructor(
    private readonly options: AtomicClientOptions,
    private readonly deps: AtomicClientDeps
  ) {
    this.base = options.apiUrl.replace(/\/$/, '');
    this.fetch =
      deps.fetch ??
      createRetryFetch({
        retries: options.retries,
        timeoutMs: options.timeoutMs,
        onRetry: (message) =>
          deps.logger.debug('AtomicAssets request retry', { message }),
      });
  }

  get pageSize(): number {
    return this.options.pageSize;
  }

  async getAssetsPage(query: AssetsPageQuery): Promise<AtomicAsset[]> {
    const params = new URLSearchParams({
      collection_name: query.collectionName,
      page: String(query.page),
      limit: String(query.limit ?? this.options.pageSize),
      sort: 'asset_id',
      order: 'asc',
    });
    const url = `${this.base}/atomicassets/v1/assets?${params}`;
    return this.withRetry(
      `assets page ${query.page} of ${query.collectionName}`,
      async () => {
        const response = await this.fetch(url, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new AtomicApiError(
            `AtomicAssets API responded ${response.status}`,
            response.status
          );
        }
        const body = (await response.json()) as {
          success?: boolean;
          data?: AtomicAsset[];
          message?: string;
        };
        if (body.success === false || !Array.isArray(body.data)) {
          throw new AtomicApiError(
            `AtomicAssets API error: ${body.message ?? 'malformed response'}`
          );
        }
        return body.data;
      }
    );
  }

  /** True when the collection has at least one asset on the given page. */
  async hasAssetsOnPage(
    collectionName: string,
    page: number
  ): Promise<boolean> {
    const assets = await this.getAssetsPage({ collectionName, page, limit: 1 });
    return assets.length > 0;
  }

  private async withRetry<T>(
    what: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const sleep = this.deps.sleep ?? defaultSleep;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.retryAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        await this.deps.onFailure?.('atomicAssets');
        const status =
          error instanceof AtomicApiError ? error.status : undefined;
        const retryable =
          status === undefined || status >= 500 || status === 429;
        const last = attempt === this.options.retryAttempts;
        this.deps.logger.warn(`AtomicAssets ${what} failed`, {
          attempt,
          of: this.options.retryAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!retryable || last) break;
        const delay =
          this.options.retryBaseDelayMs * 2 ** (attempt - 1) +
          Math.random() * 1000;
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
