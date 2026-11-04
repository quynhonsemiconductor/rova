/**
 * Enable the MCP write catalogue for ONE e2e file, before `AppModule` is evaluated: the env
 * schema is parsed when the module graph is imported, so a `process.env` assignment inside the
 * spec body would be too late for the bootstrap's onRequest write gate.
 */
process.env['MCP_WRITES_ENABLED'] = 'true';
process.env['MCP_IDEMPOTENCY_SECRET'] = 'x'.repeat(32);

export {};
