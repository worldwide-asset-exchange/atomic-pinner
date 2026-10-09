import { describe, it, expect } from 'vitest';
import { resolveRateLimit, PLAN_PRESETS } from './rateLimit.js';

describe('resolveRateLimit', () => {
  it('uses the preset for a plan', () => {
    expect(resolveRateLimit({ plan: 'picnic' })).toEqual({
      plan: 'picnic',
      ...PLAN_PRESETS.picnic,
    });
    expect(resolveRateLimit({ plan: 'free' }).delayMs).toBe(1200);
    expect(resolveRateLimit({ plan: 'fiesta' }).batchSize).toBe(30);
  });

  it('lets explicit values override the preset and recomputes the rate', () => {
    expect(resolveRateLimit({ plan: 'picnic', delayMs: 600 })).toEqual({
      plan: 'picnic',
      delayMs: 600,
      batchSize: 20,
      requestsPerMinute: 100,
    });
    expect(resolveRateLimit({ plan: 'free', batchSize: 50 }).batchSize).toBe(
      50
    );
  });

  it('falls back to free-plan values for custom without overrides', () => {
    expect(resolveRateLimit({ plan: 'custom' })).toEqual({
      plan: 'custom',
      ...PLAN_PRESETS.free,
    });
    expect(
      resolveRateLimit({ plan: 'custom', delayMs: 0, batchSize: 100 })
    ).toEqual({
      plan: 'custom',
      delayMs: 0,
      batchSize: 100,
      requestsPerMinute: Infinity,
    });
  });
});
