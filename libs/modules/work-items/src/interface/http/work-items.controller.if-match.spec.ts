import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { etagFor, parseIfMatch } from './work-items.controller';

/** The header half of G1: the ETag the GET emits, and how PATCH reads it back. */
describe('etagFor', () => {
  it('is a quoted, millisecond-exact ISO timestamp', () => {
    expect(etagFor(new Date('2026-11-04T08:00:00.123Z'))).toBe('"2026-11-04T08:00:00.123Z"');
  });
});

describe('parseIfMatch', () => {
  it('is absent when the header is absent or blank — the web path is unchanged', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('')).toBeUndefined();
    expect(parseIfMatch('   ')).toBeUndefined();
  });

  it('parses the quoted token the GET emitted, weak prefix included', () => {
    expect(parseIfMatch('"2026-11-04T08:00:00.123Z"')?.toISOString()).toBe(
      '2026-11-04T08:00:00.123Z',
    );
    expect(parseIfMatch('W/"2026-11-04T08:00:00.123Z"')?.toISOString()).toBe(
      '2026-11-04T08:00:00.123Z',
    );
  });

  it('refuses a malformed value with 400, not 412', () => {
    for (const value of ['2026-11-04T08:00:00.123Z', '"yesterday"', '*', '"2026-13-45"']) {
      expect(() => parseIfMatch(value)).toThrow(BadRequestException);
    }
  });
});
