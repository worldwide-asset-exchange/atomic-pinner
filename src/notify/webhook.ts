import type { Logger } from '../logging/logger.js';
import type { RetryFetch } from '../net/fetchRetry.js';
import type { Notifier, RunEvent } from './notifier.js';

export interface WebhookDeps {
  fetch: RetryFetch;
  logger: Logger;
}

/** POSTs each run event as JSON to a URL you control. */
export class WebhookNotifier implements Notifier {
  readonly name = 'webhook';

  constructor(
    private readonly url: string,
    private readonly deps: WebhookDeps
  ) {}

  async notify(event: RunEvent): Promise<void> {
    try {
      const response = await this.deps.fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'atomic-pinner',
        },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        this.deps.logger.warn('Webhook rejected notification', {
          status: response.status,
          event: event.event,
        });
      }
    } catch (error) {
      this.deps.logger.warn('Webhook notification failed', {
        event: event.event,
        error,
      });
    }
  }
}
