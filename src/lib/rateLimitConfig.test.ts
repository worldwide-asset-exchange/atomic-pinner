import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRateLimitConfig,
  displayRateLimitConfig,
  calculateOptimalBatchSize,
  sleep,
  RateLimiter,
} from './rateLimitConfig.js';

describe('Rate Limit Configuration', () => {
  describe('getRateLimitConfig', () => {
    it('should return correct config for free plan', () => {
      const config = getRateLimitConfig('free');

      expect(config.plan).toBe('free');
      expect(config.delayMs).toBe(1200);
      expect(config.batchSize).toBe(5);
      expect(config.requestsPerMinute).toBe(50);
    });

    it('should return correct config for picnic plan', () => {
      const config = getRateLimitConfig('picnic');

      expect(config.plan).toBe('picnic');
      expect(config.delayMs).toBe(300);
      expect(config.batchSize).toBe(20);
      expect(config.requestsPerMinute).toBe(200);
    });

    it('should return correct config for fiesta plan', () => {
      const config = getRateLimitConfig('fiesta');

      expect(config.plan).toBe('fiesta');
      expect(config.delayMs).toBe(150);
      expect(config.batchSize).toBe(30);
      expect(config.requestsPerMinute).toBe(400);
    });

    it('should handle custom plan with provided values', () => {
      const config = getRateLimitConfig('custom', 500, 15);

      expect(config.plan).toBe('custom');
      expect(config.delayMs).toBe(500);
      expect(config.batchSize).toBe(15);
      expect(config.requestsPerMinute).toBe(120);
    });

    it('should default to free plan for custom without values', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = getRateLimitConfig('custom');

      expect(config.plan).toBe('custom');
      expect(config.delayMs).toBe(1200);
      expect(config.batchSize).toBe(5);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Custom plan selected but missing custom values, defaulting to free plan limits'
      );

      consoleSpy.mockRestore();
    });

    it('should override delay for standard plans', () => {
      const config = getRateLimitConfig('picnic', 1000);

      expect(config.plan).toBe('picnic');
      expect(config.delayMs).toBe(1000);
      expect(config.batchSize).toBe(20); // Should keep plan's batch size
      expect(config.requestsPerMinute).toBe(60);
    });

    it('should override batch size for standard plans', () => {
      const config = getRateLimitConfig('picnic', undefined, 10);

      expect(config.plan).toBe('picnic');
      expect(config.delayMs).toBe(300);
      expect(config.batchSize).toBe(10);
      expect(config.requestsPerMinute).toBe(200);
    });

    it('should handle unknown plan gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = getRateLimitConfig('invalid' as any);

      expect(config.plan).toBe('free');
      expect(config.delayMs).toBe(1200);
      expect(config.batchSize).toBe(5);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Unknown plan: invalid, defaulting to free plan'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('displayRateLimitConfig', () => {
    it('should display configuration correctly', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const config = getRateLimitConfig('picnic');

      displayRateLimitConfig(config);

      expect(consoleSpy).toHaveBeenCalledWith(
        '📊 RATE LIMITING CONFIGURATION:'
      );
      expect(consoleSpy).toHaveBeenCalledWith('   • Plan: PICNIC');
      expect(consoleSpy).toHaveBeenCalledWith(
        '   • Delay between requests: 300ms'
      );
      expect(consoleSpy).toHaveBeenCalledWith('   • Batch size: 20 hashes');
      expect(consoleSpy).toHaveBeenCalledWith(
        '   • Max requests per minute: 200'
      );
      // Check for estimate time message (the actual calculation may vary)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Estimated time for 1000 hashes')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('calculateOptimalBatchSize', () => {
    const baseConfig = getRateLimitConfig('picnic');

    it('should return base batch size for small collections', () => {
      const batchSize = calculateOptimalBatchSize(10000, 4096, baseConfig);
      expect(batchSize).toBe(20);
    });

    it('should reduce batch size for very large collections', () => {
      const batchSize = calculateOptimalBatchSize(150000, 4096, baseConfig);
      expect(batchSize).toBe(10);
    });

    it('should reduce batch size for large collections', () => {
      const batchSize = calculateOptimalBatchSize(75000, 4096, baseConfig);
      expect(batchSize).toBe(15);
    });

    it('should respect memory limits', () => {
      const batchSize = calculateOptimalBatchSize(10000, 10, baseConfig); // Very low memory
      expect(batchSize).toBeLessThanOrEqual(10);
      expect(batchSize).toBeGreaterThanOrEqual(1);
    });

    it('should never return less than 1', () => {
      const batchSize = calculateOptimalBatchSize(1000000, 1, baseConfig);
      expect(batchSize).toBe(1);
    });
  });

  describe('sleep', () => {
    it('should delay for specified time', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(95); // Allow some margin
      expect(elapsed).toBeLessThan(150);
    });
  });

  describe('RateLimiter', () => {
    let rateLimiter: RateLimiter;
    const config = getRateLimitConfig('picnic');

    beforeEach(() => {
      rateLimiter = new RateLimiter(config);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should enforce minimum delay between requests', async () => {
      const waitPromise1 = rateLimiter.waitIfNeeded();
      vi.advanceTimersByTime(0);
      await waitPromise1;

      const waitPromise2 = rateLimiter.waitIfNeeded();
      vi.advanceTimersByTime(100); // Less than required delay

      // Should still be waiting
      let resolved = false;
      waitPromise2.then(() => {
        resolved = true;
      });
      vi.advanceTimersByTime(100);
      expect(resolved).toBe(false);

      // Should resolve after full delay
      vi.advanceTimersByTime(100);
      await waitPromise2;
      expect(resolved).toBe(true);
    });

    it('should track request count', () => {
      const stats = rateLimiter.getStats();
      expect(stats.requestCount).toBe(0);

      rateLimiter.waitIfNeeded();
      vi.advanceTimersByTime(config.delayMs);

      const stats2 = rateLimiter.getStats();
      expect(stats2.requestCount).toBe(1);
    });

    it('should reset window after 60 seconds', async () => {
      // Make some requests
      for (let i = 0; i < 5; i++) {
        await rateLimiter.waitIfNeeded();
        vi.advanceTimersByTime(config.delayMs);
      }

      expect(rateLimiter.getStats().requestCount).toBe(5);

      // Advance time past window
      vi.advanceTimersByTime(61000);

      await rateLimiter.waitIfNeeded();
      expect(rateLimiter.getStats().requestCount).toBe(1); // Reset
    });

    it('should enforce rate limit per minute', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Create a smaller config for testing
      const testConfig = { ...config, requestsPerMinute: 5 };
      const testLimiter = new RateLimiter(testConfig);

      // Fill up the rate limit
      for (let i = 0; i < testConfig.requestsPerMinute; i++) {
        const promise = testLimiter.waitIfNeeded();
        vi.advanceTimersByTime(testConfig.delayMs);
        await promise;
      }

      // Next request should wait
      testLimiter.waitIfNeeded();
      vi.runAllTimers(); // Resolve any pending timers

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit approaching, waiting')
      );

      consoleSpy.mockRestore();
    });

    it('should reset properly', () => {
      rateLimiter.waitIfNeeded();
      vi.advanceTimersByTime(config.delayMs);

      expect(rateLimiter.getStats().requestCount).toBe(1);

      rateLimiter.reset();

      expect(rateLimiter.getStats().requestCount).toBe(0);
    });
  });
});
