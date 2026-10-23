import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE MCP RATCHET (MCP-PLAN §4). The HTTP layer is the authorization point: every tool call must
 * cross the same guards (`PolicyGuard` and friends) as the person's own session, which is why a
 * tool composes REST routes through in-process `inject()` and nothing else. A tool that imported
 * a controller, service, repository or DB client directly would skip all of it, and a tool that
 * copied a network header into the in-process call would make the principal forgeable. This spec
 * fails any such change in `src/tools/`.
 *
 * Guards the SHAPE, not a count (route counts drift; this does not). It checks imports and
 * comment-stripped source, so the prose above can keep explaining why these rules exist.
 */

const TOOLS_DIR = __dirname; // this spec lives IN the directory it ratchets

function toolFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(TOOLS_DIR, f));
}

/** Line comments, block comments — enough for these mechanical checks (strings in a tool file never contain them). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(src: string): string[] {
  return [...src.matchAll(/(?:import|export)[^'"]*from\s+'([^']+)'/g)].map((m) => m[1]);
}

/** The ONLY things a tool file may import: the MCP SDK, zod, node builtins, and this module's principal context. */
const ALLOWED_IMPORTS = [
  /^@modelcontextprotocol\//,
  /^zod$/,
  /^node:/,
  /^\.\.\/mcp-principal$/,
  /^\.\/[^/]*$/,
];

describe('MCP tools ratchet', () => {
  it('every tool file imports only the SDK, zod, node builtins and the principal context', () => {
    const files = toolFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const offenders = importsOf(readFileSync(file, 'utf8')).filter(
        (spec) => !ALLOWED_IMPORTS.some((re) => re.test(spec)),
      );
      expect(offenders, `${file} imports outside the allowlist`).toEqual([]);
    }
  });

  it('no tool file touches the raw request, a network header, or inject() headers', () => {
    for (const file of toolFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // The principal travels in the MCP context, never in a copied header.
      expect(src.match(/\bheaders\s*:/), file).toBeNull();
      expect(src.match(/\.(raw|headers)\b/), file).toBeNull();
      expect(src.match(/Cf-Access-Jwt-Assertion/i), file).toBeNull();
    }
  });

  it('every list tool declares a limit and a cursor (agent-sized pages, MCP-PLAN §11)', () => {
    for (const file of toolFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (!src.includes("url: '/v1/projects'")) continue;
      // this file registers a list tool: both page args must be in its input schema
      expect(src.match(/\bcursor\b/), `${file}: no cursor`).not.toBeNull();
      expect(src.match(/\blimit\b/), `${file}: no limit`).not.toBeNull();
    }
  });
});
