import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeEnv, loadEnvConfig } from './envParser.js';

describe('safeEnv', () => {
  describe('bool', () => {
    it('should return default value for empty string', () => {
      expect(safeEnv.bool('', false)).toBe(false);
      expect(safeEnv.bool('', true)).toBe(true);
    });

    it('should return default value for undefined', () => {
      expect(safeEnv.bool(undefined, false)).toBe(false);
      expect(safeEnv.bool(undefined, true)).toBe(true);
    });

    it('should parse "true", "1", "yes" as true', () => {
      expect(safeEnv.bool('true')).toBe(true);
      expect(safeEnv.bool('TRUE')).toBe(true);
      expect(safeEnv.bool('1')).toBe(true);
      expect(safeEnv.bool('yes')).toBe(true);
      expect(safeEnv.bool('YES')).toBe(true);
    });

    it('should parse "false", "0", "no" as false', () => {
      expect(safeEnv.bool('false')).toBe(false);
      expect(safeEnv.bool('FALSE')).toBe(false);
      expect(safeEnv.bool('0')).toBe(false);
      expect(safeEnv.bool('no')).toBe(false);
      expect(safeEnv.bool('NO')).toBe(false);
    });

    it('should handle whitespace', () => {
      expect(safeEnv.bool('  true  ')).toBe(true);
      expect(safeEnv.bool('  false  ')).toBe(false);
      expect(safeEnv.bool('  ')).toBe(false);
    });

    it('should handle numeric values', () => {
      expect(safeEnv.bool('2')).toBe(true);
      expect(safeEnv.bool('-1')).toBe(true);
      expect(safeEnv.bool('0.5')).toBe(true);
    });
  });

  describe('number', () => {
    it('should return default value for empty string', () => {
      expect(safeEnv.number('', 100)).toBe(100);
    });

    it('should return default value for undefined', () => {
      expect(safeEnv.number(undefined, 100)).toBe(100);
    });

    it('should parse valid numbers', () => {
      expect(safeEnv.number('123', 0)).toBe(123);
      expect(safeEnv.number('-456', 0)).toBe(-456);
      expect(safeEnv.number('0.5', 0)).toBe(0.5);
    });

    it('should return default for invalid numbers', () => {
      expect(safeEnv.number('abc', 100)).toBe(100);
      expect(safeEnv.number('12abc', 100)).toBe(100);
    });

    it('should respect min constraint', () => {
      expect(safeEnv.number('5', 100, 10)).toBe(100);
      expect(safeEnv.number('15', 100, 10)).toBe(15);
    });

    it('should respect max constraint', () => {
      expect(safeEnv.number('150', 100, undefined, 120)).toBe(100);
      expect(safeEnv.number('110', 100, undefined, 120)).toBe(110);
    });

    it('should respect both min and max constraints', () => {
      expect(safeEnv.number('5', 100, 10, 50)).toBe(100);
      expect(safeEnv.number('55', 100, 10, 50)).toBe(100);
      expect(safeEnv.number('25', 100, 10, 50)).toBe(25);
    });

    it('should handle whitespace', () => {
      expect(safeEnv.number('  123  ', 0)).toBe(123);
      expect(safeEnv.number('  ', 100)).toBe(100);
    });
  });

  describe('string', () => {
    it('should return default value for empty string', () => {
      expect(safeEnv.string('', 'default')).toBe('default');
    });

    it('should return default value for undefined', () => {
      expect(safeEnv.string(undefined, 'default')).toBe('default');
    });

    it('should return trimmed string', () => {
      expect(safeEnv.string('hello')).toBe('hello');
      expect(safeEnv.string('  hello  ')).toBe('hello');
    });

    it('should handle whitespace-only strings', () => {
      expect(safeEnv.string('   ', 'default')).toBe('default');
    });
  });

  describe('enum', () => {
    const allowedValues = ['free', 'picnic', 'fiesta', 'custom'] as const;

    it('should return default value for empty string', () => {
      expect(safeEnv.enum('', allowedValues, 'free')).toBe('free');
    });

    it('should return default value for undefined', () => {
      expect(safeEnv.enum(undefined, allowedValues, 'free')).toBe('free');
    });

    it('should return valid enum values', () => {
      expect(safeEnv.enum('picnic', allowedValues, 'free')).toBe('picnic');
      expect(safeEnv.enum('fiesta', allowedValues, 'free')).toBe('fiesta');
    });

    it('should be case-insensitive', () => {
      expect(safeEnv.enum('PICNIC', allowedValues, 'free')).toBe('picnic');
      expect(safeEnv.enum('Fiesta', allowedValues, 'free')).toBe('fiesta');
    });

    it('should return default for invalid values', () => {
      expect(safeEnv.enum('invalid', allowedValues, 'free')).toBe('free');
    });

    it('should handle whitespace', () => {
      expect(safeEnv.enum('  picnic  ', allowedValues, 'free')).toBe('picnic');
    });
  });
});

