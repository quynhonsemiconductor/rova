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

/**
 * What a write tool may report about the write it made (design §6.7). IDS, KEYS and FIELD NAMES,
 * plus `reason` — the justification the MCP v2 review requires `rova_delete` to record. No other
 * value and no other free text (a title, a comment body) passes. `sanitize` keeps exactly these
 * keys and nothing else, and bounds `reason` to 500 characters.
 */
export interface WriteAuditData {
  write?: boolean;
  httpStatus?: number;
  /** Item ids or keys the call touched (≤ 25). */
  targets?: string[];
  /** FIELD NAMES that changed. */
  fields?: string[];
  /** How many rows the write affects (a bulk count ≥ targets). */
  count?: number;
  /** A plan preview: `true` means nothing was written. */
  dryRun?: boolean;
  /** The caller's stated reason for a destructive write (≤ 500 characters). */
  reason?: string;
}

export interface ToolCallEvent extends WriteAuditData {
  tool: string;
  principalId: string;
  durationMs: number;
  outcome: ToolOutcome;
}

const WRITE_KEYS = new Set([
  'write',
  'httpStatus',
  'targets',
  'fields',
  'count',
  'dryRun',
  'reason',
]);
const MAX_TARGETS = 25;
const MAX_REASON = 500;

/**
 * Keeps exactly the §6.7 write fields and drops everything else. Arrays are truncated, entries
 * that are not strings are dropped, and no string is copied from a non-whitelisted key. `reason`
 * is the one free-text field, kept only because the review requires an audited justification.
 */
export function sanitizeWriteAudit(input: Record<string, unknown>): WriteAuditData {
  const out: WriteAuditData = {};
  for (const [key, value] of Object.entries(input)) {
    if (!WRITE_KEYS.has(key)) continue;
    if (key === 'write' || key === 'dryRun') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (key === 'httpStatus' || key === 'count') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    } else if (key === 'targets' || key === 'fields') {
      if (Array.isArray(value)) {
        out[key] = value
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, MAX_TARGETS);
      }
    } else if (key === 'reason') {
      if (typeof value === 'string') out.reason = value.slice(0, MAX_REASON);
    }
  }
  return out;
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
    onToolCall(event) {
      const { tool, principalId, durationMs, outcome } = event;
      logger.info(
        {
          event: 'mcp.tool_call',
          tool,
          principalId,
          durationMs,
          outcome,
          rateLimited: false,
          // §6.7: ids/keys/field NAMES/counts, plus the bounded `reason` a delete records.
          ...sanitizeWriteAudit(event as unknown as Record<string, unknown>),
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
