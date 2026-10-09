import { describe, it, expect } from 'vitest';
import { overridesFromFlags } from './cli.js';

describe('overridesFromFlags', () => {
  it('maps flags onto config paths and leaves unset flags out', () => {
    expect(
      overridesFromFlags({
        targets: './t.json',
        'dry-run': true,
        'dry-run-limit': '5',
        chunks: true,
        'chunk-dir': './c',
        cycle: true,
        'max-pages': '3',
        'fresh-start': true,
        provider: 'kubo',
        'no-collections': true,
        'no-tokens': false,
        report: true,
        'log-level': 'debug',
        'log-format': 'json',
        progress: 'off',
      })
    ).toEqual({
      targets: { file: './t.json' },
      processing: {
        dryRun: true,
        dryRunLimit: 5,
        maxPagesPerCollection: 3,
        freshStart: true,
        collections: false,
      },
      chunks: { enabled: true, directory: './c', cycle: true },
      provider: { type: 'kubo' },
      tracking: { saveReport: true },
      logging: { level: 'debug', format: 'json', progress: 'off' },
    });
  });

  it('returns an empty object when no flags are given', () => {
    expect(overridesFromFlags({})).toEqual({});
  });

  it('rejects non-integer numeric flags', () => {
    expect(() => overridesFromFlags({ 'max-pages': 'many' })).toThrow(
      /--max-pages/
    );
  });
});
