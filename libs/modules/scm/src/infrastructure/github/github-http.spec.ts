import { describe, expect, it } from 'vitest';
import { GITHUB_CALL_TIMEOUT_MS, githubCallSignal } from './github-http';

describe('githubCallSignal', () => {
  it('is a live signal with a per-call deadline when the caller has no budget', () => {
    expect(GITHUB_CALL_TIMEOUT_MS).toBe(30_000);
    const signal = githubCallSignal();
    expect(signal.aborted).toBe(false);
  });

  it("aborts as soon as the run's budget does, so the request in flight is cancelled", () => {
    const budget = new AbortController();
    const signal = githubCallSignal(budget.signal);
    expect(signal.aborted).toBe(false);

    budget.abort();

    expect(signal.aborted).toBe(true);
  });

  it('is already aborted when the budget was spent before the request began', () => {
    const budget = new AbortController();
    budget.abort();
    expect(githubCallSignal(budget.signal).aborted).toBe(true);
  });
});
