/**
 * The single source of truth for configuration.
 *
 * Every option is declared once here with its environment variable, type, default,
 * validation and description. `load.ts` reads the environment through this table,
 * `docs.ts` renders the README reference and `.env.example` from it, and the CLI maps
 * flags onto the same paths. Add an option here and everything else follows.
 */
import { z } from 'zod';

export type OptionKind = 'string' | 'boolean' | 'number' | 'enum' | 'list';

export interface OptionSpec<T, D extends T | undefined = T> {
  /** Environment variable name. */
  env: string;
  /** How a raw environment string is coerced before validation. */
  kind: OptionKind;
  /** Validation applied to a provided value. Defaults are applied separately. */
  schema: z.ZodType<T>;
  /** Used when the variable is unset or empty. `undefined` makes the option optional. */
  default: D;
  /** One or two sentences for the docs. */
  description: string;
  /** Redacted from `--print-config` output and logs. */
  secret?: boolean;
  /** Older variable names that still populate this option, with a deprecation warning. */
  aliases?: string[];
  /** Example value for `.env.example` when the default is empty. */
  example?: string;
}

function opt<T, D extends T | undefined = T>(
  spec: OptionSpec<T, D>
): OptionSpec<T, D> {
  return spec;
}

const bool = (
  env: string,
  def: boolean,
  description: string,
  extra: Partial<OptionSpec<boolean>> = {}
) =>
  opt<boolean>({
    env,
    kind: 'boolean',
    schema: z.boolean(),
    default: def,
    description,
    ...extra,
  });

const int = (
  env: string,
  def: number,
  min: number,
  max: number,
  description: string,
  extra: Partial<OptionSpec<number>> = {}
) =>
  opt<number>({
    env,
    kind: 'number',
    schema: z.number().int().min(min).max(max),
    default: def,
    description,
    ...extra,
  });

const str = (
  env: string,
  def: string,
  description: string,
  extra: Partial<OptionSpec<string>> = {}
) =>
  opt<string>({
    env,
    kind: 'string',
    schema: z.string(),
    default: def,
    description,
    ...extra,
  });

export const PINATA_PLANS = ['free', 'picnic', 'fiesta', 'custom'] as const;
export const PROVIDER_TYPES = ['pinata', 'kubo'] as const;
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export const LOG_FORMATS = ['text', 'json'] as const;
export const PROGRESS_MODES = ['auto', 'on', 'off'] as const;

