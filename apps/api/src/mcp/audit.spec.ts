import { describe, expect, it, vi } from 'vitest';
import { createMcpAudit, type AuditInstruments, type AuditLogger } from './audit';

const PRINCIPAL = '0194a000-0000-7000-8000-0000000000aa';

function fakeLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const logger: AuditLogger = { info, warn };
  return { logger, info, warn };
}

function fakeInstruments() {
  const spies = {
    calls: vi.fn(),
    errors: vi.fn(),
    duration: vi.fn(),
    rateLimited: vi.fn(),
  };
  const instruments: AuditInstruments = {
    calls: { add: spies.calls },
    errors: { add: spies.errors },
    duration: { record: spies.duration },
    rateLimited: { add: spies.rateLimited },
  };
  return { instruments, spies };
}

describe('createMcpAudit', () => {
  it('logs one line per tool call and records the three instruments', () => {
    const { logger, info } = fakeLogger();
    const { instruments, spies } = fakeInstruments();
    const audit = createMcpAudit({ logger, instruments });

    audit.onToolCall({
      tool: 'rova_get_work_item',
      principalId: PRINCIPAL,
      durationMs: 12,
      outcome: 'ok',
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.tool_call',
        tool: 'rova_get_work_item',
        principalId: PRINCIPAL,
        durationMs: 12,
        outcome: 'ok',
        rateLimited: false,
      }),
      'MCP tool call',
    );
    expect(spies.calls).toHaveBeenCalledWith(1, {
      tool: 'rova_get_work_item',
      outcome: 'ok',
    });
    expect(spies.duration).toHaveBeenCalledWith(12, {
      tool: 'rova_get_work_item',
    });
    expect(spies.errors).not.toHaveBeenCalled();
  });

  it('counts an error outcome in the error counter too', () => {
    const { logger } = fakeLogger();
    const { instruments, spies } = fakeInstruments();
    createMcpAudit({ logger, instruments }).onToolCall({
      tool: 'rova_search_work_items',
      principalId: PRINCIPAL,
      durationMs: 40,
      outcome: 'error',
    });

    expect(spies.errors).toHaveBeenCalledWith(1, { tool: 'rova_search_work_items' });
    expect(spies.calls).toHaveBeenCalledWith(1, {
      tool: 'rova_search_work_items',
      outcome: 'error',
    });
  });

  it('logs a rate-limit hit with the principal id and no tool', () => {
    const { logger, warn } = fakeLogger();
    const { instruments, spies } = fakeInstruments();
    createMcpAudit({ logger, instruments }).onRateLimited(PRINCIPAL, 60, 60);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.rate_limited',
        principalId: PRINCIPAL,
        rateLimited: true,
        limit: 60,
        windowSeconds: 60,
      }),
      'MCP rate limit hit',
    );
    expect(spies.rateLimited).toHaveBeenCalledWith(1);
  });

  it('never puts a tool argument or a workspace id in a metric label', () => {
    const { logger } = fakeLogger();
    const { instruments, spies } = fakeInstruments();
    createMcpAudit({ logger, instruments }).onToolCall({
      tool: 'rova_whoami',
      principalId: PRINCIPAL,
      durationMs: 1,
      outcome: 'ok',
    });
    expect(Object.keys(spies.calls.mock.calls[0][1] as object)).toEqual(['tool', 'outcome']);
  });
});
