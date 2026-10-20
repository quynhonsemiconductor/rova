import { describe, expect, it, vi } from 'vitest';
import type { EmailMessage, EmailSender } from '@quynhonsemiconductor/platform-mail/sender';
import { DeferError, NonRetryableError, RetryAfterError } from '../outbox/abstract-outbox-relay';
import { EMAIL_SEND_TIMEOUT_MS } from './email.provider';
import { EmailService } from './email.service';
import { GraphEmailProvider } from './providers/graph.provider';
import type { EmailTemplateName, EmailTemplateVars } from './templates';

/** Resilience stand-in that retries like the real EMAIL preset (5 attempts) and counts how often it was used. */
function retryingResilience() {
  const execute = vi.fn(async <T>(_name: string, op: () => Promise<T>): Promise<T> => {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await op();
      } catch (error) {
        last = error;
      }
    }
    throw last;
  });
  return { resilience: { execute } as never, execute };
}

/** One sample per template. `satisfies` makes adding a template without a sample here a TYPE error. */
const SAMPLES = {
  'workspace-invitation': {
    inviteUrl: 'https://rova.example/invite/abc',
    workspaceName: 'Acme',
    expiresInDays: '7',
    recipientEmail: 'new@qnsc.vn',
  },
  notification: { title: 'Heads up', body: 'Something happened', appUrl: 'https://rova.example' },
} satisfies { [K in EmailTemplateName]: EmailTemplateVars[K] };

const GRAPH_CONFIG = {
  sender: 'noreply-rova-dev@qnsc.vn',
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  certificate: undefined,
  federatedTokenFile: undefined,
  nodeEnv: 'production',
};

function graphProvider(send: (m: EmailMessage, o?: { signal?: AbortSignal }) => Promise<unknown>) {
  const spy = vi.fn(send);
  const sender = { mailbox: GRAPH_CONFIG.sender, send: spy } as unknown as EmailSender;
  return { provider: new GraphEmailProvider(GRAPH_CONFIG, () => sender), send: spy };
}

describe('EmailService with the Graph provider (it owns its retries)', () => {
  it.each(Object.keys(SAMPLES) as EmailTemplateName[])(
    'EVERY template is accepted by the Graph provider: %s (a refused category would dead-letter every email of that kind)',
    async (template) => {
      const { provider, send } = graphProvider(() =>
        Promise.resolve({ id: 'req-1', transport: 'graph' }),
      );
      const { resilience } = retryingResilience();
      const service = new EmailService(provider, resilience);

      await expect(
        service.sendTemplate('x@qnsc.vn', template, SAMPLES[template] as never, `key-${template}`),
      ).resolves.toEqual({ messageId: 'req-1' });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('does not put it behind the retry/breaker wrapper: a permanent failure is tried ONCE and reaches the relay as NonRetryableError', async () => {
    // A 400 as the provider reports it.
    const failing = {
      ownsRetries: true as const,
      send: vi.fn(() => Promise.reject(new NonRetryableError('Graph answered 400'))),
    };
    const { resilience, execute } = retryingResilience();
    const service = new EmailService(failing, resilience);
    await expect(
      service.sendTemplate('x@qnsc.vn', 'workspace-invitation', SAMPLES['workspace-invitation']),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(failing.send).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled(); // so it never counts toward, or resets, the breaker
  });

  it.each([
    ['a 429 (Retry-After)', new RetryAfterError('throttled', 5000), RetryAfterError],
    ['a refused sender (403/404)', new DeferError('sender blocked', 900_000), DeferError],
  ])('hands %s straight to the relay, one call', async (_label, error, type) => {
    const provider = { ownsRetries: true as const, send: vi.fn(() => Promise.reject(error)) };
    const { resilience, execute } = retryingResilience();
    const service = new EmailService(provider, resilience);
    await expect(
      service.sendTemplate('x@qnsc.vn', 'workspace-invitation', SAMPLES['workspace-invitation']),
    ).rejects.toBeInstanceOf(type);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives the provider a signal that ABORTS at the deadline, so nothing is accepted after the relay has retried the row', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const provider = {
        ownsRetries: true as const,
        send: vi.fn((_p: unknown, options?: { signal?: AbortSignal }) => {
          seen = options?.signal;
          return new Promise<never>(() => undefined);
        }),
      };
      const { resilience } = retryingResilience();
      const service = new EmailService(provider, resilience);

      const sending = service
        .sendTemplate('x@qnsc.vn', 'workspace-invitation', SAMPLES['workspace-invitation'])
        .catch((e: unknown) => e);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS + 1);

      expect(seen?.aborted).toBe(true);
      expect(((await sending) as Error).message).toMatch(/did not answer within 30 s/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EmailService with any other provider (SES, Resend, dev)', () => {
  it('is unchanged: it still goes through the resilience wrapper and retries a transient failure', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({ messageId: 'id-1' });
    const { resilience, execute } = retryingResilience();
    const service = new EmailService({ send }, resilience);
    await expect(
      service.sendTemplate('x@qnsc.vn', 'workspace-invitation', SAMPLES['workspace-invitation']),
    ).resolves.toEqual({ messageId: 'id-1' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
