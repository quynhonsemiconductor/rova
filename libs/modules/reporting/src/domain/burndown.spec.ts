import { describe, expect, it } from 'vitest';
import {
  buildBurndownSeries,
  carryInMarkers,
  combineTeamSnapshots,
  idealLine,
  splitOutMarkers,
  type StoredSnapshot,
  type StoredSplitEvent,
} from './burndown';
import { DEFAULT_WORKING_DAYS } from './report-scope';

describe('idealLine (IB-BR-03)', () => {
  it('starts at the baseline and reaches exactly zero on the last WORKING day', () => {
    // The approved mockup interpolates over calendar days and never reaches zero; the SRS
    // indexes by working day and requires it. This is the divergence, pinned.
    expect(idealLine(40, 5)).toEqual([40, 30, 20, 10, 0]);
  });

  it('renders a single-working-day iteration as the baseline alone', () => {
    // N - 1 = 0 makes the formula undefined; IB-BR-03 says show the baseline at the start
    // of that day.
    expect(idealLine(16, 1)).toEqual([16]);
  });

  it('clamps to [0, baseline] and never goes negative', () => {
    expect(idealLine(-5, 3)).toEqual([0, 0, 0]);
    expect(idealLine(10, 3).every((v) => v >= 0 && v <= 10)).toBe(true);
  });

  it('has no points when there are no working days', () => {
    expect(idealLine(40, 0)).toEqual([]);
  });
});

const WEEK = { startDate: '2026-01-05', endDate: '2026-01-09' }; // Mon–Fri

/**
 * A stored snapshot, captured at the END of its day unless a test says otherwise.
 *
 * End-of-day is the normal case — the hourly job's last tick before local midnight is the value that
 * survives — so it is the default here, and the tests that care about a job dying early pass
 * `endOfDay: false` explicitly. `StoredSnapshot` keeps both fields REQUIRED rather than defaulting
 * them in the type: the repository always knows `captured_at` (it is NOT NULL in the table), and a
 * type-level default of `true` would let unknown data claim to be a closing figure.
 */
const snap = (
  date: string,
  remainingToDo: number,
  acceptedPoints: number,
  over: { capturedAt?: Date | null; endOfDay?: boolean } = {},
): StoredSnapshot => ({
  date,
  remainingToDo,
  acceptedPoints,
  capturedAt: over.capturedAt ?? new Date(`${date}T23:30:00Z`),
  endOfDay: over.endOfDay ?? true,
});

describe('buildBurndownSeries', () => {
  it('plots working days only, with the ideal reaching zero on Friday', () => {
    const series = buildBurndownSeries({
      ...WEEK,
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: 40,
      snapshots: [
        snap('2026-01-05', 40, 0),
        snap('2026-01-06', 32, 0),
        snap('2026-01-07', 24, 5),
        snap('2026-01-08', 12, 5),
        snap('2026-01-09', 0, 13),
      ],
    });
    expect(series.points.map((p) => p.date)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
    ]);
    expect(series.points.map((p) => p.ideal)).toEqual([40, 30, 20, 10, 0]);
    expect(series.historyState).toBe('complete');
    expect(series.status).toBe('on-track');
  });

  it('reports a missing day as a gap, never as zero', () => {
    // A zero would read as "no work remained" — measured performance. IB §5: missing
    // snapshots are reported as unavailable and must not be interpolated.
    const series = buildBurndownSeries({
      ...WEEK,
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: 40,
      snapshots: [snap('2026-01-05', 40, 0), snap('2026-01-07', 24, 5)],
    });
    expect(series.points.map((p) => p.remainingToDo)).toEqual([40, null, 24, null, null]);
    expect(series.historyState).toBe('partial');
  });

  it('distinguishes no snapshots at all from no baseline', () => {
    const noHistory = buildBurndownSeries({
      ...WEEK,
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: 40,
      snapshots: [],
    });
    expect(noHistory.historyState).toBe('missing');
    expect(noHistory.status).toBe('unknown');

    /**
     * A missing baseline costs the IDEAL LINE, not the measured history.
     *
     * IB §3 scopes the baseline to the Ideal line and §5 makes only missing SNAPSHOTS
     * unavailable, so `historyState` reports what was captured and `totalTaskEstimateAtStart`
     * reports whether a trajectory can be drawn. Conflating them made a real, measured day of
     * Task-To-Do render as "no burndown to show".
     */
    const noBaseline = buildBurndownSeries({
      ...WEEK,
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: null,
      snapshots: [snap('2026-01-05', 40, 0)],
    });
    expect(noBaseline.historyState).toBe('partial');
    expect(noBaseline.totalTaskEstimateAtStart).toBeNull();
    // The measured day SURVIVES — that is the whole point of the split.
    expect(noBaseline.points.find((p) => p.date === '2026-01-05')?.remainingToDo).toBe(40);
    // Status still cannot be judged: there is nothing to compare the measurement against.
    expect(noBaseline.status).toBe('unknown');
    // Every Ideal value is null, not 0: a zero line gets plotted and reads as "the plan was
    // to do nothing", which is the same fabrication the null snapshot values avoid.
    expect(noBaseline.points.every((p) => p.ideal === null)).toBe(true);
  });

  it('reports NO WINDOW for an iteration with no dates, rather than throwing', () => {
    // The service has nothing but `''` to pass for a dateless iteration, and `'' < ''` slipped
    // past the inverted-range guard into `addDays('')`, which threw `RangeError: Invalid time
    // value` — a 500 on 99 of 206 iterations in the local database.
    const dateless = buildBurndownSeries({
      startDate: '',
      endDate: '',
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: 40,
      snapshots: [],
    });
    expect(dateless.historyState).toBe('no-window');
    expect(dateless.points).toEqual([]);
    expect(dateless.status).toBe('unknown');
  });

  it('ignores a weekend snapshot stored for audit when judging completeness', () => {
    const series = buildBurndownSeries({
      startDate: '2026-01-05',
      endDate: '2026-01-12',
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: 40,
      snapshots: [
        snap('2026-01-10', 20, 5), // Saturday
        snap('2026-01-11', 20, 5), // Sunday
      ],
    });
    expect(series.points.some((p) => p.date === '2026-01-10')).toBe(false);
    expect(series.historyState).toBe('missing');
  });

  it('calls the latest day Behind plan above ideal and On track at equality (IB §8.5)', () => {
    const at = (remaining: number) =>
      buildBurndownSeries({
        ...WEEK,
        workingDays: DEFAULT_WORKING_DAYS,
        totalTaskEstimateAtStart: 40,
        snapshots: [snap('2026-01-05', 40, 0), snap('2026-01-06', remaining, 0)],
      });
    expect(at(31).status).toBe('behind-plan');
    expect(at(30).status).toBe('on-track'); // equality is On track
    expect(at(29).status).toBe('on-track');
    expect(at(31).latestSnapshotDate).toBe('2026-01-06');
  });
});

