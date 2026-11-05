import { describe, expect, it, vi } from 'vitest';
import { createMcpAudit, sanitizeWriteAudit, type AuditInstruments } from './audit';

const instruments = (): AuditInstruments => ({
  calls: { add: vi.fn() },
  errors: { add: vi.fn() },
  duration: { record: vi.fn() },
  rateLimited: { add: vi.fn() },
});

describe('MCP write audit (§6.7)', () => {
  it('keeps exactly the write fields and drops everything else', () => {
    const sanitized = sanitizeWriteAudit({
      write: true,
      httpStatus: 201,
      targets: ['US-1', 'DE-1'],
      fields: ['title', 'iterationId'],
      count: 2,
      dryRun: false,
      // A tool that "helpfully" attaches values must lose them here.
      title: 'SENSITIVE TITLE',
      body: 'SENSITIVE BODY',
      reason: 'SENSITIVE REASON',
    });
    expect(sanitized).toEqual({
      write: true,
      httpStatus: 201,
      targets: ['US-1', 'DE-1'],
      fields: ['title', 'iterationId'],
      count: 2,
      dryRun: false,
    });
    expect(JSON.stringify(sanitized)).not.toContain('SENSITIVE');
  });

  it('truncates targets to 25 and drops non-string entries', () => {
    const targets = Array.from({ length: 30 }, (_, i) => `US-${i}`);
    const sanitized = sanitizeWriteAudit({
      targets: [...targets, 7, null, { evil: true }],
      fields: ['a', 1],
      count: Number.NaN,
      write: 'yes',
    });
    expect(sanitized.targets).toHaveLength(25);
    expect(sanitized.fields).toEqual(['a']);
    expect(sanitized.count).toBeUndefined();
    expect(sanitized.write).toBeUndefined();
  });

  it('the logged payload carries no free text, even when the event does', () => {
    const info = vi.fn();
    const audit = createMcpAudit({
      logger: { info, warn: vi.fn() },
      instruments: instruments(),
    });
    audit.onToolCall({
      tool: 'rova_create_work_item',
      principalId: 'u-1',
      durationMs: 3,
      outcome: 'ok',
      write: true,
      httpStatus: 201,
      targets: ['US-1'],
      fields: ['title'],
      count: 1,
      dryRun: false,
      // Not in the event's public type — exactly what a careless caller would pass.
      ...({ title: 'SENTINEL TITLE', description: 'SENTINEL BODY' } as object),
    });

    const payload = JSON.stringify(info.mock.calls[0][0]);
    expect(payload).not.toContain('SENTINEL');
    expect(JSON.parse(payload)).toMatchObject({
      event: 'mcp.tool_call',
      write: true,
      httpStatus: 201,
      targets: ['US-1'],
      fields: ['title'],
      count: 1,
      dryRun: false,
    });
  });
});
