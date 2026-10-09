import cliProgress from 'cli-progress';

export interface ProgressBar {
  update(value: number, label?: string): void;
  increment(label?: string): void;
  stop(): void;
}

export interface ProgressReporter {
  bar(name: string, total: number): ProgressBar;
}

const noopBar: ProgressBar = { update() {}, increment() {}, stop() {} };

export const noopProgress: ProgressReporter = { bar: () => noopBar };

export interface ProgressOptions {
  enabled: boolean;
  stream?: NodeJS.WritableStream;
}

/** Progress bars on stderr. Disabled bars are no-ops so callers never branch. */
export function createProgressReporter(
  options: ProgressOptions
): ProgressReporter {
  if (!options.enabled) return noopProgress;
  const stream = options.stream ?? process.stderr;

  return {
    bar(name, total) {
      if (total <= 0) return noopBar;
      const bar = new cliProgress.SingleBar(
        {
          format: `${name} |{bar}| {percentage}% | {value}/{total} | {label} | ETA: {eta}s`,
          barCompleteChar: '█',
          barIncompleteChar: '░',
          hideCursor: true,
          clearOnComplete: false,
          stopOnComplete: true,
          stream,
        },
        cliProgress.Presets.shades_classic
      );
      let current = 0;
      bar.start(total, 0, { label: 'starting' });
      return {
        update(value, label) {
          current = value;
          bar.update(value, label ? { label } : undefined);
        },
        increment(label) {
          current += 1;
          bar.update(current, label ? { label } : undefined);
        },
        stop() {
          bar.stop();
        },
      };
    },
  };
}

export function progressEnabled(
  mode: 'auto' | 'on' | 'off',
  stream: NodeJS.WriteStream = process.stderr
): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return Boolean(stream.isTTY);
}
