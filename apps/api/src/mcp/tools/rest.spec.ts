import { describe, expect, it } from 'vitest';
import {
  MCP_IDEMPOTENCY_BUCKET_MS,
  assertReadCarriesNoWritePayload,
  canonicalize,
  idempotencyKeyFor,
  isWriteMethod,
  pathSegment,
} from './rest';

const SECRET = 'x'.repeat(32);
const ME = '0194a000-0000-7000-8000-0000000000aa';
const TOOL = 'rova_add_comment';

describe('isWriteMethod', () => {
  it('classifies the four mutating methods as writes and GET/HEAD as reads', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
      expect(isWriteMethod(method)).toBe(true);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(isWriteMethod(method)).toBe(false);
  });
});

describe('pathSegment', () => {
  it('encodes separators so an id cannot become a path', () => {
    expect(pathSegment('a/b')).toBe('a%2Fb');
    expect(pathSegment('a?b#c%')).toBe('a%3Fb%23c%25');
  });

  it('refuses dot-only and empty segments (encodeURIComponent leaves dots alone)', () => {
    for (const value of ['', '.', '..']) expect(() => pathSegment(value)).toThrow(/dot-only|empty/);
    // A dot INSIDE a value is encoded too, so it decodes to the same segment.
    expect(pathSegment('a.b')).toBe('a%2Eb');
  });
});

describe('assertReadCarriesNoWritePayload', () => {
  it('accepts any write, and a bare read', () => {
    expect(() =>
      assertReadCarriesNoWritePayload({ method: 'POST', url: '/v1/work-items', body: {} }),
    ).not.toThrow();
    expect(() =>
      assertReadCarriesNoWritePayload({ method: 'GET', url: '/v1/work-items' }),
    ).not.toThrow();
  });

  it('refuses a read carrying a body or an idempotency key at runtime', () => {
    expect(() =>
      assertReadCarriesNoWritePayload({ method: 'GET', url: '/v1/work-items', body: {} }),
    ).toThrow(/carries a body/);
    expect(() =>
      assertReadCarriesNoWritePayload({
        method: 'GET',
        url: '/v1/work-items',
        idempotencyKey: 'abc',
      }),
    ).toThrow(/carries a body/);
  });
});

describe('canonicalize', () => {
  it('sorts keys at every depth, drops undefined fields, NFC-normalizes strings', () => {
    const decomposed = 'é';
    const composed = 'é';
    expect(JSON.stringify(canonicalize({ z: decomposed, a: { d: 1, b: 2 } }))).toBe(
      JSON.stringify({ a: { b: 2, d: 1 }, z: composed }),
    );
    expect(JSON.stringify(canonicalize({ a: 1, b: undefined }))).toBe(JSON.stringify({ a: 1 }));
  });

  it('NFC-normalizes object KEYS too, so composed and decomposed spellings hash alike', () => {
    const a = canonicalize({ 'e\u0301': 1 });
    const b = canonicalize({ '\u00e9': 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a as object)).toEqual(['\u00e9']);
  });

  it('refuses an undefined array element instead of silently renumbering the list', () => {
    expect(() => canonicalize(['a', undefined, 'b'])).toThrow(TypeError);
  });

  it('builds null-prototype objects, so a __proto__ key cannot pollute anything', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>;
    const out = canonicalize(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('idempotencyKeyFor (MCP-generated Idempotency-Key)', () => {
  it('is stable for one call inside one ten-minute bucket, whatever the key order', () => {
    const a = idempotencyKeyFor(SECRET, ME, TOOL, { body: 'hi', replyTo: null }, 1_000);
    const b = idempotencyKeyFor(SECRET, ME, TOOL, { replyTo: null, body: 'hi' }, 1_000 + 60_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes at the bucket boundary, so a deliberate second call is a new create', () => {
    const first = idempotencyKeyFor(SECRET, ME, TOOL, { body: 'hi' }, 0);
    const nextBucket = idempotencyKeyFor(
      SECRET,
      ME,
      TOOL,
      { body: 'hi' },
      MCP_IDEMPOTENCY_BUCKET_MS,
    );
    expect(nextBucket).not.toBe(first);
  });

  it('separates principal, tool and arguments', () => {
    const base = idempotencyKeyFor(SECRET, ME, TOOL, { body: 'hi' }, 0);
    expect(idempotencyKeyFor(SECRET, 'other-user', TOOL, { body: 'hi' }, 0)).not.toBe(base);
    expect(idempotencyKeyFor(SECRET, ME, 'rova_log_time', { body: 'hi' }, 0)).not.toBe(base);
    expect(idempotencyKeyFor(SECRET, ME, TOOL, { body: 'bye' }, 0)).not.toBe(base);
  });

  it('is keyed by the server secret: the same call under another secret is another key', () => {
    const base = idempotencyKeyFor(SECRET, ME, TOOL, { body: 'hi' }, 0);
    expect(idempotencyKeyFor('y'.repeat(32), ME, TOOL, { body: 'hi' }, 0)).not.toBe(base);
    expect(() => idempotencyKeyFor('', ME, TOOL, { body: 'hi' }, 0)).toThrow(
      /MCP_IDEMPOTENCY_SECRET/,
    );
  });
});
