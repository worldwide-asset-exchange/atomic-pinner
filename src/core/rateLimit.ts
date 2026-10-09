import type { PINATA_PLANS } from '../config/schema.js';

export type PinataPlan = (typeof PINATA_PLANS)[number];

export interface RateLimit {
  plan: PinataPlan;
  /** Pause after each provider or gateway call. */
  delayMs: number;
  /** CIDs between the longer (2× delay) inter-batch pauses. */
  batchSize: number;
  requestsPerMinute: number;
}

/** Presets sit about 20% under each plan's published limit. */
export const PLAN_PRESETS: Record<
  Exclude<PinataPlan, 'custom'>,
  Omit<RateLimit, 'plan'>
> = {
  free: { delayMs: 1200, batchSize: 5, requestsPerMinute: 50 },
  picnic: { delayMs: 300, batchSize: 20, requestsPerMinute: 200 },
  fiesta: { delayMs: 150, batchSize: 30, requestsPerMinute: 400 },
};

export interface RateLimitInput {
  plan: PinataPlan;
  delayMs?: number;
  batchSize?: number;
}

export function resolveRateLimit(input: RateLimitInput): RateLimit {
  const preset = PLAN_PRESETS[input.plan === 'custom' ? 'free' : input.plan];
  const delayMs = input.delayMs ?? preset.delayMs;
  const batchSize = input.batchSize ?? preset.batchSize;
  return {
    plan: input.plan,
    delayMs,
    batchSize,
    requestsPerMinute: delayMs > 0 ? Math.floor(60000 / delayMs) : Infinity,
  };
}