describe('loadEnvConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all environment variables before each test
    Object.keys(process.env).forEach((key) => {
      delete process.env[key];
    });
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  it('should load default configuration when no env vars are set', () => {
    const config = loadEnvConfig();

    expect(config.atomicApiUrl).toBe('https://atomic.waxnet.io');
    expect(config.objectFile).toBe('./object.json');
    expect(config.autoChunkMode).toBe(false);
    expect(config.autoChunkCycle).toBe(false);
    expect(config.chunkDirectory).toBe('./chunks');
    expect(config.chunkPrefix).toBe('object-chunk');
    expect(config.maxPagesPerCollection).toBe(-1);
    expect(config.shouldFreshStart).toBe(false);
    expect(config.uploadCollectionNft).toBe(true);
    expect(config.uploadToken).toBe(true);
    expect(config.dryRun).toBe(false);
    expect(config.dryRunLimit).toBe(25);
    expect(config.pinataPlan).toBe('free');
    expect(config.trackUniqueHashes).toBe(true);
    expect(config.trackNotFoundHashes).toBe(true);
    expect(config.saveHashReport).toBe(true);
    expect(config.hashReportDir).toBe('./reports');
  });

  it('should load custom configuration from env vars', () => {
    process.env.ATOMIC_API_URL = 'https://custom.api.url';
    process.env.OBJECT_FILE = './custom.json';
    process.env.AUTO_CHUNK_MODE = '1';
    process.env.AUTO_CHUNK_CYCLE = '1';
    process.env.CHUNK_DIRECTORY = './custom-chunks';
    process.env.MAX_PAGES_PER_COLLECTION = '50';
    process.env.PINATA_PLAN = 'picnic';
    process.env.RATE_LIMIT_DELAY_MS = '500';
    process.env.BATCH_SIZE = '20';

    const config = loadEnvConfig();

    expect(config.atomicApiUrl).toBe('https://custom.api.url');
    expect(config.objectFile).toBe('./custom.json');
    expect(config.autoChunkMode).toBe(true);
    expect(config.autoChunkCycle).toBe(true);
    expect(config.chunkDirectory).toBe('./custom-chunks');
    expect(config.maxPagesPerCollection).toBe(50);
    expect(config.pinataPlan).toBe('picnic');
    expect(config.rateLimitDelayMs).toBe(500);
    expect(config.batchSize).toBe(20);
  });

  it('should handle empty string env vars safely', () => {
    process.env.AUTO_CHUNK_MODE = '';
    process.env.MAX_PAGES_PER_COLLECTION = '';
    process.env.PINATA_PLAN = '';
    process.env.RATE_LIMIT_DELAY_MS = '';

    const config = loadEnvConfig();

    expect(config.autoChunkMode).toBe(false);
    expect(config.maxPagesPerCollection).toBe(-1);
    expect(config.pinataPlan).toBe('free');
    expect(config.rateLimitDelayMs).toBeUndefined();
  });

  it('should validate numeric ranges', () => {
    process.env.MAX_PAGES_PER_COLLECTION = '20000'; // Above max
    process.env.ATOMIC_API_TIMEOUT_MS = '5000'; // Below min
    process.env.ATOMIC_API_RETRIES = '100'; // Above max

    const config = loadEnvConfig();

    expect(config.maxPagesPerCollection).toBe(-1); // Should use default
    expect(config.atomicApiTimeoutMs).toBe(60000); // Should use default
    expect(config.atomicApiRetries).toBe(10); // Should use default
  });
});
