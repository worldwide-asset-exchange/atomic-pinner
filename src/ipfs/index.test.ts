import { describe, it, expect, vi } from 'vitest';
import {
  createProvider,
  createVerifier,
  PinataProvider,
  KuboProvider,
  ProviderError,
} from './index.js';
import { loadConfig } from '../config/load.js';
import { createLogger, silentLogger } from '../logging/logger.js';
import { fakeFetch } from '../../tests/helpers/http.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

describe('createProvider', () => {
  it('builds a Pinata provider when a JWT is present', () => {
    const config = loadConfig({ env: { PINATA_JWT: 'x' } });
    expect(createProvider(config, { logger: silentLogger })).toBeInstanceOf(
      PinataProvider
    );
  });

  it('builds a Kubo provider', () => {
    const config = loadConfig({ env: { IPFS_PROVIDER: 'kubo' } });
    expect(createProvider(config, { logger: silentLogger })).toBeInstanceOf(
      KuboProvider
    );
  });

  it('uses a credential-less stand-in for a dry run without a JWT', async () => {
    const config = loadConfig({ env: { DRY_RUN: '1' } });
    const write = vi.fn();
    const provider = createProvider(config, {
      logger: createLogger({ level: 'warn', write }),
    });
    expect(provider.name).toContain('no credentials');
    expect(await provider.isPinned(CID)).toBe(false);
    await expect(provider.pin(CID)).rejects.toThrow(ProviderError);
    expect(write.mock.calls[0][0]).toContain('No PINATA_JWT');
  });

  it('refuses a live Pinata run without a JWT', () => {
    const config = loadConfig({ env: {}, requireCredentials: false });
    expect(() => createProvider(config, { logger: silentLogger })).toThrow(
      ProviderError
    );
  });
});

describe('createVerifier', () => {
  it('tries the Kubo gateway first for the kubo provider and dedupes gateways', async () => {
    const config = loadConfig({
      env: {
        IPFS_PROVIDER: 'kubo',
        IPFS_GATEWAY_URL: 'http://127.0.0.1:8080',
        IPFS_VERIFICATION_GATEWAYS: 'http://127.0.0.1:8080,https://ipfs.io',
      },
    });
    const fetch = fakeFetch([{ method: 'HEAD', match: '127.0.0.1:8080' }]);
    const verifier = createVerifier(config, { logger: silentLogger, fetch });
    expect(await verifier.exists(CID)).toBe(true);
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `http://127.0.0.1:8080/ipfs/${CID}`,
    ]);
  });

  it('uses the configured gateway list for Pinata', async () => {
    const config = loadConfig({
      env: { PINATA_JWT: 'x', IPFS_VERIFICATION_GATEWAYS: 'https://a.example' },
    });
    const fetch = fakeFetch([
      { method: 'HEAD', match: 'a.example', status: 404 },
      { method: 'GET', match: 'a.example', status: 404 },
    ]);
    const verifier = createVerifier(config, { logger: silentLogger, fetch });
    expect(await verifier.exists(CID)).toBe(false);
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `https://a.example/ipfs/${CID}`,
      `https://a.example/ipfs/${CID}`,
    ]);
  });
});