export const configSpec = {
  atomic: {
    apiUrl: opt<string>({
      env: 'ATOMIC_API_URL',
      kind: 'string',
      schema: z.string().url(),
      default: 'https://wax.api.atomicassets.io',
      description:
        "AtomicAssets API base URL. The default is the public WAX endpoint run by pink.gg; point it at another chain's API to use the tool elsewhere.",
    }),
    pageSize: int(
      'ATOMIC_PAGE_SIZE',
      1000,
      1,
      1000,
      'Assets requested per API page.'
    ),
    timeoutMs: int(
      'ATOMIC_API_TIMEOUT_MS',
      60000,
      1000,
      300000,
      'Timeout for one AtomicAssets HTTP request.'
    ),
    retries: int(
      'ATOMIC_API_RETRIES',
      5,
      1,
      50,
      'HTTP attempts per AtomicAssets request. Network errors, 408, 429 and 5xx are retried.'
    ),
    retryAttempts: int(
      'ATOMIC_RETRY_MAX_ATTEMPTS',
      3,
      1,
      10,
      'Application-level attempts per page fetch, on top of the HTTP retries.'
    ),
    retryBaseDelayMs: int(
      'ATOMIC_RETRY_BASE_DELAY_MS',
      1000,
      100,
      10000,
      'Base delay for the exponential backoff between application-level attempts.'
    ),
  },
  targets: {
    file: str(
      'TARGETS_FILE',
      './pin-targets.json',
      'JSON file listing the collections and tokens to pin. Ignored when chunk mode is on.',
      { aliases: ['OBJECT_FILE'] }
    ),
  },
  chunks: {
    enabled: bool(
      'AUTO_CHUNK_MODE',
      false,
      'Process the next unfinished chunk file from the chunk directory instead of the targets file.'
    ),
    cycle: bool(
      'AUTO_CHUNK_CYCLE',
      false,
      'When every chunk is done, clear chunk progress and start over from the first.'
    ),
    directory: str(
      'CHUNK_DIRECTORY',
      './chunks',
      'Directory holding chunk files.'
    ),
    prefix: str(
      'CHUNK_FILE_PREFIX',
      'targets-chunk',
      'Chunk files are named `<prefix>-NN.json`.'
    ),
  },
  processing: {
    collections: bool(
      'PIN_COLLECTIONS',
      true,
      'Process the `collection` list.',
      { aliases: ['UPLOAD_COLLECTION_NFT'] }
    ),
    tokens: bool('PIN_TOKENS', true, 'Process the `token` list.', {
      aliases: ['UPLOAD_TOKEN'],
    }),
    maxPagesPerCollection: int(
      'MAX_PAGES_PER_COLLECTION',
      -1,
      -1,
      100000,
      'Pages fetched per collection per run before pausing it until the next run. -1 = unlimited.'
    ),
    dryRun: bool(
      'DRY_RUN',
      false,
      'Analyse and verify, but never pin. Progress is not saved.'
    ),
    dryRunLimit: int(
      'DRY_RUN_LIMIT',
      25,
      -1,
      100000,
      'Assets inspected per collection in a dry run. -1 = whole first page.'
    ),
    freshStart: bool(
      'FRESH_START',
      false,
      'Delete the progress file before starting. The confirmed-pinned cache is kept.'
    ),
  },
  provider: {
    type: opt<(typeof PROVIDER_TYPES)[number]>({
      env: 'IPFS_PROVIDER',
      kind: 'enum',
      schema: z.enum(PROVIDER_TYPES),
      default: 'pinata',
      description:
        'Where to pin: `pinata` (cloud) or `kubo` (your own IPFS node; `local` is accepted as an alias).',
    }),
    pinataJwt: str(
      'PINATA_JWT',
      '',
      'Pinata API JWT with pinning permission. Required for the pinata provider.',
      {
        secret: true,
        example: 'eyJhbGciOi...',
      }
    ),
    pinataPlan: opt<(typeof PINATA_PLANS)[number]>({
      env: 'PINATA_PLAN',
      kind: 'enum',
      schema: z.enum(PINATA_PLANS),
      default: 'free',
      description:
        'Pinata plan. Picks a request delay and batch size that stay under the plan limits.',
    }),
    kuboApiUrl: opt<string>({
      env: 'IPFS_API_URL',
      kind: 'string',
      schema: z.string().url(),
      default: 'http://127.0.0.1:5001',
      description: 'Kubo RPC API. Used by the kubo provider.',
    }),
    kuboGatewayUrl: opt<string>({
      env: 'IPFS_GATEWAY_URL',
      kind: 'string',
      schema: z.string().url(),
      default: 'http://127.0.0.1:8080',
      description:
        'Gateway of your Kubo node. Tried first for existence checks when the kubo provider is selected.',
    }),
    verificationGateways: opt<string[]>({
      env: 'IPFS_VERIFICATION_GATEWAYS',
      kind: 'list',
      schema: z.array(z.string().url()).min(1),
      default: [
        'https://gateway.pinata.cloud',
        'https://ipfs.io',
        'https://dweb.link',
      ],
      description:
        'Comma-separated gateways tried in order to confirm a CID is retrievable before pinning. A CID is only treated as missing when every gateway fails.',
      aliases: ['IPFS_VERIFICATION_GATEWAY'],
    }),
    pinRetries: int(
      'PIN_RETRIES',
      3,
      1,
      10,
      'Attempts per pin request before the CID is recorded as failed.'
    ),
  },
  rateLimit: {
    delayMs: opt<number, undefined>({
      env: 'RATE_LIMIT_DELAY_MS',
      kind: 'number',
      schema: z.number().int().min(0).max(60000),
      default: undefined,
      description:
        'Pause after each provider or gateway call. Overrides the plan preset.',
    }),
    batchSize: opt<number, undefined>({
      env: 'BATCH_SIZE',
      kind: 'number',
      schema: z.number().int().min(1).max(100),
      default: undefined,
      description:
        'CIDs processed between the longer inter-batch pauses. Overrides the plan preset.',
    }),
  },
  tracking: {
    uniqueHashes: bool(
      'TRACK_UNIQUE_HASHES',
      true,
      'Keep the set of unique CIDs seen, for the summary and report.'
    ),
    notFoundHashes: bool(
      'TRACK_NOT_FOUND_HASHES',
      true,
      'Keep the list of CIDs no gateway could retrieve.'
    ),
    saveReport: bool(
      'SAVE_HASH_REPORT',
      false,
      'Write a JSON report of CIDs, sources and missing content at the end of a run.'
    ),
    reportDir: str(
      'HASH_REPORT_DIR',
      './reports',
      'Directory for JSON reports.'
    ),
  },
  state: {
    progressFile: str(
      'PROGRESS_FILE',
      './progress.json',
      'Resume cursor: collection pages, chunk status, token completion. Must persist between runs.'
    ),
    cacheFile: str(
      'PERSISTENT_CACHE_FILE',
      './confirmed-pinned-hashes.json',
      'CIDs confirmed pinned. Prevents re-pinning across runs. Must persist between runs.'
    ),
  },
  notifications: {
    webhookUrl: opt<string, undefined>({
      env: 'WEBHOOK_URL',
      kind: 'string',
      schema: z.string().url(),
      default: undefined,
      description: 'POST a JSON summary here when a run starts and finishes.',
      secret: true,
    }),
    slackWebhookUrl: opt<string, undefined>({
      env: 'SLACK_WEBHOOK_URL',
      kind: 'string',
      schema: z.string().url(),
      default: undefined,
      description: 'Slack incoming-webhook URL for start and finish messages.',
      secret: true,
    }),
  },
  logging: {
    level: opt<(typeof LOG_LEVELS)[number]>({
      env: 'LOG_LEVEL',
      kind: 'enum',
      schema: z.enum(LOG_LEVELS),
      default: 'info',
      description: 'silent, error, warn, info or debug.',
    }),
    format: opt<(typeof LOG_FORMATS)[number]>({
      env: 'LOG_FORMAT',
      kind: 'enum',
      schema: z.enum(LOG_FORMATS),
      default: 'text',
      description:
        '`text` for humans, `json` (one object per line) for log collectors.',
    }),
    progress: opt<(typeof PROGRESS_MODES)[number]>({
      env: 'PROGRESS_BARS',
      kind: 'enum',
      schema: z.enum(PROGRESS_MODES),
      default: 'auto',
      description: 'Progress bars on stderr: `auto` shows them only on a TTY.',
    }),
  },
} as const;

