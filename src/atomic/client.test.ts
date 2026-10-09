import { describe, it, expect, vi } from 'vitest';
import { AtomicClient, AtomicApiError } from './client.js';
import { silentLogger } from '../logging/logger.js';
import { fakeFetch, type Route } from '../../tests/helpers/http.js';

const asset = (id: number) => ({
  asset_id: String(id),
  owner: 'o',
  collection: { collection_name: 'col' },
});

function client(routes: Route[], retryAttempts = 3) {
  const fetch = fakeFetch(routes);
  const onFailure = vi.fn();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const c = new AtomicClient(
    {
      apiUrl: 'https://api.example/',
      pageSize: 100,
      timeoutMs: 1000,
      retries: 1,
      retryAttempts,
      retryBaseDelayMs: 10,
    },
    { fetch, logger: silentLogger, onFailure, sleep }
  );
  return { c, fetch, onFailure, sleep };
}

describe('AtomicClient', () => {
  it('requests a page in ascending asset_id order', async () => {
    const { c, fetch } = client([
      {
        match: '/atomicassets/v1/assets',
        body: { success: true, data: [asset(1), asset(2)] },
      },
    ]);
    const page = await c.getAssetsPage({ collectionName: 'col', page: 3 });
    expect(page.map((a) => a.asset_id)).toEqual(['1', '2']);
    const url = new URL(fetch.calls[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://api.example/atomicassets/v1/assets'
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      collection_name: 'col',
      page: '3',
      limit: '100',
      sort: 'asset_id',
      order: 'asc',
    });
  });

  it('lets a query override the page size', async () => {
    const { c, fetch } = client([
      { match: '/assets', body: { success: true, data: [] } },
    ]);
    await c.getAssetsPage({ collectionName: 'col', page: 1, limit: 5 });
    expect(new URL(fetch.calls[0].url).searchParams.get('limit')).toBe('5');
    expect(c.pageSize).toBe(100);
  });

  it('retries server errors with backoff and counts each failure', async () => {
    const { c, fetch, onFailure, sleep } = client([
      { match: '/assets', status: 503, body: 'down', times: 2 },
      { match: '/assets', body: { success: true, data: [asset(1)] } },
    ]);
    expect(
      await c.getAssetsPage({ collectionName: 'col', page: 1 })
    ).toHaveLength(1);
    expect(fetch.calls).toHaveLength(3);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors', async () => {
    const { c, fetch, onFailure } = client([
      { match: '/assets', status: 404, body: 'nope' },
    ]);
    await expect(
      c.getAssetsPage({ collectionName: 'col', page: 1 })
    ).rejects.toThrow(AtomicApiError);
    expect(fetch.calls).toHaveLength(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('treats an API-level failure as an error', async () => {
    const { c } = client(
      [
        {
          match: '/assets',
          body: { success: false, message: 'collection not found' },
        },
      ],
      1
    );
    await expect(
      c.getAssetsPage({ collectionName: 'col', page: 1 })
    ).rejects.toThrow(/collection not found/);
  });

  it('gives up after the configured attempts', async () => {
    const { c, fetch } = client(
      [{ match: '/assets', throws: new Error('ECONNRESET') }],
      2
    );
    await expect(
      c.getAssetsPage({ collectionName: 'col', page: 1 })
    ).rejects.toThrow('ECONNRESET');
    expect(fetch.calls).toHaveLength(2);
  });

  it('probes whether a page has assets', async () => {
    const { c, fetch } = client([
      { match: '/assets', body: { success: true, data: [asset(9)] } },
    ]);
    expect(await c.hasAssetsOnPage('col', 7)).toBe(true);
    expect(new URL(fetch.calls[0].url).searchParams.get('limit')).toBe('1');
  });
});
