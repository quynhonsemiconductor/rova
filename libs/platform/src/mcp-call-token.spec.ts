import { describe, expect, it } from 'vitest';
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

  it('a minted token is unguessable: two mints never collide', () => {
    const a = mintMcpCallToken(PRINCIPAL);
    const b = mintMcpCallToken(PRINCIPAL);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 256-bit, base64url
  });
});
