import { describe, it, expect, vi } from 'vitest';
import { createLogger, silentLogger } from './logger.js';

const fixed = () => new Date('2026-01-02T03:04:05.000Z');

describe('createLogger', () => {
  it('filters by level', () => {
    const write = vi.fn();
    const log = createLogger({ level: 'warn', write, now: fixed });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0]).toContain('WARN  w');
    expect(write.mock.calls[1][0]).toContain('ERROR e');
  });

  it('formats text lines with time, level and fields', () => {
    const write = vi.fn();
    createLogger({ write, now: fixed }).info('hello', {
      cid: 'Qm1',
      count: 2,
      note: 'two words',
    });
    expect(write).toHaveBeenCalledWith(
      '03:04:05 INFO  hello cid=Qm1 count=2 note="two words"'
    );
  });

  it('emits one JSON object per line', () => {
    const write = vi.fn();
    createLogger({ format: 'json', write, now: fixed }).warn('careful', {
      error: new Error('bad'),
    });
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      time: '2026-01-02T03:04:05.000Z',
      level: 'warn',
      msg: 'careful',
      error: { name: 'Error', message: 'bad' },
    });
  });

  it('child loggers carry their fields', () => {
    const write = vi.fn();
    const log = createLogger({ write, now: fixed }).child({ component: 'x' });
    log.child({ collection: 'c' }).info('m', { page: 1 });
    expect(write.mock.calls[0][0]).toBe(
      '03:04:05 INFO  m component=x collection=c page=1'
    );
  });

  it('silentLogger writes nothing', () => {
    expect(() => silentLogger.error('x')).not.toThrow();
    expect(silentLogger.level).toBe('silent');
  });
});
