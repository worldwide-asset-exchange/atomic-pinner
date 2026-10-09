/**
 * Safe environment variable parsing utilities for CI/container deployments
 * Handles empty strings, null, undefined safely with sensible defaults
 */

export interface SafeEnvParser {
  bool: (envVar: string | undefined, defaultValue?: boolean) => boolean;
  number: (
    envVar: string | undefined,
    defaultValue: number,
    min?: number,
    max?: number
  ) => number;
  string: (envVar: string | undefined, defaultValue?: string) => string;
  enum: <T extends string>(
    envVar: string | undefined,
    allowedValues: readonly T[],
    defaultValue: T
  ) => T;
}

export const safeEnv: SafeEnvParser = {
  /**
   * Parse boolean: handles empty strings, null, undefined safely
   */
  bool: (
    envVar: string | undefined,
    defaultValue: boolean = false
  ): boolean => {
    if (!envVar || envVar.trim() === '') return defaultValue;
    const trimmed = envVar.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') return true;
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'no')
      return false;
    const num = Number(trimmed);
    return !isNaN(num) && num !== 0;
  },

  /**
   * Parse number: handles empty strings, validates ranges
   */
  number: (
    envVar: string | undefined,
    defaultValue: number,
    min?: number,
    max?: number
  ): number => {
    if (!envVar || envVar.trim() === '') return defaultValue;
    const num = Number(envVar.trim());
    if (isNaN(num)) return defaultValue;
    if (min !== undefined && num < min) return defaultValue;
    if (max !== undefined && num > max) return defaultValue;
    return num;
  },

  /**
   * Parse string: handles empty strings, provides defaults
   */
  string: (envVar: string | undefined, defaultValue: string = ''): string => {
    if (!envVar || envVar.trim() === '') return defaultValue;
    return envVar.trim();
  },

  /**
   * Parse enum: validates against allowed values
   */
  enum: <T extends string>(
    envVar: string | undefined,
    allowedValues: readonly T[],
    defaultValue: T
  ): T => {
    if (!envVar || envVar.trim() === '') return defaultValue;
    const trimmed = envVar.trim().toLowerCase() as T;
    return allowedValues
      .map((v) => v.toLowerCase())
      .includes(trimmed.toLowerCase())
      ? (allowedValues.find(
          (v) => v.toLowerCase() === trimmed.toLowerCase()
        ) as T)
      : defaultValue;
  },
};

/**
 * Legacy function for backward compatibility
 */
export const parseBoolEnv = (envVar: string | undefined): boolean =>
  safeEnv.bool(envVar, false);

/**
 * Environment configuration interface
 */
export interface EnvConfig {
  // Core configuration
  atomicApiUrl: string;
  objectFile: string;

  // Auto-chunk mode configuration
  autoChunkMode: boolean;
  autoChunkCycle: boolean;
  chunkDirectory: string;
  chunkPrefix: string;

  // Collection processing limits
  maxPagesPerCollection: number;

  // Fresh start mode
  shouldFreshStart: boolean;

  // Feature flags
  uploadCollectionNft: boolean;
  uploadToken: boolean;

  // Dry run configuration
  dryRun: boolean;
  dryRunLimit: number;

  // Rate limiting
  pinataPlan: 'free' | 'picnic' | 'fiesta' | 'custom';
  rateLimitDelayMs?: number;
  batchSize?: number;

  // Hash tracking
  trackUniqueHashes: boolean;
  trackNotFoundHashes: boolean;
  saveHashReport: boolean;
  hashReportDir: string;

  // Slack notifications
  slackToken?: string;
  slackChannel?: string;

  // Error handling
  atomicApiTimeoutMs: number;
  atomicApiRetries: number;
  atomicRetryMaxAttempts: number;
  atomicRetryBaseDelayMs: number;
  enableGracefulRecovery: boolean;
  maxConsecutiveFailures: number;

  // IPFS provider configuration
  ipfsProvider: 'pinata' | 'local';
  pinataJwt?: string;
  ipfsApiUrl?: string;
  ipfsGatewayUrl?: string;
  ipfsVerificationGateway: string;

  // Debug mode
  debugAuth: boolean;
}

/**
 * Load and parse environment configuration
 */
