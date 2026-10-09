import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { overridesFromFlags, main } from './cli.js';

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

describe('main', () => {
  let out: string[];
  let err: string[];
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-cli-'));
    await fs.writeFile(path.join(dir, 'empty.env'), '');
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const envFile = () => ['--env-file', path.join(dir, 'empty.env')];

  it('prints help and version', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(out.join('')).toContain('Usage');
    out.length = 0;
    expect(await main(['--version'])).toBe(0);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('rejects unknown flags and commands with exit code 2', async () => {
    expect(await main(['--bogus'])).toBe(2);
    expect(err.join('')).toContain('--bogus');
    expect(await main(['frobnicate', ...envFile()])).toBe(2);
    expect(err.join('')).toContain('Unknown command: frobnicate');
  });

  it('prints the effective configuration with secrets masked', async () => {
    process.env.PINATA_JWT = 'super-secret';
    process.env.DRY_RUN = '1';
    expect(await main(['print-config', ...envFile()])).toBe(0);
    const printed = JSON.parse(out.join(''));
    expect(printed.provider.pinataJwt).toBe('***');
    expect(printed.processing.dryRun).toBe(true);
  });

  it('reports invalid configuration by variable name', async () => {
    process.env.BATCH_SIZE = 'lots';
    expect(await main(['print-config', ...envFile()])).toBe(2);
    expect(err.join('')).toContain('BATCH_SIZE');
  });

  it('writes chunk files without needing provider credentials', async () => {
    const targets = path.join(dir, 't.json');
    await fs.writeFile(
      targets,
      JSON.stringify({ collection: ['a', 'b', 'c'] })
    );
    const code = await main([
      'chunk',
      '--targets',
      targets,
      '--chunk-dir',
      path.join(dir, 'chunks'),
      '--per-chunk',
      '2',
      '--log-level',
      'silent',
      ...envFile(),
    ]);
    expect(code).toBe(0);
    expect(
      out
        .join('')
        .trim()
        .split('\n')
        .map((f) => path.basename(f))
    ).toEqual(['targets-chunk-01.json', 'targets-chunk-02.json']);
  });

  it('fails a run cleanly when the targets file is missing', async () => {
    const code = await main([
      'run',
      '--dry-run',
      '--targets',
      path.join(dir, 'nope.json'),
      '--log-level',
      'silent',
      ...envFile(),
    ]);
    expect(code).toBe(2);
    expect(err.join('')).toContain('nope.json');
  });
});
