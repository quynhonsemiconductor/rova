/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { FAIL_OPEN_FIELD, failOpenLog } from '@quynhonsemiconductor/observability';
import { terraformFilesFilteringOn } from '../../../../test/helpers/terraform-filters';

/**
 * The log helper itself now lives in `@quynhonsemiconductor/observability`; what stays here is the
 * part only this repo can assert — that the field name the package emits is the one
 * this repo's Terraform actually filters on. The coupling is invisible from both
 * sides, so a package rename or an infra edit must fail a test rather than silently
 * disarm the alarm.
 */
describe('failOpenLog', () => {
  it('tags the control that degraded', () => {
    expect(failOpenLog('denylist')).toEqual({ securityFailOpen: 'denylist' });
    expect(failOpenLog('rate_limit')).toEqual({ securityFailOpen: 'rate_limit' });
  });

  it('preserves the caller context', () => {
    const err = new Error('ECONNRESET');
    expect(failOpenLog('rate_limit', { err, ip: '1.1.1.1' })).toEqual({
      err,
      ip: '1.1.1.1',
      securityFailOpen: 'rate_limit',
    });
  });

  it('uses the field name the infra actually filters on', () => {
    // Guards the rename: the alarm is worthless if the field drifts.
    expect(FAIL_OPEN_FIELD).toBe('securityFailOpen');

    // Searches the whole infra tree rather than naming a file — see the helper for why,
    // and for why it walks the tree in Node instead of shelling out to `grep`.
    const terraform = terraformFilesFilteringOn(FAIL_OPEN_FIELD);

    expect(
      terraform,
      `No Terraform under infra/ filters on ${FAIL_OPEN_FIELD}; the fail-open alarm ` +
        `is disarmed even though the app still emits the field.`,
    ).not.toEqual([]);
  });
});
