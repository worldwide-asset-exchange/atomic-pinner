import { describe, it, expect, vi } from 'vitest';
import { WebhookNotifier } from './webhook.js';
import { SlackNotifier, formatSlackMessage } from './slack.js';
import { createNotifiers, notifyAll } from './index.js';
import type { RunFinishEvent, RunStartEvent } from './notifier.js';
import { createLogger, silentLogger } from '../logging/logger.js';
import { loadConfig } from '../config/load.js';
import { fakeFetch } from '../../tests/helpers/http.js';

const phase = {
  hashesFound: 10,
  uniqueHashes: 8,
  duplicatesAvoided: 2,
  pinned: 5,
  alreadyPinned: 2,
  missing: 1,
  failed: 0,
};

const start: RunStartEvent = {
  event: 'start',
  startedAt: '2026-01-01T00:00:00.000Z',
  dryRun: false,
  provider: 'pinata',
  collections: 3,
  tokens: 1,
  chunk: {
    chunkFileName: 'targets-chunk-02.json',
    currentChunkNumber: 2,
    totalChunks: 5,
    completedChunks: 1,
    failedChunks: 1,
  },
};

const finish: RunFinishEvent = {
  event: 'finish',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:30.000Z',
  runtimeMs: 90000,
  success: false,
  error: 'api down',
  dryRun: true,
  provider: 'pinata',
  chunk: start.chunk,
  chunkCompleted: false,
  totals: phase,
  collections: phase,
  tokens: { ...phase, pinned: 0 },
  uniqueHashes: 8,
  notFoundHashes: 1,
  apiFailures: {
    atomicAssets: 1,
    pinataList: 0,
    pinataPin: 0,
    hashVerification: 0,
    total: 1,
  },
};

describe('WebhookNotifier', () => {
  it('posts the event as JSON', async () => {
    const fetch = fakeFetch([{ method: 'POST', match: 'hooks.example' }]);
    await new WebhookNotifier('https://hooks.example/run', {
      fetch,
      logger: silentLogger,
    }).notify(start);
    expect(fetch.calls[0].url).toBe('https://hooks.example/run');
    expect(JSON.parse(fetch.calls[0].init!.body as string)).toEqual(start);
  });

  it('logs and swallows rejections and network errors', async () => {
    const write = vi.fn();
    const logger = createLogger({ level: 'warn', write });
    await new WebhookNotifier('https://a.example', {
      fetch: fakeFetch([{ match: 'a.example', status: 500 }]),
      logger,
    }).notify(finish);
    await new WebhookNotifier('https://b.example', {
      fetch: fakeFetch([{ match: 'b.example', throws: new Error('down') }]),
      logger,
    }).notify(finish);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0]).toContain('status=500');
    expect(write.mock.calls[1][0]).toContain('down');
  });
});

describe('formatSlackMessage', () => {
  it('describes a start with chunk and counts', () => {
    const msg = formatSlackMessage(start);
    expect(msg.text).toBe('🚀 atomic-pinner pinning run started (pinata)');
    expect(JSON.stringify(msg.blocks)).toContain('targets-chunk-02.json (2/5)');
    expect(JSON.stringify(msg.blocks)).toContain('3 collections · 1 tokens');
  });

  it('describes a failed dry run with totals and the error', () => {
    const msg = formatSlackMessage(finish);
    expect(msg.text).toBe('❌ atomic-pinner dry run failed in 1m 30s');
    const text = JSON.stringify(msg.blocks);
    expect(text).toContain('*Would pin:* 5');
    expect(text).toContain('*API failures:* 1');
    expect(text).toContain('Chunk will resume next run');
    expect(text).toContain('api down');
  });

  it('describes a successful run without chunk info', () => {
    const msg = formatSlackMessage({
      ...finish,
      success: true,
      error: undefined,
      dryRun: false,
      chunk: undefined,
      runtimeMs: 7200000,
    });
    expect(msg.text).toBe('✅ atomic-pinner pinning run finished in 2h 0m');
    expect(JSON.stringify(msg.blocks)).toContain('*Pinned:* 5');
    expect(JSON.stringify(msg.blocks)).not.toContain('Chunk');
  });
});

describe('SlackNotifier', () => {
  it('posts the formatted message to the webhook', async () => {
    const fetch = fakeFetch([{ method: 'POST', match: 'hooks.slack' }]);
    await new SlackNotifier('https://hooks.slack.example/T/B/x', {
      fetch,
      logger: silentLogger,
    }).notify(start);
    expect(JSON.parse(fetch.calls[0].init!.body as string)).toEqual(
      formatSlackMessage(start)
    );
  });

  it('does not throw when Slack rejects the message', async () => {
    const fetch = fakeFetch([
      {
        method: 'POST',
        match: 'hooks.slack',
        status: 400,
        body: 'invalid_payload',
      },
    ]);
    await expect(
      new SlackNotifier('https://hooks.slack.example/x', {
        fetch,
        logger: silentLogger,
      }).notify(start)
    ).resolves.toBeUndefined();
  });
});

describe('createNotifiers / notifyAll', () => {
  it('creates one notifier per configured URL', () => {
    expect(
      createNotifiers(loadConfig({ env: { PINATA_JWT: 'x' } }), {
        logger: silentLogger,
      })
    ).toEqual([]);
    const both = createNotifiers(
      loadConfig({
        env: {
          PINATA_JWT: 'x',
          WEBHOOK_URL: 'https://w.example',
          SLACK_WEBHOOK_URL: 'https://s.example',
        },
      }),
      { logger: silentLogger }
    );
    expect(both.map((n) => n.name)).toEqual(['webhook', 'slack']);
  });

  it('fans an event out to every notifier', async () => {
    const a = { name: 'a', notify: vi.fn().mockResolvedValue(undefined) };
    const b = { name: 'b', notify: vi.fn().mockResolvedValue(undefined) };
    await notifyAll([a, b], start);
    expect(a.notify).toHaveBeenCalledWith(start);
    expect(b.notify).toHaveBeenCalledWith(start);
  });
});
