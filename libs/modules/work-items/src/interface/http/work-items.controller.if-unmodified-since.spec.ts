import { describe, expect, it } from 'vitest';
import { parseIfUnmodifiedSince } from './work-items.controller';

/** The header half of G1: parsing, and the refusal of a value the precondition cannot use. */
describe('parseIfUnmodifiedSince', () => {
  it('is absent when the header is absent or blank — the web path is unchanged', () => {
    expect(parseIfUnmodifiedSince(undefined)).toBeUndefined();
    expect(parseIfUnmodifiedSince('')).toBeUndefined();
    expect(parseIfUnmodifiedSince('   ')).toBeUndefined();
  });

  it('parses the HTTP-date grammar and an ISO-8601 value', () => {
    expect(parseIfUnmodifiedSince('Wed, 21 Oct 2015 07:28:00 GMT')?.toISOString()).toBe(
      '2015-10-21T07:28:00.000Z',
    );
    expect(parseIfUnmodifiedSince('2026-11-03T10:00:00.000Z')?.toISOString()).toBe(
      '2026-11-03T10:00:00.000Z',
    );
  });

  it('refuses an unparsable value instead of guessing', () => {
    expect(() => parseIfUnmodifiedSince('yesterday')).toThrow(
      expect.objectContaining({ code: 'WORK_ITEM_INVALID_IF_UNMODIFIED_SINCE' }),
    );
  });
});
