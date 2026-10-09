/**
 * A small retrying wrapper around the global fetch (Node >= 18).
 *
 * - Every attempt gets its own timeout (AbortController); a caller-supplied
 *   `signal` is honoured as well and is never retried.
 * - Network failures, timeouts, 408, 429 and 5xx responses are retried with
 *   exponential backoff and jitter. Other 4xx responses are returned as-is.
 * - When retries are exhausted the last response is returned (so callers can
 *   inspect the status) or the last error is thrown.
 */

export interface RetryFetchOptions {
  /** Total number of attempts, including the first. Default 3. */
  retries?: number;
  /** Per-attempt timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Delay before the first retry. Doubles each attempt. Default 250. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay. Default 5000. */
  maxDelayMs?: number;
  /** Decide whether a response status should be retried. */
  shouldRetryStatus?: (status: number) => boolean;
  /** Receives a short message before every retry. Default: silent. */
  onRetry?: (message: string) => void;
  /** Injected for tests. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Default: setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type RetryFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export const defaultShouldRetryStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class FetchTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

function describe(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function backoffDelay(attempt: number, base: number, max: number): number {
  const exponential = Math.min(max, base * 2 ** attempt);
  // Full jitter keeps concurrent clients from retrying in lockstep.
  return Math.round(Math.random() * exponential);
}

export function createRetryFetch(options: RetryFetchOptions = {}): RetryFetch {
  const retries = Math.max(1, options.retries ?? 3);
  const timeoutMs = options.timeoutMs ?? 10000;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const shouldRetryStatus =
    options.shouldRetryStatus ?? defaultShouldRetryStatus;
  const onRetry = options.onRetry ?? (() => {});
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepImpl = options.sleepImpl ?? sleep;

  return async function retryFetch(input, init = {}) {
    const url = describe(input);
    const callerSignal = init.signal ?? undefined;
    let lastResponse: Response | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < retries; attempt++) {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? new Error(`Request to ${url} was aborted`);
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const abortFromCaller = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

      try {
        const response = await fetchImpl(input, {
          ...init,
          signal: controller.signal,
        });
        lastResponse = response;
        lastError = undefined;

        if (!shouldRetryStatus(response.status) || attempt === retries - 1) {
          return response;
        }
        onRetry(
          `HTTP ${response.status} from ${url} (attempt ${attempt + 1}/${retries})`
        );
      } catch (error) {
        if (callerSignal?.aborted) {
          throw error;
        }
        lastError = timedOut ? new FetchTimeoutError(url, timeoutMs) : error;
        lastResponse = undefined;

        if (attempt === retries - 1) {
          throw lastError;
        }
        const reason =
          lastError instanceof Error ? lastError.message : String(lastError);
        onRetry(`${reason} (attempt ${attempt + 1}/${retries})`);
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', abortFromCaller);
      }

      await sleepImpl(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }

    // Unreachable: the loop either returns or throws on the final attempt.
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error(`Request to ${url} failed`);
  };
}
