import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import {
  createProgressReporter,
  noopProgress,
  progressEnabled,
} from './progress.js';

function ttyStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  }) as Writable & { isTTY: boolean; columns: number };
  stream.isTTY = true;
  stream.columns = 80;
  return { stream, chunks };
}

describe('progressEnabled', () => {
  it('follows the explicit modes and falls back to the TTY check', () => {
    const tty = { isTTY: true } as NodeJS.WriteStream;
    const pipe = { isTTY: false } as NodeJS.WriteStream;
    expect(progressEnabled('on', pipe)).toBe(true);
    expect(progressEnabled('off', tty)).toBe(false);
    expect(progressEnabled('auto', tty)).toBe(true);
    expect(progressEnabled('auto', pipe)).toBe(false);
  });
});

describe('createProgressReporter', () => {
  it('is a no-op when disabled', () => {
    const bar = createProgressReporter({ enabled: false }).bar('x', 10);
    expect(() => {
      bar.update(1, 'a');
      bar.increment('b');
      bar.stop();
    }).not.toThrow();
    expect(noopProgress.bar('y', 3)).toBeDefined();
  });

  it('renders to the given stream when enabled', () => {
    const { stream, chunks } = ttyStream();
    const bar = createProgressReporter({ enabled: true, stream }).bar(
      'Collections',
      4
    );
    bar.update(1, 'first');
    bar.increment('second');
    bar.stop();
    const out = chunks.join('');
    expect(out).toContain('Collections');
    expect(out).toContain('2/4');
    expect(out).toContain('second');
  });

  it('skips bars with nothing to count', () => {
    const { stream, chunks } = ttyStream();
    createProgressReporter({ enabled: true, stream }).bar('Empty', 0).stop();
    expect(chunks).toEqual([]);
  });
});
