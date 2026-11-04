/**
 * Keep the MCP write catalogue OFF for a read-only e2e file, before AppModule is evaluated: the
 * env schema is parsed at import time, and another file in the same worker may have enabled it.
 */
process.env['MCP_WRITES_ENABLED'] = 'false';
process.env['MCP_IDEMPOTENCY_SECRET'] = '';

export {};
