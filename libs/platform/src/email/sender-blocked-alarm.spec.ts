import { describe, expect, it } from 'vitest';
import { terraformFilesFilteringOn } from '../../../../test/helpers/terraform-filters';

/**
 * The Graph provider logs `senderBlocked` (SENDER_BLOCKED_FIELD in providers/graph.provider.ts) when Microsoft refuses the shared mailbox. The email
 * relay then DEFERS every row without spending its attempts, so `outbox-dead-letter` never fires while no email leaves: this log field is the only signal.
 * The alarm is worthless if the field drifts away from the pattern, so some Terraform must filter on exactly that name.
 */
describe('the email-sender-blocked alarm', () => {
  it('filters on the field the Graph provider logs', () => {
    expect(
      terraformFilesFilteringOn('senderBlocked'),
      'No Terraform under infra/ filters on senderBlocked: a refused mailbox would stop all email with nothing alarming.',
    ).not.toEqual([]);
  });
});
