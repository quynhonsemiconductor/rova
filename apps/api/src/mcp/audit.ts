import { Logger } from '@nestjs/common';
import { getMeter } from '@quynhonsemiconductor/observability';
import type { Counter, Histogram } from '@opentelemetry/api';

/**
 * The MCP audit trail and metrics (MCP-PLAN §4/§11): one structured log line and three
 * instruments per tool call, plus one line, one counter for a rate-limit refusal.
 *
 * The principal is the rova USER ID, never the Access email: the id is what every other
 * audit surface in the product carries, and the log's own mixin already binds
 * `correlationId`/`workspaceId` through the request context.
 *
 * Labels are bounded by construction — the tool name comes from the fixed catalogue and the
 * outcome is an enum — so no id ever lands in a metric label. Duration is milliseconds, the
 * same unit the rest of the product's instruments use.
 */

export type ToolOutcome = 'ok' | 'error';

export interface ToolCallEvent {
  tool: string;
  principalId: string;
  durationMs: number;
  outcome: ToolOutcome;
}

/** The structured logger shape this module needs; Nest's Logger satisfies it. */
export interface AuditLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

/** The instruments, injectable so a unit test can count without an OTel exporter. */
export interface AuditInstruments {
  calls: Pick<Counter, 'add'>;
  errors: Pick<Counter, 'add'>;
  duration: Pick<Histogram, 'record'>;
  rateLimited: Pick<Counter, 'add'>;
}

export interface McpAudit {
  /** One line + the call/error/duration instruments. */
  onToolCall(event: ToolCallEvent): void;
  /** A request refused before any tool ran (one line + the rate-limit counter). */
  onRateLimited(principalId: string, limit: number, windowSeconds: number): void;
}

function defaultInstruments(): AuditInstruments {
  const meter = getMeter('rova-mcp');
  return {
    calls: meter.createCounter('mcp.tool.calls', {
      description: 'MCP tool calls, by tool and outcome',
    }),
    errors: meter.createCounter('mcp.tool.errors', {
      description: 'MCP tool calls that returned an error result or threw',
    }),
    duration: meter.createHistogram('mcp.tool.duration', {
      description: 'MCP tool call duration, including the REST calls one tool composes',
      unit: 'ms',
    }),
    rateLimited: meter.createCounter('mcp.rate_limited', {
      description: 'MCP requests refused by the per-person rate limit',
    }),
  };
}

/** Nest's Logger has no `info`; the payload goes first so pino serialises it as fields. */
function nestAuditLogger(): AuditLogger {
  const logger = new Logger('Mcp');
  return {
    info: (payload, message) => logger.log(payload, message),
    warn: (payload, message) => logger.warn(payload, message),
  };
}

export function createMcpAudit(
  options: {
    logger?: AuditLogger;
    instruments?: AuditInstruments;
  } = {},
): McpAudit {
  const logger = options.logger ?? nestAuditLogger();
  const instruments = options.instruments ?? defaultInstruments();

  return {
    onToolCall({ tool, principalId, durationMs, outcome }) {
      logger.info(
        {
          event: 'mcp.tool_call',
          tool,
          principalId,
          durationMs,
          outcome,
          rateLimited: false,
        },
        'MCP tool call',
      );
      instruments.calls.add(1, { tool, outcome });
      if (outcome === 'error') instruments.errors.add(1, { tool });
      instruments.duration.record(durationMs, { tool });
    },

    onRateLimited(principalId, limit, windowSeconds) {
      logger.warn(
        {
          event: 'mcp.rate_limited',
          principalId,
          rateLimited: true,
          limit,
          windowSeconds,
        },
        'MCP rate limit hit',
      );
      instruments.rateLimited.add(1);
    },
  };
}
