export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export type LogFormat = 'text' | 'json';
export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Logger that adds these fields to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Receives one fully formatted line per call. Defaults to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
  fields?: LogFields;
}

const PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function formatValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'string')
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function serializeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { name: value.name, message: value.message }
        : value;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'text';
  const write =
    options.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = options.now ?? (() => new Date());
  const base = options.fields ?? {};

  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: LogFields
  ) => {
    if (PRIORITY[lvl] > PRIORITY[level]) return;
    const all = { ...base, ...(fields ?? {}) };
    if (format === 'json') {
      write(
        JSON.stringify({
          time: now().toISOString(),
          level: lvl,
          msg: message,
          ...serializeFields(all),
        })
      );
      return;
    }
    const time = now().toISOString().slice(11, 19);
    const extras = Object.entries(all)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(' ');
    write(
      `${time} ${lvl.toUpperCase().padEnd(5)} ${message}${extras ? ' ' + extras : ''}`
    );
  };

  return {
    level,
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    child: (fields) =>
      createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({
  level: 'silent',
  write: () => {},
});
