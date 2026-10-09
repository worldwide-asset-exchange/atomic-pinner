import { vi } from 'vitest';
import type { RetryFetch } from '../../src/net/fetchRetry.js';

export interface Route {
  /** Defaults to any method. */
  method?: string;
  /** Substring or pattern of the URL. */
  match: string | RegExp;
  status?: number;
  /** Objects are JSON-encoded; strings are sent as-is. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Use this route at most N times, then fall through to the next match. */
  times?: number;
  /** Reject instead of responding. */
  throws?: Error;
}

export interface RecordedCall {
  method: string;
  url: string;
  init?: RequestInit;
}

export type FakeFetch = RetryFetch & { calls: RecordedCall[] };

/** A fetch double that answers from an ordered route table and records every call. */
export function fakeFetch(routes: Route[]): FakeFetch {
  const calls: RecordedCall[] = [];
  const remaining = new Map<Route, number>();
  for (const r of routes) if (r.times !== undefined) remaining.set(r, r.times);

  const fn = vi.fn(
    async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, init });

      const route = routes.find((r) => {
        if (r.method && r.method.toUpperCase() !== method) return false;
        if (
          typeof r.match === 'string'
            ? !url.includes(r.match)
            : !r.match.test(url)
        )
          return false;
        const left = remaining.get(r);
        return left === undefined || left > 0;
      });
      if (!route) throw new Error(`fakeFetch: no route for ${method} ${url}`);
      if (remaining.has(route)) remaining.set(route, remaining.get(route)! - 1);
      if (route.throws) throw route.throws;

      const body =
        route.body === undefined
          ? null
          : typeof route.body === 'string'
            ? route.body
            : JSON.stringify(route.body);
      return new Response(body, {
        status: route.status ?? 200,
        headers: route.headers,
      });
    }
  );

  return Object.assign(fn as unknown as RetryFetch, { calls });
}

export const header = (
  call: RecordedCall,
  name: string
): string | undefined => {
  const headers = call.init?.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? headers[key] : undefined;
};
