import type { Config } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { createRetryFetch, type RetryFetch } from '../net/fetchRetry.js';
import { KuboProvider } from './kubo.js';
import { PinataProvider } from './pinata.js';
import {
  ProviderError,
  type ApiFailureKind,
  type IPFSProvider,
} from './provider.js';
import { createHashVerifier, type HashVerifier } from './verify.js';

export type { IPFSProvider, PinMetadata, ApiFailureKind } from './provider.js';
export { ProviderError } from './provider.js';
export { PinataProvider } from './pinata.js';
export { KuboProvider } from './kubo.js';
export { createHashVerifier } from './verify.js';
export type { HashVerifier } from './verify.js';

export interface IpfsDeps {
  logger: Logger;
  onFailure?: (kind: ApiFailureKind) => void | Promise<void>;
  /** Override the HTTP client (tests). */
  fetch?: RetryFetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createProvider(config: Config, deps: IpfsDeps): IPFSProvider {
  const fetch =
    deps.fetch ?? createRetryFetch({ retries: 3, timeoutMs: 30000 });
  const common = {
    fetch,
    logger: deps.logger.child({ component: config.provider.type }),
    retries: config.provider.pinRetries,
    onFailure: deps.onFailure,
    sleep: deps.sleep,
  };
  switch (config.provider.type) {
    case 'pinata':
      if (!config.provider.pinataJwt && config.processing.dryRun) {
        // A dry run may be used to size a job before buying a plan: report nothing as pinned.
        deps.logger.warn(
          'No PINATA_JWT set; dry run will treat every CID as not yet pinned'
        );
        return noCredentialsProvider('pinata');
      }
      return new PinataProvider({ jwt: config.provider.pinataJwt }, common);
    case 'kubo':
      return new KuboProvider({ apiUrl: config.provider.kuboApiUrl }, common);
  }
}

function noCredentialsProvider(name: string): IPFSProvider {
  return {
    name: `${name} (no credentials)`,
    async isPinned() {
      return false;
    },
    async pin(cid) {
      throw new ProviderError(
        `Cannot pin ${cid}: no credentials configured for ${name}`
      );
    },
  };
}

export function createVerifier(config: Config, deps: IpfsDeps): HashVerifier {
  // Gateway checks: retry network errors only. A 429 or 5xx is a reason to try the next gateway.
  const fetch =
    deps.fetch ??
    createRetryFetch({
      retries: 2,
      timeoutMs: 20000,
      shouldRetryStatus: () => false,
    });
  const gateways =
    config.provider.type === 'kubo'
      ? [
          config.provider.kuboGatewayUrl,
          ...config.provider.verificationGateways,
        ]
      : config.provider.verificationGateways;
  return createHashVerifier({
    gateways: Array.from(new Set(gateways)),
    pinataJwt: config.provider.pinataJwt || undefined,
    fetch,
    logger: deps.logger.child({ component: 'verify' }),
    onFailure: deps.onFailure,
  });
}
