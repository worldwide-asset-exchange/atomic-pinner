import type { Config } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { createRetryFetch, type RetryFetch } from '../net/fetchRetry.js';
import type { Notifier, RunEvent } from './notifier.js';
import { SlackNotifier } from './slack.js';
import { WebhookNotifier } from './webhook.js';

export type {
  Notifier,
  RunEvent,
  RunStartEvent,
  RunFinishEvent,
  ChunkSummary,
} from './notifier.js';
export { WebhookNotifier } from './webhook.js';
export { SlackNotifier, formatSlackMessage } from './slack.js';

export function createNotifiers(
  config: Config,
  deps: { logger: Logger; fetch?: RetryFetch }
): Notifier[] {
  const fetch =
    deps.fetch ?? createRetryFetch({ retries: 2, timeoutMs: 10000 });
  const notifiers: Notifier[] = [];
  const logger = deps.logger.child({ component: 'notify' });
  if (config.notifications.webhookUrl)
    notifiers.push(
      new WebhookNotifier(config.notifications.webhookUrl, { fetch, logger })
    );
  if (config.notifications.slackWebhookUrl) {
    notifiers.push(
      new SlackNotifier(config.notifications.slackWebhookUrl, { fetch, logger })
    );
  }
  return notifiers;
}

/** Fan an event out to every notifier; one failing never blocks the others. */
export async function notifyAll(
  notifiers: Notifier[],
  event: RunEvent
): Promise<void> {
  await Promise.all(notifiers.map((n) => n.notify(event)));
}
