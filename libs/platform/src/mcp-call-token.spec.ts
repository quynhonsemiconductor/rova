import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeMcpCallToken,
  mintMcpCallToken,
  MCP_CALL_TOKEN_HEADER,
  peekMcpCallToken,
} from './mcp-call-token';

const PRINCIPAL = {
  userId: '0194a000-0000-7000-8000-0000000000aa',
  workspaceId: '0194a000-0000-7000-8000-000000000003',
  sessionId: 'mcp:req-1',
};

describe('MCP call tokens', () => {
  it('mint → peek → consume: the peek does NOT spend the unlock', () => {
    const token = mintMcpCallToken(PRINCIPAL);
    expect(peekMcpCallToken(token)).toEqual(PRINCIPAL);
    expect(peekMcpCallToken({ [MCP_CALL_TOKEN_HEADER]: token }[MCP_CALL_TOKEN_HEADER])).toEqual(
      PRINCIPAL,
    );
    // the guard's consume still works after any number of peeks
    expect(consumeMcpCallToken(token)).toEqual(PRINCIPAL);
  });

  it('single use: a replayed token is nothing, to peek and to consume alike', () => {
    const token = mintMcpCallToken(PRINCIPAL);
    expect(consumeMcpCallToken(token)).toEqual(PRINCIPAL);
    expect(consumeMcpCallToken(token)).toBeUndefined();
    expect(peekMcpCallToken(token)).toBeUndefined();
  });

  it('undefined, empty, array-first and unknown inputs are simply no principal', () => {
    for (const raw of [undefined, '', 'forged', ['a', 'b']]) {
      expect(consumeMcpCallToken(raw)).toBeUndefined();
      expect(peekMcpCallToken(raw)).toBeUndefined();
    }
    // an array header resolves to its FIRST value
    const token = mintMcpCallToken(PRINCIPAL);
    expect(peekMcpCallToken([token, 'other'])).toEqual(PRINCIPAL);
  });

  afterEach(() => vi.useRealTimers());

  it('an EXPIRED token is no principal — neither peeked nor consumed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
    const token = mintMcpCallToken(PRINCIPAL);
    vi.setSystemTime(new Date('2026-11-04T00:00:06Z')); // TTL is 5 s
    expect(peekMcpCallToken(token)).toBeUndefined();
    expect(consumeMcpCallToken(token)).toBeUndefined();
  });

  it('the pending map is SWEPT once it reaches its bound, dropping only expired entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
    const live: string[] = [];
    for (let i = 0; i < 1_000; i += 1) live.push(mintMcpCallToken(PRINCIPAL));
    // Everything minted above expires; the NEXT mint crossing the bound sweeps them.
    vi.setSystemTime(new Date('2026-11-04T00:00:06Z'));
    const fresh = mintMcpCallToken(PRINCIPAL);
    // The sweep did its job: the fresh token is the only live one.
    expect(peekMcpCallToken(fresh)).toEqual(PRINCIPAL);
    expect(live.every((token) => peekMcpCallToken(token) === undefined)).toBe(true);
  });

  it('a minted token is unguessable: two mints never collide', () => {
    const a = mintMcpCallToken(PRINCIPAL);
    const b = mintMcpCallToken(PRINCIPAL);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 256-bit, base64url
  });
});
