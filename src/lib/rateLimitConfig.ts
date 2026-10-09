/**
 * Rate limiting configuration based on Pinata subscription plans
 */

export interface RateLimitConfig {
  delayMs: number;
  batchSize: number;
  requestsPerMinute: number;
  plan: 'free' | 'picnic' | 'fiesta' | 'custom';
}

/**
 * Default configurations for each Pinata plan
 */
const PLAN_CONFIGS: Record<string, Omit<RateLimitConfig, 'plan'>> = {
  free: {
    delayMs: 1200, // 50 requests per minute (with safety margin)
    batchSize: 5,
    requestsPerMinute: 50,
  },
  picnic: {
    delayMs: 300, // 200 requests per minute (with safety margin)
    batchSize: 20,
    requestsPerMinute: 200,
  },
  fiesta: {
    delayMs: 150, // 400 requests per minute (with safety margin)
    batchSize: 30,
    requestsPerMinute: 400,
  },
};

/**
 * Get rate limit configuration based on Pinata plan and optional overrides
 */
export function getRateLimitConfig(
  plan: 'free' | 'picnic' | 'fiesta' | 'custom',
  customDelayMs?: number,
  customBatchSize?: number
): RateLimitConfig {
  // If custom plan, require both custom values
  if (plan === 'custom') {
    if (!customDelayMs || !customBatchSize) {
      console.warn(
        'Custom plan selected but missing custom values, defaulting to free plan limits'
      );
      return {
        ...PLAN_CONFIGS.free,
        plan: 'custom',
      };
    }

    return {
      delayMs: customDelayMs,
      batchSize: customBatchSize,
      requestsPerMinute: Math.floor(60000 / customDelayMs),
      plan: 'custom',
    };
  }

  // Get base config for the plan
  const baseConfig = PLAN_CONFIGS[plan];
  if (!baseConfig) {
    console.warn(`Unknown plan: ${plan}, defaulting to free plan`);
    return {
      ...PLAN_CONFIGS.free,
      plan: 'free',
    };
  }

  // Apply overrides if provided
  const config: RateLimitConfig = {
    delayMs: customDelayMs ?? baseConfig.delayMs,
    batchSize: customBatchSize ?? baseConfig.batchSize,
    requestsPerMinute: customDelayMs
      ? Math.floor(60000 / customDelayMs)
      : baseConfig.requestsPerMinute,
    plan,
  };

  return config;
}

/**
 * Display rate limit configuration
 */
export function displayRateLimitConfig(config: RateLimitConfig): void {
  console.log('📊 RATE LIMITING CONFIGURATION:');
  console.log(`   • Plan: ${config.plan.toUpperCase()}`);
  console.log(`   • Delay between requests: ${config.delayMs}ms`);
  console.log(`   • Batch size: ${config.batchSize} hashes`);
  console.log(`   • Max requests per minute: ${config.requestsPerMinute}`);

  // Estimate processing time for 1000 hashes
  const batchesNeeded = Math.ceil(1000 / config.batchSize);
  const totalTimeMs = batchesNeeded * config.delayMs;
  const totalTimeMinutes = Math.round(totalTimeMs / 60000);
  console.log(
    `   • Estimated time for 1000 hashes: ~${totalTimeMinutes} minutes`
  );
}

/**
 * Calculate optimal batch size based on collection size and memory constraints
 */
export function calculateOptimalBatchSize(
  collectionSize: number,
  memoryLimitMB: number = 4096,
  baseConfig: RateLimitConfig
): number {
  // Rough estimate: each asset takes about 1KB in memory
  const estimatedMemoryPerAsset = 0.001; // MB
  const maxAssetsInMemory = Math.floor(memoryLimitMB / estimatedMemoryPerAsset);

  // Don't exceed base config batch size
  let optimalBatchSize = baseConfig.batchSize;

  // For very large collections, reduce batch size to manage memory
  if (collectionSize > 100000) {
    optimalBatchSize = Math.min(optimalBatchSize, 10);
  } else if (collectionSize > 50000) {
    optimalBatchSize = Math.min(optimalBatchSize, 15);
  }

  // Ensure we don't exceed memory limits
  if (optimalBatchSize * 1000 > maxAssetsInMemory) {
    optimalBatchSize = Math.floor(maxAssetsInMemory / 1000);
  }

  // Minimum batch size of 1
  return Math.max(1, optimalBatchSize);
}

/**
 * Sleep for a specified duration (used for rate limiting)
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rate limiter class for managing API request timing
 */
export class RateLimiter {
  private lastRequestTime: number = 0;
  private requestCount: number = 0;
  private windowStartTime: number = Date.now();

  constructor(private config: RateLimitConfig) {}

  /**
   * Wait if necessary to respect rate limits before making a request
   */
  async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    // Reset window if more than a minute has passed
    if (now - this.windowStartTime > 60000) {
      this.windowStartTime = now;
      this.requestCount = 0;
    }

    // Check if we're approaching the rate limit
    if (this.requestCount >= this.config.requestsPerMinute) {
      const waitTime = 60000 - (now - this.windowStartTime);
      if (waitTime > 0) {
        console.log(
          `⏳ Rate limit approaching, waiting ${Math.round(waitTime / 1000)}s...`
        );
        await sleep(waitTime);
        this.windowStartTime = Date.now();
        this.requestCount = 0;
      }
    }

    // Ensure minimum delay between requests
    if (timeSinceLastRequest < this.config.delayMs) {
      const waitTime = this.config.delayMs - timeSinceLastRequest;
      await sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  /**
   * Get current rate limit statistics
   */
  getStats(): { requestCount: number; timeInWindow: number } {
    return {
      requestCount: this.requestCount,
      timeInWindow: Date.now() - this.windowStartTime,
    };
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.lastRequestTime = 0;
    this.requestCount = 0;
    this.windowStartTime = Date.now();
  }
}
