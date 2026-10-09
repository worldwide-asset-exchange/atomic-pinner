import { describe, it, expect, vi } from 'vitest';
import { PinataProvider } from './pinata.js';
import { ProviderError } from './provider.js';
import { silentLogger } from '../logging/logger.js';
import { fakeFetch, header, type Route } from '../../tests/helpers/http.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

function provider(routes: Route[], retries = 3) {
  const fetch = fakeFetch(routes);
  const onFailure = vi.fn();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const p = new PinataProvider(
    { jwt: 'jwt-123' },
    { fetch, logger: silentLogger, retries, onFailure, sleep }
  );
  return { p, fetch, onFailure, sleep };
}

describe('PinataProvider', () => {
  it('requires a JWT', () => {
    expect(
      () =>
        new PinataProvider(
          { jwt: '' },
          { fetch: fakeFetch([]), logger: silentLogger, retries: 1 }
        )
    ).toThrow(ProviderError);
  });

  describe('isPinned', () => {
    it('is true when the pin list contains the exact CID', async () => {
      const { p, fetch } = provider([
        { match: '/data/pinList', body: { rows: [{ ipfs_pin_hash: CID }] } },
      ]);
      expect(await p.isPinned(CID)).toBe(true);
      expect(fetch.calls[0].url).toBe(
        `https://api.pinata.cloud/data/pinList?hashContains=${CID}&status=pinned`
      );
      expect(header(fetch.calls[0], 'Authorization')).toBe('Bearer jwt-123');
    });

    it('is false when only other CIDs are listed', async () => {
      const { p } = provider([
        {
          match: '/data/pinList',
          body: { rows: [{ ipfs_pin_hash: 'QmOther' }] },
        },
      ]);
      expect(await p.isPinned(CID)).toBe(false);
    });

    it('assumes not pinned and counts a failure on an error status', async () => {
      const { p, onFailure } = provider([
        { match: '/data/pinList', status: 500, body: 'oops' },
      ]);
      expect(await p.isPinned(CID)).toBe(false);
      expect(onFailure).toHaveBeenCalledWith('pinataList');
    });

    it('assumes not pinned and counts a failure on a network error', async () => {
      const { p, onFailure } = provider([
        { match: '/data/pinList', throws: new Error('ECONNRESET') },
      ]);
      expect(await p.isPinned(CID)).toBe(false);
      expect(onFailure).toHaveBeenCalledWith('pinataList');
    });
  });

  describe('pin', () => {
    it('posts pinByHash with metadata', async () => {
      const { p, fetch, onFailure } = provider([
        { method: 'POST', match: '/pinning/pinByHash', body: { ok: true } },
      ]);
      await p.pin(CID, { name: 'col-x', keyvalues: { collection: 'col' } });
      const call = fetch.calls[0];
      expect(call.url).toBe('https://api.pinata.cloud/pinning/pinByHash');
      expect(JSON.parse(call.init!.body as string)).toEqual({
        hashToPin: CID,
        pinataMetadata: { name: 'col-x', keyvalues: { collection: 'col' } },
      });
      expect(header(call, 'Content-Type')).toBe('application/json');
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('defaults the metadata name to the CID', async () => {
      const { p, fetch } = provider([
        { method: 'POST', match: '/pinning/pinByHash', body: {} },
      ]);
      await p.pin(CID);
      expect(
        JSON.parse(fetch.calls[0].init!.body as string).pinataMetadata
      ).toEqual({ name: CID });
    });

    it('retries with backoff after a failure and counts each failure', async () => {
      const { p, onFailure, sleep, fetch } = provider([
        {
          method: 'POST',
          match: '/pinning/pinByHash',
          status: 500,
          body: 'busy',
          times: 1,
        },
        { method: 'POST', match: '/pinning/pinByHash', body: {} },
      ]);
      await p.pin(CID);
      expect(fetch.calls).toHaveLength(2);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('throws a ProviderError once retries are exhausted', async () => {
      const { p, onFailure, sleep } = provider(
        [
          {
            method: 'POST',
            match: '/pinning/pinByHash',
            status: 429,
            body: 'slow down',
          },
        ],
        2
      );
      await expect(p.pin(CID)).rejects.toThrow(/after 2 attempts.*HTTP 429/);
      expect(onFailure).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1); // no sleep after the final attempt
    });

    it('treats network errors like failed attempts', async () => {
      const { p } = provider(
        [
          {
            method: 'POST',
            match: '/pinning/pinByHash',
            throws: new Error('fetch failed'),
          },
        ],
        1
      );
      await expect(p.pin(CID)).rejects.toThrow(/fetch failed/);
    });
  });
});
