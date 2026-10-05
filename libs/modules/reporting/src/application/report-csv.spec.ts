import { describe, expect, it } from 'vitest';

import { CSV_BOM, csvText, exportFilename, toCsv } from './report-csv';

describe('csvText (RFC 4180 + injection guard)', () => {
  it('leaves a plain value alone', () => {
    expect(csvText('Sprint 26.1')).toBe('Sprint 26.1');
  });
  it('quotes a value containing a comma', () => {
    expect(csvText('a,b')).toBe('"a,b"');
  });
  it('doubles embedded quotes', () => {
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes a value containing a newline', () => {
    expect(csvText('a\nb')).toBe('"a\nb"');
  });
  it.each(['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx'])('guards %j', (value) => {
    expect(csvText(value).replace(/^"/, '').startsWith("'")).toBe(true);
  });
  it('renders null as empty', () => {
    expect(csvText(null)).toBe('');
  });
});

describe('toCsv', () => {
  it('writes a BOM, CRLF lines and numbers unguarded', () => {
    expect(toCsv(['A', 'B'], [['x', -1.5]])).toBe(`${CSV_BOM}A,B\r\nx,-1.5\r\n`);
  });
});

describe('exportFilename', () => {
  it('slugs every part', () => {
    expect(exportFilename('carryover', 'NextGen Platform', 'Sprint 26/1')).toBe(
      'carryover-NextGen-Platform-Sprint-26-1.csv',
    );
  });
  it('never ends a truncated part on a hyphen', () => {
    // 59 letters then a space: the hyphen it becomes is char 60, exactly where the cut lands.
    const name = exportFilename('carryover', `${'a'.repeat(59)} tail`, 'S1');
    expect(name).toBe(`carryover-${'a'.repeat(59)}-S1.csv`);
  });
});
