import { sleep as defaultSleep } from '../net/fetchRetry.js';
import {
  type IPFSProvider,
  type PinMetadata,
  type ProviderDeps,
  ProviderError,
  readErrorBody,
} from './provider.js';

export interface KuboOptions {
  /** Kubo RPC API, e.g. http://127.0.0.1:5001 */
  apiUrl: string;
}

interface PinLsResponse {
  Keys?: Record<string, unknown>;
}

/** Pins to a Kubo (go-ipfs) node through its RPC API. */
export class KuboProvider implements IPFSProvider {
  readonly name = 'kubo';
  private readonly apiUrl: string;

  constructor(
    options: KuboOptions,
    private readonly deps: ProviderDeps
  ) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
  }

  async isPinned(cid: string): Promise<boolean> {
    const url = `${this.apiUrl}/api/v0/pin/ls?arg=${encodeURIComponent(cid)}&type=recursive`;
    try {
      const response = await this.deps.fetch(url, { method: 'POST' });
      if (response.ok) {
        const body = (await response.json()) as PinLsResponse;
        return Boolean(body.Keys && cid in body.Keys);
      }
      // Kubo answers 500 with "... is not pinned" for an unpinned CID. That is a normal answer.
      const text = await readErrorBody(response);
      if (response.status === 500 && /not pinned/i.test(text)) return false;

      this.deps.logger.warn('Kubo pin lookup failed; assuming not pinned', {
        cid,
        status: response.status,
      });
      await this.deps.onFailure?.('pinataList');
      return false;
    } catch (error) {
      this.deps.logger.warn('Kubo pin lookup errored; assuming not pinned', {
        cid,
        error,
      });
      await this.deps.onFailure?.('pinataList');
      return false;
    }
  }

  async pin(cid: string, _metadata?: PinMetadata): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    const url = `${this.apiUrl}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=true`;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.deps.retries; attempt++) {
      try {
        const response = await this.deps.fetch(url, { method: 'POST' });
        if (response.ok) {
          this.deps.logger.debug('Pinned on Kubo', { cid });
          return;
        }
        lastError = new ProviderError(
          `HTTP ${response.status}: ${await readErrorBody(response)}`,
          response.status
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      await this.deps.onFailure?.('pinataPin');
      this.deps.logger.warn('Kubo pin attempt failed', {
        cid,
        attempt,
        of: this.deps.retries,
        error: lastError.message,
      });
      if (attempt < this.deps.retries) await sleep(2 ** attempt * 1000);
    }

    throw new ProviderError(
      `Failed to pin ${cid} on Kubo after ${this.deps.retries} attempts: ${lastError?.message}`
    );
  }
}
