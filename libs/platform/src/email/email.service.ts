/**
 * EmailService — worker-side render-and-dispatch service.
 *
 * Called exclusively by EmailRelayService (worker).
 * Renders the named template and dispatches to IEmailProvider.
 *
 * API-side code: use EmailSchedulerService.schedule() instead.
 *
 * Resilience strategy (two complementary layers):
 *   - ResiliencePreset.EMAIL (here): in-process, fine-grained.
 *     Retry with jitter (≤5 attempts, ms-to-seconds gaps) + circuit-breaker
 *     (opens after 3 failures, half-open after 2 min) + 30s timeout + bulkhead
 *     (≤5 concurrent sends).  Protects against transient provider blips.
 *   - EmailRelayService MAX_ATTEMPTS (coarse-grained, DB-level):
 *     Retries across cron ticks (5s gap), handles provider outages lasting
 *     minutes.  The two layers are complementary — ResilienceService fires
 *     first; if it exhausts its retries the relay marks the attempt and tries
 *     again on the next tick.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EMAIL_PROVIDER } from './email.provider';
import type { IEmailProvider, EmailSendResult } from './email.provider';
import { renderEmailTemplate } from './templates';
import type { EmailTemplateName, EmailTemplateVars } from './templates';
import { ResilienceService, ResiliencePreset } from '../resilience';
import { NonRetryableError } from '../outbox/abstract-outbox-relay';
import { AppConfigService } from '../config/app-config.service';
import { resolveFromEmail, buildFromAddress } from './providers/shared';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  /**
   * `undefined` when no sender is configured, never a string containing "undefined".
   *
   * `MAIL_FROM_EMAIL` has no default, because defaulting it would let a misconfigured
   * deployment send from a domain it may not own. The env schema refuses to boot a
   * non-dev provider without one (see the `EMAIL_PROVIDER !== 'dev'` check in
   * `env.schema.ts`), so this is only reachable under `dev`, where the provider just
   * logs and has nothing to send from.
   */
  private readonly from: string | undefined;

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: IEmailProvider,
    private readonly resilience: ResilienceService,
    config: AppConfigService,
  ) {
    this.from = resolveFromEmail(config) ? buildFromAddress(config) : undefined;
  }

  /**
   * Render `template` with `vars` and send via the registered IEmailProvider.
   *
   * The provider call is wrapped with ResiliencePreset.EMAIL:
   *   - Retry × 5 with exponential backoff + jitter (ms-level gaps).
   *   - Circuit breaker: opens after 3 consecutive failures, half-open at 2 min.
   *   - Timeout: 30 s hard cap per provider call.
   *   - Bulkhead: ≤ 5 concurrent sends (protects the worker's event loop).
   *
   * Throws after all retries fail so the relay can increment attempts and
   * retry on the next outbox tick (coarse-grained, minutes-level recovery).
   *
   * Returns the provider's message id (see EmailSendResult) so the relay can persist it
   * at acceptance — that id is the feedback loop's only exact match key.
   */
  /**
   * Fails now if the configured transport cannot work (the Graph provider names the missing variable). The worker calls this when its relay
   * starts, so a bad deploy stops there instead of dead-lettering the first invitation. A provider with nothing to check passes.
   */
  assertReady(): void {
    (this.provider as { assertReady?: () => void }).assertReady?.();
  }

  async sendTemplate<K extends EmailTemplateName>(
    to: string,
    template: K,
    vars: EmailTemplateVars[K],
    idempotencyKey?: string,
  ): Promise<EmailSendResult> {
    const rendered = renderEmailTemplate(template, vars);
    const key = idempotencyKey ?? randomUUID();
    this.logger.log(
      { to, template, subject: rendered.subject, category: rendered.category },
      'Dispatching email',
    );
    /*
     * A PERMANENT failure (the provider said 400/403/404/413: the mailbox, the app or the message is wrong) must not go through the retry and the
     * circuit breaker below: it would be retried five times in a row, then three of them would OPEN the breaker, and every later email,
     * including ones that would have worked, would fail with "circuit open". It is carried out of the resilience wrapper as a value and thrown
     * after it, so the relay sees a `NonRetryableError`, dead-letters the row at once, and the `outboxDeadLetter` alarm fires.
     */
    const result = await this.resilience.execute(
      'email.provider.send',
      async (): Promise<
        { sent: EmailSendResult; permanent?: undefined } | { permanent: NonRetryableError }
      > => {
        try {
          return {
            sent: await this.provider.send({
              to,
              from: this.from,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
              category: rendered.category,
              idempotencyKey: key,
            }),
          };
        } catch (error) {
          if (error instanceof NonRetryableError) return { permanent: error };
          throw error;
        }
      },
      ResiliencePreset.EMAIL,
    );
    if (result.permanent) throw result.permanent;
    return result.sent;
  }
}
