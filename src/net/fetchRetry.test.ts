import { describe, it, expect, vi } from 'vitest';
import {
  createRetryFetch,
  defaultShouldRetryStatus,
  FetchTimeoutError,
} from './fetchRetry.js';

const noSleep = async () => {};

function responseWith(status: number): Response {
  return new Response(status === 204 ? null : 'body', { status });
}

describe('defaultShouldRetryStatus', () => {
  it('retries 408, 429 and 5xx only', () => {
    expect(defaultShouldRetryStatus(200)).toBe(false);
    expect(defaultShouldRetryStatus(301)).toBe(false);
    expect(defaultShouldRetryStatus(404)).toBe(false);
    expect(defaultShouldRetryStatus(408)).toBe(true);
    expect(defaultShouldRetryStatus(429)).toBe(true);
    expect(defaultShouldRetryStatus(500)).toBe(true);
    expect(defaultShouldRetryStatus(504)).toBe(true);
  });
});

describe('createRetryFetch', () => {
  it('returns the first successful response without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responseWith(200));
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl: noSleep,
      retries: 3,
    });

    const res = await fetch('https://example.test/ok');

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responseWith(404));
    const onRetry = vi.fn();
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl: noSleep,
      retries: 5,
      onRetry,
    });

    const res = await fetch('https://example.test/missing');

    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries a 503 and returns the eventual success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(responseWith(503))
      .mockResolvedValueOnce(responseWith(503))
      .mockResolvedValueOnce(responseWith(200));
    const onRetry = vi.fn();
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl: noSleep,
      retries: 3,
      onRetry,
    });

    const res = await fetch('https://example.test/flaky');

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toContain('HTTP 503');
  });

  it('returns the last response when retries are exhausted on a retryable status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responseWith(429));
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl: noSleep,
      retries: 3,
    });

    const res = await fetch('https://example.test/limited');

    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries network errors and throws the last one when exhausted', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl: noSleep,
      retries: 2,
    });

    await expect(fetch('https://example.test/down')).rejects.toThrow(
      'fetch failed'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('recovers from a network error on a later attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(responseWith(200));
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl: noSleep,
      retries: 2,
    });

    const res = await fetch('https://example.test/recovers');

    expect(res.status).toBe(200);
  });

  it('converts a per-attempt timeout into FetchTimeoutError', async () => {
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      });
    });
    const fetch = createRetryFetch({
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      sleepImpl: noSleep,
      retries: 1,
      timeoutMs: 5,
    });

    await expect(fetch('https://example.test/slow')).rejects.toBeInstanceOf(
      FetchTimeoutError
    );
  });

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('caller aborted'))
        );
      });
    });
    const fetch = createRetryFetch({
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      sleepImpl: noSleep,
      retries: 5,
      timeoutMs: 1000,
    });

    const pending = fetch('https://example.test/abort', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('caller aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours a custom shouldRetryStatus', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(responseWith(404))
      .mockResolvedValueOnce(responseWith(200));
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl: noSleep,
      retries: 2,
      shouldRetryStatus: (s) => s === 404,
    });

    const res = await fetch('https://example.test/custom');

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sleeps with bounded backoff between attempts', async () => {
    const sleepImpl = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi.fn().mockResolvedValue(responseWith(500));
    const fetch = createRetryFetch({
      fetchImpl,
      sleepImpl,
      retries: 4,
      baseDelayMs: 100,
      maxDelayMs: 250,
    });

    await fetch('https://example.test/backoff');

    expect(sleepImpl).toHaveBeenCalledTimes(3);
    for (const [ms] of sleepImpl.mock.calls) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(250);
    }
  });
});
