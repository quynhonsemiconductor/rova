import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError } from '../outbox/abstract-outbox-relay';
import { EmailService } from './email.service';

/**
 * A PERMANENT provider failure (Graph 403/404/400/413) must reach the relay as a NonRetryableError after ONE attempt, and must not feed the
 * circuit breaker: retried five times and counted three-for-three, it would open the breaker and fail every later email, working ones included.
 */
const config = { get: (k: string) => (k === 'MAIL_FROM_EMAIL' ? undefined : 'Mini Rova') } as never;

/** A resilience stand-in that retries like the real EMAIL preset does (5 attempts), so a retried permanent failure is visible. */
const retrying = {
  execute: async <T>(_name: string, op: () => Promise<T>): Promise<T> => {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await op();
      } catch (error) {
        last = error;
      }
    }
    throw last;
  },
} as never;

const VARS = { to: 'a@qnsc.vn' } as never;

describe('EmailService permanent failures', () => {
  it('tries a permanent failure once and hands the relay the NonRetryableError', async () => {
    const send = vi.fn(() => Promise.reject(new NonRetryableError('Graph answered 403')));
    const service = new EmailService({ send }, retrying, config);
    await expect(
      service.sendTemplate('x@qnsc.vn', 'workspace-invitation', VARS),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still retries a transient failure', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({ messageId: 'id-1' });
    const service = new EmailService({ send }, retrying, config);
    await expect(service.sendTemplate('x@qnsc.vn', 'workspace-invitation', VARS)).resolves.toEqual({
      messageId: 'id-1',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