describe('All Teams aggregation', () => {
  it('fuses the Teams rows of one shared timebox per date', () => {
    expect(
      combineTeamSnapshots([
        snap('2026-01-06', 10, 2),
        snap('2026-01-05', 20, 0),
        snap('2026-01-06', 15, 3),
      ]),
    ).toEqual([snap('2026-01-05', 20, 0), snap('2026-01-06', 25, 5)]);
  });

  it('omits a date no Team snapshotted rather than treating absence as zero remaining', () => {
    const fused = combineTeamSnapshots([snap('2026-01-05', 20, 0)]);
    expect(fused.map((f) => f.date)).toEqual(['2026-01-05']);
  });
});
describe('partial captures (IB-BR-01: the source is an END-OF-DAY snapshot)', () => {
  /**
   * A day the job died in is frozen anyway — a closed day cannot be re-measured — so the number is
   * real but is not the closing figure the axis implies. That difference has to travel with it.
   */
  it('names the plotted days whose capture did NOT close the day', () => {
    const series = buildBurndownSeries({
      ...WEEK,
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: 40,
      snapshots: [
        snap('2026-01-05', 40, 0),
        // The job stopped at 10:04 — this is a mid-morning reading wearing a closing label.
        snap('2026-01-06', 32, 0, {
          capturedAt: new Date('2026-01-06T10:04:00Z'),
          endOfDay: false,
        }),
        snap('2026-01-07', 24, 5),
      ],
    });

    expect(series.partialCaptureDates).toEqual(['2026-01-06']);
    expect(series.points.find((p) => p.date === '2026-01-06')?.endOfDay).toBe(false);
    // The VALUE still stands: partial is not the same as unavailable, and blanking it would be the
    // fabrication IB §5 forbids in the other direction.
    expect(series.points.find((p) => p.date === '2026-01-06')?.remainingToDo).toBe(32);
  });

  it('reports nothing for a clean run, and null on days with no capture', () => {
    const series = buildBurndownSeries({
      ...WEEK,
      workingDays: DEFAULT_WORKING_DAYS,
      totalTaskEstimateAtStart: 40,
      snapshots: [snap('2026-01-05', 40, 0)],
    });

    expect(series.partialCaptureDates).toEqual([]);
    // A day with no snapshot has no capture to judge — null, not false, which would read as "the job
    // ran late" for a day it never ran at all.
    expect(series.points.find((p) => p.date === '2026-01-06')?.endOfDay).toBeNull();
  });

  it('fuses All Teams pessimistically: one team’s early stop makes the day partial', () => {
    // The summed total is only a closing figure if every contributing row closed its own day, and the
    // timestamp kept is the EARLIEST — the one that explains why.
    const fused = combineTeamSnapshots([
      snap('2026-01-05', 20, 3, { capturedAt: new Date('2026-01-05T23:40:00Z'), endOfDay: true }),
      snap('2026-01-05', 15, 2, { capturedAt: new Date('2026-01-05T09:10:00Z'), endOfDay: false }),
    ]);

    expect(fused).toHaveLength(1);
    expect(fused[0].remainingToDo).toBe(35);
    expect(fused[0].endOfDay).toBe(false);
    expect(fused[0].capturedAt?.toISOString()).toBe('2026-01-05T09:10:00.000Z');
  });
});

