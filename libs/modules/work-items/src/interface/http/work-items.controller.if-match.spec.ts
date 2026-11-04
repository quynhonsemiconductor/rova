import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { etagFor, parseIfMatch } from './work-items.controller';

/** The header half of G1: the strong ETag the GET emits, and how PATCH reads it back. */
describe('etagFor', () => {
  it('is the quoted integer version — strong, never a timestamp', () => {
    expect(etagFor(0)).toBe('"0"');
    expect(etagFor(42)).toBe('"42"');
  });
});

describe('parseIfMatch', () => {
  it('is absent when the header is absent or blank — the web path is unchanged', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('')).toBeUndefined();
    expect(parseIfMatch('   ')).toBeUndefined();
  });

  it('parses the strong token the GET emitted', () => {
    expect(parseIfMatch('"42"')).toBe(42);
    expect(parseIfMatch('"0"')).toBe(0);
  });

  it('"*" means any existing item: no version check (the route 404s a missing one)', () => {
    expect(parseIfMatch('*')).toBeUndefined();
  });

  it('a WEAK validator never matches: mapped to -1, so the UPDATE finds no row (412)', () => {
    expect(parseIfMatch('W/"42"')).toBe(-1);
  });

  it('refuses a malformed value with 400, not 412', () => {
    for (const value of ['42', '"v42"', '"01"', '"2026-11-04T08:00:00.123Z"']) {
      expect(() => parseIfMatch(value)).toThrow(BadRequestException);
    }
  });
});
