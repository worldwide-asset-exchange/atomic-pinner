import { z } from 'zod';
import {
  configSchema,
  configSpec,
  listOptions,
  type Config,
  type ConfigOverrides,
  type OptionSpec,
} from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly problems: string[]
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Applied after the environment; CLI flags land here. */
  overrides?: ConfigOverrides;
  /** Receives deprecation notices for alias variables. */
  warn?: (message: string) => void;
  /** Check that the selected provider has its credentials. Off for commands that never pin. */
  requireCredentials?: boolean;
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/** Values that still mean "use the alias target" for enum options. */
const ENUM_ALIASES: Record<string, Record<string, string>> = {
  IPFS_PROVIDER: { local: 'kubo' },
};

export function coerceEnvValue(
  spec: OptionSpec<unknown, unknown>,
  raw: string
): unknown {
  const value = raw.trim();
  switch (spec.kind) {
    case 'boolean': {
      const word = value.toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      return value; // let validation report it
    }
    case 'number': {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'list':
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'enum': {
      const lower = value.toLowerCase();
      return ENUM_ALIASES[spec.env]?.[lower] ?? lower;
    }
    default:
      return value;
  }
}

function readEnv(
  env: NodeJS.ProcessEnv,
  spec: OptionSpec<unknown, unknown>,
  warn: (m: string) => void
): unknown {
  const direct = env[spec.env];
  if (direct !== undefined && direct.trim() !== '') {
    return coerceEnvValue(spec, direct);
  }
  for (const alias of spec.aliases ?? []) {
    const value = env[alias];
    if (value !== undefined && value.trim() !== '') {
      warn(`${alias} is deprecated; use ${spec.env} instead.`);
      return coerceEnvValue(spec, value);
    }
  }
  return undefined;
}

function envNameFor(path: (string | number)[]): string {
  const [group, key] = path;
  const options = (
    configSpec as Record<string, Record<string, OptionSpec<unknown, unknown>>>
  )[String(group)];
  return options?.[String(key)]?.env ?? path.join('.');
}

function formatIssue(
  issue: z.ZodIssue,
  raw: Record<string, Record<string, unknown>>
): string {
  const [group, key] = issue.path;
  const value = raw[String(group)]?.[String(key)];
  const shown = value === undefined ? 'unset' : JSON.stringify(value);
  return `${envNameFor(issue.path)}: ${issue.message} (got ${shown})`;
}

/**
 * Build a Config from the environment plus optional overrides. Empty variables are treated as
 * unset so CI systems that export every variable with a blank value get the defaults. Invalid
 * values raise a ConfigError that names the variable.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const warn = options.warn ?? (() => {});

  const raw: Record<string, Record<string, unknown>> = {};
  for (const { group, key, spec } of listOptions()) {
    raw[group] ??= {};
    const fromEnv = readEnv(env, spec, warn);
    const override = (
      options.overrides as Record<string, Record<string, unknown> | undefined>
    )?.[group]?.[key];
    const value = override !== undefined ? override : fromEnv;
    if (value !== undefined) raw[group][key] = value;
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) =>
      formatIssue(issue, raw)
    );
    throw new ConfigError(
      `Invalid configuration:\n  - ${problems.join('\n  - ')}`,
      problems
    );
  }
  const config = result.data as Config;

  const problems: string[] = [];
  const requireCredentials = options.requireCredentials ?? true;
  if (
    requireCredentials &&
    config.provider.type === 'pinata' &&
    !config.provider.pinataJwt &&
    !config.processing.dryRun
  ) {
    problems.push(
      'PINATA_JWT: required when IPFS_PROVIDER=pinata (set DRY_RUN=1 to analyse without a key)'
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid configuration:\n  - ${problems.join('\n  - ')}`,
      problems
    );
  }
  return config;
}

/** Copy of the config with secret values masked, safe to print or log. */
export function redactConfig(config: Config): Config {
  const copy = structuredClone(config) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  for (const { group, key, spec } of listOptions()) {
    if (spec.secret && copy[group][key]) copy[group][key] = '***';
  }
  return copy as unknown as Config;
}
