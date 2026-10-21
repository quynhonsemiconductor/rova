/**
 * Every outbox relay's lease, and how long a crash can strand a batch.
 *
 * TWO INVARIANTS, for all six relays:
 *
 *   1. LEASE > CALLS × TIMEOUT. A relay's lease on a row must outlast the longest `deliver` for it, or another
 *      relay takes the row mid-call and the call is made twice. Each external relay's lease is checked against the
 *      constants that bound its calls: the resilience preset (retries × per-execution timeout) for Graph and
 *      the mail provider, the run budget for the GitHub backfill.
 *
 *   2. batchSize × lease ≤ 15 MINUTES. A claim holds the whole batch for the SUM of the rows' leases (they are
 *      worked one after another), so a worker that dies holding a batch strands it for that long. A pass drains
 *      the queue by claiming again, so a small batch costs no throughput. A longer lease, a bigger batch or a
 *      new relay cannot quietly turn the stall into an hour.
 */
import { describe, expect, it } from 'vitest';
import {
  LEASE_MARGIN_MS,
  MAX_STRAND_MS,
  ResiliencePreset,
  worstCaseCallMs,
} from '../libs/platform/src';
import { BACKFILL_RUN_BUDGET_MS, GITHUB_CALL_TIMEOUT_MS } from '../libs/modules/scm/src';
import { AuditProjectionRelay } from '../apps/worker/src/audit/audit-projection.relay';
import { EmailRelayService } from '../apps/worker/src/email/email-relay.service';
import { EntraGuestInviteRelayService } from '../apps/worker/src/identity/entra-guest-invite-relay.service';
import { NotificationRelayService } from '../apps/worker/src/notifications/notification-relay.service';
import { ScmBackfillRelayService } from '../apps/worker/src/scm/scm-backfill-relay.service';
import { ScmWebhookRelayService } from '../apps/worker/src/scm/scm-webhook-relay.service';

interface Relay {
  batchSize: number;
  leaseMsFor(row: unknown): number;
}

const none = {} as never;
const config = { get: () => 'http://localhost' } as never;

const relays: Array<[string, Relay]> = [
  ['EmailRelayService', new EmailRelayService(none, none, none, none) as unknown as Relay],
  [
    'NotificationRelayService',
    new NotificationRelayService(none, none, none, none, none, config) as unknown as Relay,
  ],
  ['AuditProjectionRelay', new AuditProjectionRelay(none, none) as unknown as Relay],
  ['ScmWebhookRelayService', new ScmWebhookRelayService(none, none, none) as unknown as Relay],
  ['ScmBackfillRelayService', new ScmBackfillRelayService(none, none) as unknown as Relay],
  [
    'EntraGuestInviteRelayService',
    new EntraGuestInviteRelayService(none, none, config, none, none) as unknown as Relay,
  ],
];

describe('a crashed worker strands a batch for at most 15 minutes', () => {
  it.each(relays)('%s: batchSize × lease <= 15 min', (_name, relay) => {
    expect(relay.batchSize * relay.leaseMsFor({})).toBeLessThanOrEqual(MAX_STRAND_MS);
  });

  it('covers all six relays (a new one must be listed here)', () => {
    expect(relays).toHaveLength(6);
  });
});

describe('a lease outlasts the calls it covers', () => {
  const lease = (name: string) => relays.find(([n]) => n === name)![1].leaseMsFor({});

  it('the mail relay: six executions of the provider timeout, plus the margin', () => {
    expect(lease('EmailRelayService')).toBeGreaterThanOrEqual(
      worstCaseCallMs(ResiliencePreset.EMAIL) + LEASE_MARGIN_MS,
    );
  });

  it('the guest-invite relay: four executions of the Graph timeout, plus the margin', () => {
    expect(lease('EntraGuestInviteRelayService')).toBeGreaterThanOrEqual(
      worstCaseCallMs(ResiliencePreset.EXTERNAL_API) + LEASE_MARGIN_MS,
    );
  });

  it('the backfill relay: the whole run budget, the call in flight when it expires, and the margin', () => {
    expect(lease('ScmBackfillRelayService')).toBeGreaterThanOrEqual(
      BACKFILL_RUN_BUDGET_MS + GITHUB_CALL_TIMEOUT_MS + LEASE_MARGIN_MS,
    );
  });

  it('the backfill relay claims ONE repository at a time', () => {
    const backfill = relays.find(([n]) => n === 'ScmBackfillRelayService')![1];
    expect(backfill.batchSize).toBe(1);
  });
});