export function loadEnvConfig(): EnvConfig {
  return {
    // Core configuration
    atomicApiUrl: safeEnv.string(
      process.env.ATOMIC_API_URL,
      'https://atomic.waxnet.io'
    ),
    objectFile: safeEnv.string(process.env.OBJECT_FILE, './object.json'),

    // Auto-chunk mode configuration
    autoChunkMode: safeEnv.bool(process.env.AUTO_CHUNK_MODE, false),
    autoChunkCycle: safeEnv.bool(process.env.AUTO_CHUNK_CYCLE, false),
    chunkDirectory: safeEnv.string(process.env.CHUNK_DIRECTORY, './chunks'),
    chunkPrefix: safeEnv.string(process.env.CHUNK_FILE_PREFIX, 'object-chunk'),

    // Collection processing limits
    maxPagesPerCollection: safeEnv.number(
      process.env.MAX_PAGES_PER_COLLECTION,
      -1,
      -1,
      10000
    ),

    // Fresh start mode
    shouldFreshStart: safeEnv.bool(process.env.FRESH_START, false),

    // Feature flags
    uploadCollectionNft: safeEnv.bool(process.env.UPLOAD_COLLECTION_NFT, true),
    uploadToken: safeEnv.bool(process.env.UPLOAD_TOKEN, true),

    // Dry run configuration
    dryRun: safeEnv.bool(process.env.DRY_RUN, false),
    dryRunLimit: safeEnv.number(process.env.DRY_RUN_LIMIT, 25, -1, 10000),

    // Rate limiting
    pinataPlan: safeEnv.enum(
      process.env.PINATA_PLAN,
      ['free', 'picnic', 'fiesta', 'custom'],
      'free'
    ),
    rateLimitDelayMs: process.env.RATE_LIMIT_DELAY_MS
      ? safeEnv.number(process.env.RATE_LIMIT_DELAY_MS, 1000, 50, 10000)
      : undefined,
    batchSize: process.env.BATCH_SIZE
      ? safeEnv.number(process.env.BATCH_SIZE, 10, 1, 100)
      : undefined,

    // Hash tracking
    trackUniqueHashes: safeEnv.bool(process.env.TRACK_UNIQUE_HASHES, true),
    trackNotFoundHashes: safeEnv.bool(process.env.TRACK_NOT_FOUND_HASHES, true),
    saveHashReport: safeEnv.bool(process.env.SAVE_HASH_REPORT, true),
    hashReportDir: safeEnv.string(process.env.HASH_REPORT_DIR, './reports'),

    // Slack notifications
    slackToken: safeEnv.string(process.env.SLACK_TOKEN, ''),
    slackChannel: safeEnv.string(process.env.SLACK_CHANNEL, ''),

    // Error handling
    atomicApiTimeoutMs: safeEnv.number(
      process.env.ATOMIC_API_TIMEOUT_MS,
      60000,
      10000,
      300000
    ),
    atomicApiRetries: safeEnv.number(process.env.ATOMIC_API_RETRIES, 10, 1, 50),
    atomicRetryMaxAttempts: safeEnv.number(
      process.env.ATOMIC_RETRY_MAX_ATTEMPTS,
      3,
      1,
      10
    ),
    atomicRetryBaseDelayMs: safeEnv.number(
      process.env.ATOMIC_RETRY_BASE_DELAY_MS,
      1000,
      100,
      10000
    ),
    enableGracefulRecovery: safeEnv.bool(
      process.env.ENABLE_GRACEFUL_RECOVERY,
      true
    ),
    maxConsecutiveFailures: safeEnv.number(
      process.env.MAX_CONSECUTIVE_FAILURES,
      3,
      1,
      10
    ),

    // IPFS provider configuration
    ipfsProvider: safeEnv.enum(
      process.env.IPFS_PROVIDER,
      ['pinata', 'local'],
      'pinata'
    ),
    pinataJwt: safeEnv.string(process.env.PINATA_JWT, ''),
    ipfsApiUrl: safeEnv.string(process.env.IPFS_API_URL, ''),
    ipfsGatewayUrl: safeEnv.string(process.env.IPFS_GATEWAY_URL, ''),
    ipfsVerificationGateway: safeEnv.string(
      process.env.IPFS_VERIFICATION_GATEWAY,
      'https://gateway.pinata.cloud'
    ),

    // Debug mode
    debugAuth: safeEnv.bool(process.env.DEBUG_AUTH, false),
  };
}
