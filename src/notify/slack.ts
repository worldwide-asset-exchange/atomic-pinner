import type { Logger } from '../logging/logger.js';
import type { RetryFetch } from '../net/fetchRetry.js';
import type {
  Notifier,
  RunEvent,
  RunFinishEvent,
  RunStartEvent,
} from './notifier.js';

export interface SlackDeps {
  fetch: RetryFetch;
  logger: Logger;
}

function formatRuntime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function chunkLine(event: RunStartEvent | RunFinishEvent): string {
  if (!event.chunk) return '';
  const c = event.chunk;
  return `\n*Chunk* ${c.chunkFileName} (${c.currentChunkNumber}/${c.totalChunks}) · done ${c.completedChunks}/${c.totalChunks}${c.failedChunks ? ` · failed ${c.failedChunks}` : ''}`;
}

/** Slack message for one event, as blocks for an incoming webhook. */
export function formatSlackMessage(event: RunEvent): {
  text: string;
  blocks: unknown[];
} {
  const mode = event.dryRun ? 'dry run' : 'pinning run';
  if (event.event === 'start') {
    const text = `🚀 atomic-pinner ${mode} started (${event.provider})`;
    return {
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${text}*${chunkLine(event)}` },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `${event.collections} collections · ${event.tokens} tokens`,
            },
          ],
        },
      ],
    };
  }

  const icon = event.success ? '✅' : '❌';
  const text = `${icon} atomic-pinner ${mode} ${event.success ? 'finished' : 'failed'} in ${formatRuntime(event.runtimeMs)}`;
  const t = event.totals;
  const fields = [
    `*CIDs found:* ${t.hashesFound}`,
    `*Unique:* ${t.uniqueHashes}`,
    `*${event.dryRun ? 'Would pin' : 'Pinned'}:* ${t.pinned}`,
    `*Already pinned:* ${t.alreadyPinned}`,
    `*Missing from IPFS:* ${t.missing}`,
    `*Failed:* ${t.failed}`,
    `*Duplicates avoided:* ${t.duplicatesAvoided}`,
    `*API failures:* ${event.apiFailures.total}`,
  ].map((f) => ({ type: 'mrkdwn', text: f }));

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${text}*${chunkLine(event)}` },
    },
    { type: 'section', fields },
  ];
  if (event.chunk) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: event.chunkCompleted
            ? 'Chunk completed'
            : 'Chunk will resume next run',
        },
      ],
    });
  }
  if (event.error) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`${event.error.slice(0, 1500)}\`\`\``,
      },
    });
  }
  return { text, blocks };
}

/** Posts run events to a Slack incoming webhook. */
export class SlackNotifier implements Notifier {
  readonly name = 'slack';

  constructor(
    private readonly webhookUrl: string,
    private readonly deps: SlackDeps
  ) {}

  async notify(event: RunEvent): Promise<void> {
    try {
      const response = await this.deps.fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formatSlackMessage(event)),
      });
      if (!response.ok) {
        this.deps.logger.warn('Slack webhook rejected notification', {
          status: response.status,
          event: event.event,
        });
      }
    } catch (error) {
      this.deps.logger.warn('Slack notification failed', {
        event: event.event,
        error,
      });
    }
  }
}
