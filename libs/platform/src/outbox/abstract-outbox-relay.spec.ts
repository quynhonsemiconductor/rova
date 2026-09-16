/**
 * AbstractOutboxRelay unit tests — the shared relay loop (concurrency guard,
 * per-row error handling, retry/backoff, terminal 'failed' status). All
 * concrete relays (email, notifications, SNS outbox) inherit this behavior,
 * so covering it once here covers all three.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AbstractOutboxRelay,
  DEAD_LETTER_FIELD,
  type PostCommitTask,
} from './abstract-outbox-relay';
import type { DrizzleDB, DrizzleTx } from '../database/drizzle.provider';
import { terraformFilesFilteringOn } from '../../../../test/helpers/terraform-filters';

interface TestRow {
  id: string;
  attempts: number;
  shouldFail: boolean;
}

/** Minimal concrete relay exposing hooks the tests can assert against. */
class TestRelay extends AbstractOutboxRelay<TestRow> {
  fetchBatchResult: TestRow[] = [];
  markFailedCalls: Array<{
    rowId: string;
    newAttempts: number;
    newStatus: 'pending' | 'failed';
    nextAttemptAt: Date;
  }> = [];
  markSentCalls: string[] = [];

  protected async fetchBatch(): Promise<TestRow[]> {
    return this.fetchBatchResult;
  }

  protected async processRow(row: TestRow): Promise<PostCommitTask | void> {
    if (row.shouldFail) throw new Error(`row ${row.id} failed`);
  }

  protected async markSent(_tx: DrizzleTx, rowId: string): Promise<void> {
    this.markSentCalls.push(rowId);
  }

  protected async markFailed(
    _tx: DrizzleTx,
    rowId: string,
    newAttempts: number,
    newStatus: 'pending' | 'failed',
    _lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    this.markFailedCalls.push({ rowId, newAttempts, newStatus, nextAttemptAt });
  }
}

function makeFakeDb(): DrizzleDB {
  return {
    transaction: async (cb: (tx: DrizzleTx) => Promise<void>) => cb({} as DrizzleTx),
  } as unknown as DrizzleDB;
}

describe('AbstractOutboxRelay.backoffDelayMs()', () => {
  it('doubles the delay per attempt starting at 30s, capped at 30 minutes', () => {
    const relay = new TestRelay(makeFakeDb());
    const delayFor = (n: number) =>
      (relay as unknown as { backoffDelayMs(n: number): number }).backoffDelayMs(n);

    expect(delayFor(1)).toBe(30_000); // 30s
    expect(delayFor(2)).toBe(60_000); // 1m
    expect(delayFor(3)).toBe(120_000); // 2m
    expect(delayFor(4)).toBe(240_000); // 4m
    expect(delayFor(5)).toBe(480_000); // 8m
    // Cap: a hypothetically much larger maxAttempts must never exceed 30 minutes.
    expect(delayFor(20)).toBe(30 * 60_000);
  });
});