// ── Split markers (SU-08, SRS §10.2 / §10.3) ─────────────────────────────────

/**
 * One Split Event, with every field the two assemblers read holding a DIFFERENT value.
 *
 * That is the point of the fixture: the two sides carry different Plan Estimates and different keys,
 * and the retained Actual is non-zero — so a test cannot pass by reading the wrong side, and the
 * target's mandated `0h` opening cannot pass by copying the event's own number.
 */
const splitEvent = (over: Partial<StoredSplitEvent> = {}): StoredSplitEvent => ({
  splitId: 'split-1',
  sourceIterationId: 'it-source',
  targetIterationId: 'it-target',
  sourceMarkerDate: '2026-01-07',
  targetMarkerDate: '2026-01-19',
  unfinishedStoryId: 'wi-unfinished',
  unfinishedStoryKey: 'US-901',
  unfinishedPlanEstimate: 2,
  continuedStoryId: 'wi-continued',
  continuedStoryKey: 'US-900',
  continuedPlanEstimate: 3,
  movedTodoHours: 7,
  actualHoursAtSplit: 5,
  ...over,
});

describe('splitOutMarkers (SRS §10.2)', () => {
  it('names the [Unfinished] side, its historical points, the moved To Do and the RETAINED Actual', () => {
    expect(splitOutMarkers([splitEvent()])).toEqual([
      {
        splitId: 'split-1',
        kind: 'split-out',
        date: '2026-01-07',
        storyId: 'wi-unfinished',
        storyKey: 'US-901',
        points: 2,
        todoHours: 7,
        actualHours: 5,
      },
    ]);
  });

  it('plots on the SOURCE marker date, not the target’s', () => {
    // The two dates are clamped into different windows at write time; reading the wrong one puts the
    // annotation outside the chart it belongs to, where recharts simply does not draw it.
    const [marker] = splitOutMarkers([splitEvent()]);
    expect(marker.date).toBe('2026-01-07');
    expect(marker.date).not.toBe('2026-01-19');
  });

  it('keeps an unpointed placeholder as null rather than 0', () => {
    // `null` is "this Story was never estimated"; `0` is an estimate of nothing. The compact context
    // has to be able to say which.
    expect(splitOutMarkers([splitEvent({ unfinishedPlanEstimate: null })])[0].points).toBeNull();
  });

  it('emits one marker per event, in the order given', () => {
    const markers = splitOutMarkers([
      splitEvent({ splitId: 'a', sourceMarkerDate: '2026-01-08' }),
      splitEvent({ splitId: 'b', sourceMarkerDate: '2026-01-06' }),
    ]);
    // NOT re-sorted here: the repository already ordered them, and a second opinion about the order
    // would be a silent one.
    expect(markers.map((m) => m.splitId)).toEqual(['a', 'b']);
  });

  it('is empty for a timebox no Split touched', () => {
    expect(splitOutMarkers([])).toEqual([]);
  });
});

describe('carryInMarkers (SRS §10.3)', () => {
  it('names the [Continued] side, its points, the incoming To Do and a 0h opening Actual', () => {
    expect(carryInMarkers([splitEvent()])).toEqual([
      {
        splitId: 'split-1',
        kind: 'carry-in',
        date: '2026-01-19',
        storyId: 'wi-continued',
        storyKey: 'US-900',
        points: 3,
        todoHours: 7,
        actualHours: 0,
      },
    ]);
  });

  it('opens the target Actual at 0 even when the Split carried five hours of it', () => {
    // AC8, and the reason it gets its own test: the event's `actualHoursAtSplit` is 5 and the SOURCE
    // keeps all of it (§10.5). A carry-in that read the same field would double-count every hour.
    expect(carryInMarkers([splitEvent({ actualHoursAtSplit: 5 })])[0].actualHours).toBe(0);
    expect(carryInMarkers([splitEvent({ actualHoursAtSplit: 0 })])[0].actualHours).toBe(0);
  });

  it('carries the SAME To Do the source lost', () => {
    // One measured quantity, two charts: the hours that left the source are the hours that arrived.
    const event = splitEvent({ movedTodoHours: 12.5 });
    expect(carryInMarkers([event])[0].todoHours).toBe(splitOutMarkers([event])[0].todoHours);
  });

  it('keeps an unpointed continued Story as null rather than 0', () => {
    expect(carryInMarkers([splitEvent({ continuedPlanEstimate: null })])[0].points).toBeNull();
  });

  it('is empty for a timebox no Split touched', () => {
    expect(carryInMarkers([])).toEqual([]);
  });
});
