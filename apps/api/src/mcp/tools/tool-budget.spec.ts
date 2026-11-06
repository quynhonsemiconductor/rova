import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, WRITE_TOOL_REGISTRARS } from './register';
import type { ToolContext } from './rest';

/**
 * The v2.0 TOOL BUDGET, pinned (MCP v2 design §4/§11): 52 rova tools — 38 reads + 14 writes.
 *
 * The budget is why the catalogue uses the create-or-update `save_*` shape for low-frequency
 * entities and leaves v2.1 candidates (split, carry-over, release) out. Nothing else fails when a
 * tool is added, so this is the one place the number is stated; the message points at the design
 * rather than at a file, because the decision lives there.
 */
const READ_TOOL_BUDGET = 38;
const WRITE_TOOL_BUDGET = 14;
const TOTAL_TOOL_BUDGET = READ_TOOL_BUDGET + WRITE_TOOL_BUDGET;

const fakeCtx: ToolContext = {
  principal: {
    userId: '0194a000-0000-7000-8000-0000000000aa',
    workspaceId: '0194a000-0000-7000-8000-000000000003',
    sessionId: 'mcp:budget',
  },
  callRest: async () => ({ statusCode: 200, json: {} }),
  noteWrite: () => undefined,
  idempotencyKey: () => 'k',
  clientIdempotencyKey: () => 'k',
};

function mountedNames(): string[] {
  const server = new McpServer({ name: 'budget', version: '0.0.0' });
  return registerTools(server, fakeCtx, undefined, { writes: true }).map(({ name }) => name);
}

describe('MCP v2.0 tool budget (§11)', () => {
  it(`mounts exactly ${TOTAL_TOOL_BUDGET} tools — never more`, () => {
    const names = mountedNames();
    const writeNames = new Set(WRITE_TOOL_REGISTRARS.map((tool) => tool.name));
    const reads = names.filter((name) => !writeNames.has(name));

    expect(
      names.length,
      `The MCP v2.0 budget is ${TOTAL_TOOL_BUDGET} tools (${READ_TOOL_BUDGET} read + ` +
        `${WRITE_TOOL_BUDGET} write; design §4/§11). Adding a tool means retiring one or moving ` +
        'it to the v2.1 list in the design, not raising this test.',
    ).toBe(TOTAL_TOOL_BUDGET);
    expect(reads.length, `read tools must stay at ${READ_TOOL_BUDGET}`).toBe(READ_TOOL_BUDGET);
    expect(WRITE_TOOL_REGISTRARS.length, `write tools must stay at ${WRITE_TOOL_BUDGET}`).toBe(
      WRITE_TOOL_BUDGET,
    );
    expect(new Set(names).size, 'tool names must be unique').toBe(names.length);
  });
});
