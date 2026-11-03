import { describe, expect, it } from 'vitest';
import { MCP_IDEMPOTENCY_BUCKET_MS, idempotencyKeyFor, isWriteMethod } from './rest';

const ME = '0194a000-0000-7000-8000-0000000000aa';
const TOOL = 'rova_add_comment';

describe('isWriteMethod', () => {
  it('classifies the four mutating methods as writes and GET/HEAD as reads', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
      expect(isWriteMethod(method)).toBe(true);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(isWriteMethod(method)).toBe(false);
  });
});

describe('idempotencyKeyFor (MCP-generated Idempotency-Key)', () => {
  it('is stable for one call inside one ten-minute bucket, whatever the key order', () => {
    const a = idempotencyKeyFor(ME, TOOL, { body: 'hi', replyTo: null }, 1_000);
    const b = idempotencyKeyFor(ME, TOOL, { replyTo: null, body: 'hi' }, 1_000 + 60_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes at the bucket boundary, so a deliberate second call is a new create', () => {
    const first = idempotencyKeyFor(ME, TOOL, { body: 'hi' }, 0);
    const nextBucket = idempotencyKeyFor(ME, TOOL, { body: 'hi' }, MCP_IDEMPOTENCY_BUCKET_MS);
    expect(nextBucket).not.toBe(first);
  });

  it('separates principal, tool and arguments', () => {
    const base = idempotencyKeyFor(ME, TOOL, { body: 'hi' }, 0);
    expect(idempotencyKeyFor('other-user', TOOL, { body: 'hi' }, 0)).not.toBe(base);
    expect(idempotencyKeyFor(ME, 'rova_log_time', { body: 'hi' }, 0)).not.toBe(base);
    expect(idempotencyKeyFor(ME, TOOL, { body: 'bye' }, 0)).not.toBe(base);
  });

  it('ignores undefined fields and keeps array order significant', () => {
    const bare = idempotencyKeyFor(ME, TOOL, { body: 'hi' }, 0);
    expect(idempotencyKeyFor(ME, TOOL, { body: 'hi', replyTo: undefined }, 0)).toBe(bare);
    expect(idempotencyKeyFor(ME, TOOL, { mentions: ['a', 'b'] }, 0)).not.toBe(
      idempotencyKeyFor(ME, TOOL, { mentions: ['b', 'a'] }, 0),
    );
  });
});
