import { describe, it, expect, vi } from 'vitest';
import { KuboProvider } from './kubo.js';
import { silentLogger } from '../logging/logger.js';
import { fakeFetch, type Route } from '../../tests/helpers/http.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

function provider(routes: Route[], retries = 3) {
  const fetch = fakeFetch(routes);
  const onFailure = vi.fn();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const p = new KuboProvider(
    { apiUrl: 'http://127.0.0.1:5001/' },
    { fetch, logger: silentLogger, retries, onFailure, sleep }
  );
  return { p, fetch, onFailure, sleep };
}

describe('KuboProvider', () => {
  it('reports pinned when pin/ls lists the CID', async () => {
    const { p, fetch } = provider([
      {
        method: 'POST',
        match: '/api/v0/pin/ls',
        body: { Keys: { [CID]: { Type: 'recursive' } } },
      },
    ]);
    expect(await p.isPinned(CID)).toBe(true);
    expect(fetch.calls[0].url).toBe(
      `http://127.0.0.1:5001/api/v0/pin/ls?arg=${CID}&type=recursive`
    );
  });

  it('treats the "not pinned" 500 as a normal negative answer', async () => {
    const { p, onFailure } = provider([
      {
        method: 'POST',
        match: '/api/v0/pin/ls',
        status: 500,
        body: { Message: `path '${CID}' is not pinned`, Code: 0 },
      },
    ]);
    expect(await p.isPinned(CID)).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('counts other errors as failures', async () => {
    const { p, onFailure } = provider([
      {
        method: 'POST',
        match: '/api/v0/pin/ls',
        status: 502,
        body: 'bad gateway',
      },
    ]);
    expect(await p.isPinned(CID)).toBe(false);
    expect(onFailure).toHaveBeenCalledWith('pinataList');
  });

  it('counts network errors as failures', async () => {
    const { p, onFailure } = provider([
      {
        method: 'POST',
        match: '/api/v0/pin/ls',
        throws: new Error('ECONNREFUSED'),
      },
    ]);
    expect(await p.isPinned(CID)).toBe(false);
    expect(onFailure).toHaveBeenCalledWith('pinataList');
  });

  it('pins recursively through pin/add', async () => {
    const { p, fetch } = provider([
      { method: 'POST', match: '/api/v0/pin/add', body: { Pins: [CID] } },
    ]);
    await p.pin(CID);
    expect(fetch.calls[0].url).toBe(
      `http://127.0.0.1:5001/api/v0/pin/add?arg=${CID}&recursive=true`
    );
  });

  it('retries a failed pin and throws when exhausted', async () => {
    const { p, onFailure, sleep } = provider(
      [
        {
          method: 'POST',
          match: '/api/v0/pin/add',
          status: 500,
          body: 'merkledag: not found',
        },
      ],
      2
    );
    await expect(p.pin(CID)).rejects.toThrow(/after 2 attempts/);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
