#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ConfigError, loadConfig, redactConfig } from './config/load.js';
import type { ConfigOverrides } from './config/schema.js';
import { createOrchestrator } from './core/orchestrator.js';
import { loadTargets, writeChunks, TargetsError } from './core/targets.js';
import { createLogger } from './logging/logger.js';

const HELP = `atomic-pinner — pin the IPFS content referenced by AtomicAssets NFTs

Usage
  atomic-pinner [run] [options]      Process the targets file (or the next chunk)
  atomic-pinner chunk [options]      Split the targets file into chunk files
  atomic-pinner print-config         Show the effective configuration (secrets masked)

Run options
  -t, --targets <file>      Targets JSON file            (TARGETS_FILE)
  -n, --dry-run             Verify but never pin         (DRY_RUN)
      --dry-run-limit <n>   Assets per collection in dry run, -1 = page  (DRY_RUN_LIMIT)
      --chunks              Chunk mode                   (AUTO_CHUNK_MODE)
      --chunk-dir <dir>     Chunk directory              (CHUNK_DIRECTORY)
      --cycle               Restart from chunk 1 when all are done (AUTO_CHUNK_CYCLE)
      --max-pages <n>       Pages per collection per run (MAX_PAGES_PER_COLLECTION)
      --fresh-start         Delete progress before starting (FRESH_START)
      --provider <name>     pinata | kubo                (IPFS_PROVIDER)
      --no-collections      Skip the collection list     (PIN_COLLECTIONS=0)
      --no-tokens           Skip the token list          (PIN_TOKENS=0)
      --report              Write a JSON hash report     (SAVE_HASH_REPORT)
      --log-level <level>   silent|error|warn|info|debug (LOG_LEVEL)
      --log-format <fmt>    text | json                  (LOG_FORMAT)
      --progress <mode>     auto | on | off              (PROGRESS_BARS)

Chunk options
  -t, --targets <file>      Source targets file
      --chunk-dir <dir>     Output directory             (CHUNK_DIRECTORY)
      --per-chunk <n>       Collections per chunk file   (default 10)

General
      --env-file <path>     Load variables from this file instead of ./.env
  -h, --help                Show this help
  -v, --version             Show the version

Every option can also be set with the environment variable in parentheses.
Secrets (PINATA_JWT, webhook URLs) are only read from the environment.
`;

function version(): string {
  const pkg = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'package.json'
  );
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

const options = {
  targets: { type: 'string', short: 't' },
  'dry-run': { type: 'boolean', short: 'n' },
  'dry-run-limit': { type: 'string' },
  chunks: { type: 'boolean' },
  'chunk-dir': { type: 'string' },
  cycle: { type: 'boolean' },
  'max-pages': { type: 'string' },
  'fresh-start': { type: 'boolean' },
  provider: { type: 'string' },
  'no-collections': { type: 'boolean' },
  'no-tokens': { type: 'boolean' },
  report: { type: 'boolean' },
  'log-level': { type: 'string' },
  'log-format': { type: 'string' },
  progress: { type: 'string' },
  'per-chunk': { type: 'string' },
  'env-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Flags = ReturnType<
  typeof parseArgs<{ options: typeof options; allowPositionals: true }>
>['values'];

function integer(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n))
    throw new ConfigError(`--${name} must be an integer (got ${raw})`, []);
  return n;
}

export function overridesFromFlags(flags: Flags): ConfigOverrides {
  const o: ConfigOverrides = {};
  const set = <
    G extends keyof ConfigOverrides,
    K extends keyof NonNullable<ConfigOverrides[G]>,
  >(
    group: G,
    key: K,
    value: NonNullable<ConfigOverrides[G]>[K] | undefined
  ) => {
    if (value === undefined) return;
    (o[group] ??= {} as NonNullable<ConfigOverrides[G]>)[key] = value;
  };
  set('targets', 'file', flags.targets);
  set('processing', 'dryRun', flags['dry-run']);
  set(
    'processing',
    'dryRunLimit',
    integer('dry-run-limit', flags['dry-run-limit'])
  );
  set('chunks', 'enabled', flags.chunks);
  set('chunks', 'directory', flags['chunk-dir']);
  set('chunks', 'cycle', flags.cycle);
  set(
    'processing',
    'maxPagesPerCollection',
    integer('max-pages', flags['max-pages'])
  );
  set('processing', 'freshStart', flags['fresh-start']);
  set(
    'provider',
    'type',
    flags.provider as ConfigOverrides['provider'] extends infer P
      ? P extends { type?: infer T }
        ? T
        : never
      : never
  );
  set('processing', 'collections', flags['no-collections'] ? false : undefined);
  set('processing', 'tokens', flags['no-tokens'] ? false : undefined);
  set('tracking', 'saveReport', flags.report);
  set(
    'logging',
    'level',
    flags['log-level'] as ConfigOverrides['logging'] extends infer L
      ? L extends { level?: infer T }
        ? T
        : never
      : never
  );
  set('logging', 'format', flags['log-format'] as 'text' | 'json' | undefined);
  set(
    'logging',
    'progress',
    flags.progress as 'auto' | 'on' | 'off' | undefined
  );
  return o;
}

export async function main(
  argv: string[] = process.argv.slice(2)
): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof options; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: flags, positionals } = parsed;

  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(version() + '\n');
    return 0;
  }

  loadDotenv({ path: flags['env-file'] ?? path.resolve('.env'), quiet: true });

  const command = positionals[0] ?? 'run';
  const warnings: string[] = [];
  let config;
  try {
    config = loadConfig({
      overrides: overridesFromFlags(flags),
      warn: (m) => warnings.push(m),
      requireCredentials: command === 'run',
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const logger = createLogger({
    level: config.logging.level,
    format: config.logging.format,
  });
  for (const w of warnings) logger.warn(w);

  switch (command) {
    case 'print-config':
      process.stdout.write(
        JSON.stringify(redactConfig(config), null, 2) + '\n'
      );
      return 0;

    case 'chunk': {
      const perChunk = integer('per-chunk', flags['per-chunk']) ?? 10;
      try {
        const targets = await loadTargets(config.targets.file);
        const files = await writeChunks({
          targets,
          directory: config.chunks.directory,
          prefix: config.chunks.prefix,
          perChunk,
        });
        logger.info('Chunk files written', {
          count: files.length,
          directory: config.chunks.directory,
        });
        for (const f of files) process.stdout.write(f + '\n');
        return 0;
      } catch (error) {
        if (error instanceof TargetsError) {
          process.stderr.write(`${error.message}\n`);
          return 2;
        }
        throw error;
      }
    }

    case 'run': {
      try {
        const result = await createOrchestrator(config, { logger }).run();
        return result.success ? 0 : 1;
      } catch (error) {
        if (error instanceof TargetsError || error instanceof ConfigError) {
          process.stderr.write(`${error.message}\n`);
          return 2;
        }
        logger.error('Fatal error', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 1;
      }
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
      process.exit(1);
    }
  );
}
