import { sleep as defaultSleep } from '../net/fetchRetry.js';
import {
  type IPFSProvider,
  type PinMetadata,
  type ProviderDeps,
  ProviderError,
  readErrorBody,
} from './provider.js';

export interface PinataOptions {
  jwt: string;
  apiUrl?: string;
}

interface PinListResponse {
  rows?: Array<{ ipfs_pin_hash?: string }>;
}

export class PinataProvider implements IPFSProvider {
  readonly name = 'pinata';
  private readonly apiUrl: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly options: PinataOptions,
    private readonly deps: ProviderDeps
  ) {
    if (!options.jwt) throw new ProviderError('Pinata provider needs a JWT');
    this.apiUrl = (options.apiUrl ?? 'https://api.pinata.cloud').replace(
      /\/$/,
      ''
    );
    this.headers = { Authorization: `Bearer ${options.jwt}` };
  }

  async isPinned(cid: string): Promise<boolean> {
    const url = `${this.apiUrl}/data/pinList?hashContains=${encodeURIComponent(cid)}&status=pinned`;
    try {
      const response = await this.deps.fetch(url, { headers: this.headers });
      if (!response.ok) {
        this.deps.logger.warn('Pinata pin lookup failed; assuming not pinned', {
          cid,
          status: response.status,
        });
        await this.deps.onFailure?.('pinataList');
        return false;
      }
      const body = (await response.json()) as PinListResponse;
      return Boolean(body.rows?.some((row) => row.ipfs_pin_hash === cid));
    } catch (error) {
      this.deps.logger.warn('Pinata pin lookup errored; assuming not pinned', {
        cid,
        error,
      });
      await this.deps.onFailure?.('pinataList');
      return false;
    }
  }

  async pin(cid: string, metadata?: PinMetadata): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    const body = JSON.stringify({
      hashToPin: cid,
      pinataMetadata: metadata ?? { name: cid },
    });
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.deps.retries; attempt++) {
      try {
        const response = await this.deps.fetch(
          `${this.apiUrl}/pinning/pinByHash`,
          {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/json' },
            body,
          }
        );
        if (response.ok) {
          this.deps.logger.debug('Pinned on Pinata', { cid });
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
      this.deps.logger.warn('Pinata pin attempt failed', {
        cid,
        attempt,
        of: this.deps.retries,
        error: lastError.message,
      });
      if (attempt < this.deps.retries) await sleep(2 ** attempt * 1000);
    }

    throw new ProviderError(
      `Failed to pin ${cid} on Pinata after ${this.deps.retries} attempts: ${lastError?.message}`
    );
  }
}
