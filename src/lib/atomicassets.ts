import { AtomicAssetsAPIClient, Types } from '@wharfkit/atomicassets';
import { APIClient } from '@wharfkit/antelope';
import { Storage } from './Storage.js';
import { createRetryFetch } from './fetchRetry.js';
import { safeEnv } from './envParser.js';

// Configuration from environment variables
const ATOMIC_API_TIMEOUT = safeEnv.number(
  process.env.ATOMIC_API_TIMEOUT_MS,
  60000,
  10000,
  300000
); // 10s to 5m
const ATOMIC_API_RETRIES = safeEnv.number(
  process.env.ATOMIC_API_RETRIES,
  10,
  1,
  50
); // 1 to 50 retries
const ATOMIC_RETRY_MAX_ATTEMPTS = safeEnv.number(
  process.env.ATOMIC_RETRY_MAX_ATTEMPTS,
  3,
  1,
  10
); // 1 to 10 attempts
const ATOMIC_RETRY_BASE_DELAY = safeEnv.number(
  process.env.ATOMIC_RETRY_BASE_DELAY_MS,
  1000,
  100,
  10000
); // 100ms to 10s

// Transport-level retries (per HTTP request). Application-level retries live in executeWithRetry below.
const fetch = createRetryFetch({
  retries: ATOMIC_API_RETRIES,
  timeoutMs: ATOMIC_API_TIMEOUT,
  onRetry: (message) => console.warn(`AtomicAssets API retry: ${message}`),
});
class Atomic {
  client: AtomicAssetsAPIClient;
  limit: number;
  storage: Storage | null = null;
  private maxRetries: number = ATOMIC_RETRY_MAX_ATTEMPTS;
  private baseDelay: number = ATOMIC_RETRY_BASE_DELAY;

  constructor(url: string, storage?: Storage) {
    this.client = new AtomicAssetsAPIClient(
      new APIClient({
        url,
        fetch,
      })
    );
    this.limit = 1000;
    this.storage = storage || null;

    // Log configuration on startup for debugging
    console.log(`AtomicAssets Client Configuration:`);
    console.log(`  • API Timeout: ${ATOMIC_API_TIMEOUT}ms`);
    console.log(`  • Fetch Retries: ${ATOMIC_API_RETRIES}`);
    console.log(`  • Max Retry Attempts: ${this.maxRetries}`);
    console.log(`  • Base Retry Delay: ${this.baseDelay}ms`);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const message = error.message?.toLowerCase() || '';
    const code = error.code?.toUpperCase() || '';

    // Network-related errors that should be retried
    const retryableErrorTypes = [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'ABORT',
    ];

    const retryableMessages = [
      'timeout',
      'network error',
      'connection reset',
      'fetch failed',
      'request timeout',
    ];

    return (
      retryableErrorTypes.includes(code) ||
      retryableMessages.some((msg) => message.includes(msg)) ||
      error.name === 'AbortError'
    );
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    retries: number = this.maxRetries
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (this.storage) {
          await this.storage.recordApiFailure('atomicAssets');
        }

        console.error(
          `${operationName} failed (attempt ${attempt}/${retries + 1}):`,
          error.message
        );

        if (attempt === retries + 1 || !this.isRetryableError(error)) {
          console.error(
            `${operationName} failed permanently after ${attempt} attempts`
          );
          throw error;
        }

        // Exponential backoff with jitter
        const delay =
          this.baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        console.log(
          `Retrying ${operationName} in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries + 1})`
        );
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  async getAssetsPage(options: any) {
    let page = options.page;

    return this.executeWithRetry(async () => {
      const res = await this.client.atomicassets.v1.get_assets({
        ...options,
        limit: this.limit,
        page,
      });
      return res.data;
    }, `getAssetsPage (page ${page})`);
  }

  async getAssets(options: any) {
    let assets: Types.AssetObject[] = [];
    let limit = 1000;
    let page = 1;

    // Get total count with retry logic
    let count = 0;
    try {
      count = await this.executeWithRetry(async () => {
        const countRes =
          await this.client.atomicassets.v1.get_assets_count(options);
        return countRes.data.toNumber() || 0;
      }, 'getAssetsCount');

      console.log(`Server count: ${count}`);
      if (count === 0) {
        return assets;
      }
    } catch (error) {
      console.log(
        `Warning: Could not get asset count, continuing with pagination:`,
        (error as Error).message
      );
      // Continue without count - we'll paginate until we get no more results
    }

    // Fetch assets with retry logic
    do {
      const pageAssets = await this.executeWithRetry(async () => {
        const res = await this.client.atomicassets.v1.get_assets({
          ...options,
          limit,
          page,
        });
        return res.data;
      }, `getAssets (page ${page})`);

      if (pageAssets.length === 0) {
        break;
      }

      assets = assets.concat(pageAssets);
      console.log(`Got: ${assets.length} assets`);
      page++;
    } while (true);

    if (count && assets.length !== count) {
      console.warn(
        `Expected ${count} assets, got ${assets.length} - this may be due to concurrent changes in the collection`
      );
    }
    return assets;
  }

  async getAssetsForAccount(
    account: string,
    collections: string[],
    assetIds: string[]
  ) {
    return this.getAssets({
      owner: [account],
      collection_name: collections,
      ids: assetIds,
    });
  }

  async getAssetsForCollection(
    collection: string,
    schemas: string[],
    templates: string[],
    assetIds: string[]
  ) {
    return this.getAssets({
      collection_name: collection,
      templates: templates,
      schemas: schemas,
      ids: assetIds,
    });
  }
}

export default Atomic;
