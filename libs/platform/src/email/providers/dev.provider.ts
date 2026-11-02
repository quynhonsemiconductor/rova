/**
 * DevEmailProvider — dev/test transport that logs email payloads to stdout.
 *
 * Active when EMAIL_PROVIDER=dev (the default).
 * Lets the entire flow (template render, scheduler, relay) run without a
 * real email provider — the rendered subject/text is fully visible in logs.
 * Set EMAIL_PROVIDER=graph to use the real provider.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { IEmailProvider, EmailPayload, EmailSendResult } from '../email.provider';
import { AppConfigService } from '../../config';

@Injectable()
export class DevEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(DevEmailProvider.name);

  constructor(private readonly config: AppConfigService) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(payload: EmailPayload): Promise<EmailSendResult> {
    const fields: Record<string, unknown> = {
      to: payload.to,
      subject: payload.subject,
      category: payload.category ?? 'transactional',
      idempotencyKey: payload.idempotencyKey,
    };

    if (this.config.get('LOG_DEV_EMAIL_CONTENT')) {
      fields['text'] = payload.text;
    }

    this.logger.debug(
      fields,
      '[DEV EMAIL] Would send email — set EMAIL_PROVIDER=graph to use a real transport',
    );

    return { messageId: null };
  }
}
