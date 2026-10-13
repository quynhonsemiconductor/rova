import { describe, expect, it } from 'vitest';
import { RESILIENCE_PRESETS } from '../resilience/resilience.presets';
import { ResiliencePreset } from '../resilience/resilience.types';
import { LEASE_MARGIN_MS, leaseForResilience, worstCaseCallMs } from './relay-lease';

describe('worstCaseCallMs', () => {
  it('counts RETRIES, not executions: maxAttempts 3 is four executions of the timeout each', () => {
    // cockatiel's RetryPolicy gates on `retries < maxAttempts`; this is the arithmetic the lease rests on.
    expect(RESILIENCE_PRESETS[ResiliencePreset.EXTERNAL_API].retry?.maxAttempts).toBe(3);
    expect(RESILIENCE_PRESETS[ResiliencePreset.EXTERNAL_API].timeout?.durationMs).toBe(30_000);
    expect(worstCaseCallMs(ResiliencePreset.EXTERNAL_API)).toBe(4 * 30_000);
  });

  it('is derived from the preset, so editing the preset moves the lease with it', () => {
    expect(worstCaseCallMs(ResiliencePreset.EMAIL)).toBe(
      ((RESILIENCE_PRESETS[ResiliencePreset.EMAIL].retry?.maxAttempts ?? 0) + 1) *
        (RESILIENCE_PRESETS[ResiliencePreset.EMAIL].timeout?.durationMs ?? 0),
    );
  });

  it('a preset with no retry is one execution', () => {
    expect(worstCaseCallMs(ResiliencePreset.CACHE)).toBe(500);
  });
});

describe('leaseForResilience', () => {
  it('is the calls × the worst case, plus the margin', () => {
    expect(leaseForResilience(ResiliencePreset.EXTERNAL_API)).toBe(120_000 + LEASE_MARGIN_MS);
    expect(leaseForResilience(ResiliencePreset.EXTERNAL_API, 2)).toBe(240_000 + LEASE_MARGIN_MS);
  });
});
