/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { FAIL_OPEN_FIELD, failOpenLog } from '@quynhonsemiconductor/observability';

/**
 * The log helper itself now lives in `@quynhonsemiconductor/observability`; what stays here is the
 * part only this repo can assert — that the field name the package emits is the one
 * the fail-open alert filters on, so a package rename fails a test rather than silently
 * disarming the alert.
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

  it('keeps the field name the fail-open alert filters on', () => {
    // Guards the rename: the alert (in gitops) matches this exact log field.
    expect(FAIL_OPEN_FIELD).toBe('securityFailOpen');
  });
});
