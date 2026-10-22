import { describe, expect, it, vi } from 'vitest';
import { EmailRelayService } from './email-relay.service';

/**
 * The worker is the only process that sends mail. When its transport cannot work (a missing Graph variable), the deploy must fail at start, not
 * dead-letter the first invitation: the relay asks the email service to check before it listens for anything.
 */
function relay(assertReady: () => void) {
  const unsubscribe = vi.fn(() => Promise.resolve());
  const subscribeEmailRelayWake = vi.fn(() => Promise.resolve(unsubscribe));
  const service = new EmailRelayService(
    {} as never,
    { assertReady } as never,
    { subscribeEmailRelayWake } as never,
    {} as never,
  );
  return { service, subscribeEmailRelayWake, unsubscribe };
}

describe('EmailRelayService start', () => {
  it('checks the transport, then listens for the wake signal', async () => {
    const assertReady = vi.fn();
    const { service, subscribeEmailRelayWake } = relay(assertReady);
    await service.onModuleInit();
    expect(assertReady).toHaveBeenCalledOnce();
    expect(subscribeEmailRelayWake).toHaveBeenCalledOnce();
  });

  it('a transport that cannot work stops the worker before it listens', async () => {
    const { service, subscribeEmailRelayWake } = relay(() => {
      throw new Error('AZURE_CLIENT_ID is required for MAIL_TRANSPORT=graph');
    });
    await expect(service.onModuleInit()).rejects.toThrow(/AZURE_CLIENT_ID/);
    expect(subscribeEmailRelayWake).not.toHaveBeenCalled();
  });
});