describe('AbstractOutboxRelay.relay() — retry/backoff wiring', () => {
  it('passes an increasing nextAttemptAt to markFailed on each failed attempt', async () => {
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [{ id: 'row-1', attempts: 0, shouldFail: true }];

    const before = Date.now();
    await relay.relay();

    expect(relay.markFailedCalls).toHaveLength(1);
    const call = relay.markFailedCalls[0];
    expect(call.rowId).toBe('row-1');
    expect(call.newAttempts).toBe(1);
    expect(call.newStatus).toBe('pending');
    // attempt 1 → ~30s delay, not immediate retry.
    expect(call.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(call.nextAttemptAt.getTime()).toBeLessThanOrEqual(before + 31_000);
  });

  it('marks the row terminally failed once attempts reach maxAttempts', async () => {
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [{ id: 'row-1', attempts: 4, shouldFail: true }]; // 5th attempt = maxAttempts

    await relay.relay();

    expect(relay.markFailedCalls[0].newStatus).toBe('failed');
    expect(relay.markFailedCalls[0].newAttempts).toBe(5);
  });

  it('a PERMANENT failure is terminal on the first attempt, and the default is still transient', async () => {
    // Attempt exhaustion used to be the only route to 'failed'. That is right for a transient
    // fault and wrong for a refusal an external API will answer identically five times: the row
    // sat 'pending' through ~15 minutes of backoff, every tick re-issuing a call that could not
    // work, and stayed out of `status = 'failed'` — the only place anyone looks for work that
    // needs a human.
    const transient = new TestRelay(makeFakeDb());
    transient.fetchBatchResult = [{ id: 'row-1', attempts: 0, shouldFail: true }];
    await transient.relay();
    // Default isPermanentFailure() is false, so every existing relay keeps its exact behaviour.
    expect(transient.markFailedCalls[0].newStatus).toBe('pending');

    class PermanentRelay extends TestRelay {
      protected override isPermanentFailure(): boolean {
        return true;
      }
    }
    const permanent = new PermanentRelay(makeFakeDb());
    permanent.fetchBatchResult = [{ id: 'row-1', attempts: 0, shouldFail: true }];
    await permanent.relay();

    expect(permanent.markFailedCalls[0].newStatus).toBe('failed');
    expect(permanent.markFailedCalls[0].newAttempts).toBe(1);
  });

  it('marks a successful row sent and does not call markFailed for it', async () => {
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [{ id: 'row-ok', attempts: 0, shouldFail: false }];

    await relay.relay();

    expect(relay.markSentCalls).toEqual(['row-ok']);
    expect(relay.markFailedCalls).toHaveLength(0);
  });

  it('one failing row in a batch does not block the others from being processed', async () => {
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [
      { id: 'row-bad', attempts: 0, shouldFail: true },
      { id: 'row-good', attempts: 0, shouldFail: false },
    ];

    await relay.relay();

    expect(relay.markSentCalls).toEqual(['row-good']);
    expect(relay.markFailedCalls.map((c) => c.rowId)).toEqual(['row-bad']);
  });

  it('re-entrant calls while relaying are coalesced into exactly one extra run, and the caller awaits it directly', async () => {
    const relay = new TestRelay(makeFakeDb());
    let resolveFirstFetch!: () => void;
    let fetchCallCount = 0;

    relay.fetchBatchResult = [];
    const relayAsAny = relay as unknown as { fetchBatch(): Promise<TestRow[]> };
    const originalFetch = relayAsAny.fetchBatch.bind(relay);
    vi.spyOn(relayAsAny, 'fetchBatch').mockImplementation(async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstFetch = resolve;
        });
      }
      return originalFetch();
    });

    const firstRun = relay.relay();
    // Three more calls arrive while the first is still in-flight — all three
    // must coalesce onto ONE extra pass (not three), and each caller's own
    // promise must resolve only once that shared extra pass has actually run
    // — no reliance on an extra microtask/setImmediate tick after Promise.all.
    const secondRun = relay.relay();
    const thirdRun = relay.relay();
    const fourthRun = relay.relay();
    resolveFirstFetch();
    await Promise.all([firstRun, secondRun, thirdRun, fourthRun]);

    // Exactly 2 fetches: the first in-flight pass, plus ONE coalesced extra —
    // not 4, one per racing caller.
    expect(fetchCallCount).toBe(2);
  });

  it('a write made just before a racing relay() call is visible to the pass that call resolves on', async () => {
    // This is the exact guarantee the old isRelaying-flag design lacked: a
    // caller whose relay() call raced an in-flight pass got back a promise
    // that could resolve before ANY fetch that could see their write had run.
    const relay = new TestRelay(makeFakeDb());
    let resolveFirstFetch!: () => void;

    relay.fetchBatchResult = [];
    const relayAsAny = relay as unknown as { fetchBatch(): Promise<TestRow[]> };
    vi.spyOn(relayAsAny, 'fetchBatch').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveFirstFetch = resolve;
      });
      return []; // first pass sees nothing — the row below is written after it started
    });

    const firstRun = relay.relay();

    // Simulate a caller writing a new row, THEN calling relay() while the
    // first pass is still in flight — exactly the notification-outbox insert
    // + explicit relay() call pattern in the E2E suite.
    relay.fetchBatchResult = [
      { id: 'row-written-during-first-pass', attempts: 0, shouldFail: false },
    ];
    const secondRun = relay.relay();

    resolveFirstFetch();
    await Promise.all([firstRun, secondRun]);

    // The row written before the second relay() call must have been picked
    // up by the pass secondRun awaited — not silently missed.
    expect(relay.markSentCalls).toContain('row-written-during-first-pass');
  });
});

describe('DEAD_LETTER_FIELD', () => {
  it('uses the field name the infra actually filters on', () => {
    // Guards the rename: the alarm is worthless if the field drifts.
    expect(DEAD_LETTER_FIELD).toBe('outboxDeadLetter');

    // Searches the whole infra tree rather than naming a file, for the same reason
    // fail-open.spec.ts does: asserting on a path would need editing every time the
    // Terraform is reorganised, which is how a guard quietly stops guarding. What
    // matters is that SOME Terraform in this repo filters on the emitted field.
    const terraform = terraformFilesFilteringOn(DEAD_LETTER_FIELD);

    expect(
      terraform,
      `No Terraform under infra/ filters on ${DEAD_LETTER_FIELD}; a relay can exhaust ` +
        `its retries and lose work with nothing alarming, even though the app emits the field.`,
    ).not.toEqual([]);
  });
});