export type ConfigSpec = typeof configSpec;

type LeafValue<S> =
  S extends OptionSpec<infer T, infer D>
    ? D extends undefined
      ? T | undefined
      : T
    : never;

export type Config = {
  [G in keyof ConfigSpec]: {
    [K in keyof ConfigSpec[G]]: LeafValue<ConfigSpec[G][K]>;
  };
};

/** Deep partial of Config, used for programmatic overrides (CLI flags, tests). */
export type ConfigOverrides = {
  [G in keyof Config]?: { [K in keyof Config[G]]?: Config[G][K] };
};

export interface OptionRef {
  group: keyof ConfigSpec;
  key: string;
  spec: OptionSpec<unknown, unknown>;
}

/** Every option as a flat list, in declaration order. */
export function listOptions(): OptionRef[] {
  const refs: OptionRef[] = [];
  for (const group of Object.keys(configSpec) as (keyof ConfigSpec)[]) {
    const options = configSpec[group] as Record<
      string,
      OptionSpec<unknown, unknown>
    >;
    for (const key of Object.keys(options)) {
      refs.push({ group, key, spec: options[key] });
    }
  }
  return refs;
}

function leafSchema(spec: OptionSpec<unknown, unknown>): z.ZodTypeAny {
  return spec.default === undefined
    ? spec.schema.optional()
    : spec.schema.default(spec.default);
}

/** Zod schema assembled from the spec. Parsing applies defaults and validation. */
export const configSchema = z.object(
  Object.fromEntries(
    (Object.keys(configSpec) as (keyof ConfigSpec)[]).map((group) => [
      group,
      z.object(
        Object.fromEntries(
          Object.entries(
            configSpec[group] as Record<string, OptionSpec<unknown, unknown>>
          ).map(([key, spec]) => [key, leafSchema(spec)])
        )
      ),
    ])
  )
);
