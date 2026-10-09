import { describe, it, expect, vi } from 'vitest';
import { PinService, type PinnedHashCache } from './pinService.js';
import type { IPFSProvider } from '../ipfs/provider.js';
import type { HashVerifier } from '../ipfs/verify.js';
import { silentLogger } from '../logging/logger.js';

function setup(
  opts: {
    cached?: boolean;
    pinned?: boolean;
    exists?: boolean;
    dryRun?: boolean;
    delayMs?: number;
  } = {}
) {
  const cache: PinnedHashCache = {
    isHashConfirmedPinned: vi.fn().mockResolvedValue(opts.cached ?? false),
    recordConfirmedPinnedHash: vi.fn().mockResolvedValue(undefined),
  };
  const provider: IPFSProvider = {
    name: 'fake',
    isPinned: vi.fn().mockResolvedValue(opts.pinned ?? false),
    pin: vi.fn().mockResolvedValue(undefined),
  };
  const verifier: HashVerifier = {
    exists: vi.fn().mockResolvedValue(opts.exists ?? true),
  };
  const sleep = vi.fn().mockResolvedValue(undefined);
  const service = new PinService({
    cache,
    provider,
    verifier,
    logger: silentLogger,
    delayMs: opts.delayMs ?? 100,
    dryRun: opts.dryRun ?? false,
    sleep,
  });
  return { service, cache, provider, verifier, sleep };
}

const meta = { name: 'col-cid' };

describe('PinService decision chain', () => {
  it('returns cached without touching the network', async () => {
    const { service, provider, verifier, sleep } = setup({ cached: true });
    expect(await service.process('cid1', meta)).toBe('cached');
    expect(provider.isPinned).not.toHaveBeenCalled();
    expect(verifier.exists).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('records a provider-reported pin in the cache and stops', async () => {
    const { service, cache, provider, verifier } = setup({ pinned: true });
    expect(await service.process('cid1', meta)).toBe('already-pinned');
    expect(cache.recordConfirmedPinnedHash).toHaveBeenCalledWith(
      'cid1',
      'fake'
    );
    expect(verifier.exists).not.toHaveBeenCalled();
    expect(provider.pin).not.toHaveBeenCalled();
  });

  it('skips content no gateway can serve', async () => {
    const { service, cache, provider } = setup({ exists: false });
    expect(await service.process('cid1', meta)).toBe('missing');
    expect(provider.pin).not.toHaveBeenCalled();
    expect(cache.recordConfirmedPinnedHash).not.toHaveBeenCalled();
  });

  it('pins and records when the content exists and is not pinned', async () => {
    const { service, cache, provider } = setup();
    expect(await service.process('cid1', meta)).toBe('pinned');
    expect(provider.pin).toHaveBeenCalledWith('cid1', meta);
    expect(cache.recordConfirmedPinnedHash).toHaveBeenCalledWith(
      'cid1',
      'fake'
    );
  });

  it('never pins in a dry run', async () => {
    const { service, cache, provider, verifier } = setup({ dryRun: true });
    expect(await service.process('cid1', meta)).toBe('would-pin');
    expect(verifier.exists).toHaveBeenCalled();
    expect(provider.pin).not.toHaveBeenCalled();
    expect(cache.recordConfirmedPinnedHash).not.toHaveBeenCalled();
  });

  it('propagates pin failures so the caller can record them', async () => {
    const { service, provider, cache } = setup();
    (provider.pin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom')
    );
    await expect(service.process('cid1', meta)).rejects.toThrow('boom');
    expect(cache.recordConfirmedPinnedHash).not.toHaveBeenCalled();
  });

  it('asks the provider only once per CID per session', async () => {
    const { service, provider } = setup({ exists: false });
    await service.process('cid1', meta);
    await service.process('cid1', meta);
    expect(provider.isPinned).toHaveBeenCalledTimes(1);
  });

  it('pauses after each network call with the configured delay', async () => {
    const { service, sleep } = setup({ delayMs: 250 });
    await service.process('cid1', meta); // isPinned, exists, pin
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does not pause when the delay is zero', async () => {
    const { service, sleep } = setup({ delayMs: 0 });
    await service.process('cid1', meta);
    expect(sleep).not.toHaveBeenCalled();
  });
});
