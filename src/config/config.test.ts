import { describe, it, expect, vi } from 'vitest';
import { loadConfig, redactConfig, ConfigError } from './load.js';
import { listOptions } from './schema.js';
import { renderConfigReference, renderEnvExample } from './docs.js';

const base = { PINATA_JWT: 'jwt' };

describe('loadConfig', () => {
  it('applies defaults when nothing is set', () => {
    const config = loadConfig({ env: base });
    expect(config.atomic.apiUrl).toBe('https://wax.api.atomicassets.io');
    expect(config.targets.file).toBe('./pin-targets.json');
    expect(config.processing.collections).toBe(true);
    expect(config.processing.maxPagesPerCollection).toBe(-1);
    expect(config.provider.type).toBe('pinata');
    expect(config.provider.verificationGateways).toEqual([
      'https://gateway.pinata.cloud',
      'https://ipfs.io',
      'https://dweb.link',
    ]);
    expect(config.rateLimit.delayMs).toBeUndefined();
    expect(config.logging.level).toBe('info');
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({
      env: { ...base, DRY_RUN: '', BATCH_SIZE: '   ', PINATA_PLAN: '' },
    });
    expect(config.processing.dryRun).toBe(false);
    expect(config.rateLimit.batchSize).toBeUndefined();
    expect(config.provider.pinataPlan).toBe('free');
  });

  it('parses booleans in the common spellings', () => {
    for (const word of ['1', 'true', 'YES', 'on']) {
      expect(
        loadConfig({ env: { ...base, DRY_RUN: word } }).processing.dryRun
      ).toBe(true);
    }
    for (const word of ['0', 'false', 'No', 'off']) {
      expect(
        loadConfig({ env: { ...base, DRY_RUN: word } }).processing.dryRun
      ).toBe(false);
    }
  });

  it('rejects a boolean it cannot parse, naming the variable', () => {
    expect(() => loadConfig({ env: { ...base, DRY_RUN: 'maybe' } })).toThrow(
      /DRY_RUN/
    );
  });

  it('parses numbers and enforces ranges', () => {
    expect(
      loadConfig({ env: { ...base, BATCH_SIZE: '20' } }).rateLimit.batchSize
    ).toBe(20);
    expect(() => loadConfig({ env: { ...base, BATCH_SIZE: '500' } })).toThrow(
      ConfigError
    );
    expect(() => loadConfig({ env: { ...base, BATCH_SIZE: 'ten' } })).toThrow(
      /BATCH_SIZE/
    );
  });

  it('collects every problem in one error', () => {
    try {
      loadConfig({ env: { ...base, BATCH_SIZE: '0', LOG_LEVEL: 'loud' } });
      expect.fail('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems;
      expect(problems.some((p) => p.startsWith('BATCH_SIZE'))).toBe(true);
      expect(problems.some((p) => p.startsWith('LOG_LEVEL'))).toBe(true);
    }
  });

  it('parses comma-separated lists', () => {
    const config = loadConfig({
      env: {
        ...base,
        IPFS_VERIFICATION_GATEWAYS: ' https://a.example , https://b.example,, ',
      },
    });
    expect(config.provider.verificationGateways).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('lower-cases enums and maps the local alias to kubo', () => {
    expect(loadConfig({ env: { IPFS_PROVIDER: 'LOCAL' } }).provider.type).toBe(
      'kubo'
    );
    expect(
      loadConfig({ env: { ...base, PINATA_PLAN: 'Picnic' } }).provider
        .pinataPlan
    ).toBe('picnic');
  });

  it('honours deprecated aliases with a warning', () => {
    const warn = vi.fn();
    const config = loadConfig({
      env: {
        ...base,
        OBJECT_FILE: './old.json',
        UPLOAD_COLLECTION_NFT: '0',
        IPFS_VERIFICATION_GATEWAY: 'https://g.example',
      },
      warn,
    });
    expect(config.targets.file).toBe('./old.json');
    expect(config.processing.collections).toBe(false);
    expect(config.provider.verificationGateways).toEqual(['https://g.example']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('OBJECT_FILE is deprecated')
    );
  });

  it('prefers the new name over an alias', () => {
    const config = loadConfig({
      env: { ...base, TARGETS_FILE: './new.json', OBJECT_FILE: './old.json' },
    });
    expect(config.targets.file).toBe('./new.json');
  });

  it('lets overrides win over the environment', () => {
    const config = loadConfig({
      env: { ...base, DRY_RUN: '0', TARGETS_FILE: './env.json' },
      overrides: {
        processing: { dryRun: true },
        targets: { file: './flag.json' },
      },
    });
    expect(config.processing.dryRun).toBe(true);
    expect(config.targets.file).toBe('./flag.json');
  });

  it('requires PINATA_JWT for the pinata provider unless dry running', () => {
    expect(() => loadConfig({ env: {} })).toThrow(/PINATA_JWT/);
    expect(loadConfig({ env: { DRY_RUN: '1' } }).provider.pinataJwt).toBe('');
    expect(loadConfig({ env: { IPFS_PROVIDER: 'kubo' } }).provider.type).toBe(
      'kubo'
    );
  });
});

describe('redactConfig', () => {
  it('masks secrets and leaves the rest alone', () => {
    const config = loadConfig({
      env: { ...base, SLACK_WEBHOOK_URL: 'https://hooks.slack.example/x' },
    });
    const redacted = redactConfig(config);
    expect(redacted.provider.pinataJwt).toBe('***');
    expect(redacted.notifications.slackWebhookUrl).toBe('***');
    expect(redacted.notifications.webhookUrl).toBeUndefined();
    expect(redacted.atomic.apiUrl).toBe(config.atomic.apiUrl);
    expect(config.provider.pinataJwt).toBe('jwt');
  });
});

describe('generated docs', () => {
  it('mention every variable', () => {
    const reference = renderConfigReference();
    const example = renderEnvExample();
    for (const { spec } of listOptions()) {
      expect(reference).toContain(`\`${spec.env}\``);
      expect(example).toContain(spec.env);
    }
  });

  it('leave secrets uncommented and defaults commented in .env.example', () => {
    const example = renderEnvExample();
    expect(example).toMatch(/^PINATA_JWT=/m);
    expect(example).toMatch(
      /^# ATOMIC_API_URL=https:\/\/wax\.api\.atomicassets\.io$/m
    );
    expect(example).toMatch(/^# DRY_RUN=0$/m);
  });
});
