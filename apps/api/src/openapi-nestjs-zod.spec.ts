import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Pins the OpenAPI output shape for nullable zod fields (rova#793).
 *
 * zod >= 4.5 renders `z.string().nullable()` as a 2020-12 style `type: ["string","null"]`
 * list, which nestjs-zod 5.5.0's OpenAPI 3.0 conversion mishandles — output was `type:
 * "array", items: {type: "string"}` (a wrong type, caught by the OpenAPI contract check as
 * `response-property-list-of-types-widened`) and other properties carried raw type lists that
 * are invalid in an OpenAPI 3.0 document.
 *
 * The fix is the vendored patch `patches/nestjs-zod@5.5.0.patch`: nestjs-zod calls zod's
 * `toJSONSchema` with `target: "openapi-3.0"`, which keeps `anyOf`-style unions and emits the
 * canonical `nullable: true` form. This spec boots a real Swagger document and fails if either
 * regression returns. It does NOT weaken GHSA-mrhx-c7xc-m3w5's fix — that is in zod's
 * validation path, not its JSON Schema emitter.
 */

const NullableStringSchema = z.object({
  actorName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  timezone: z.string().nullable(),
});

class NullableStringDto extends createZodDto(NullableStringSchema) {}

@Controller('probe')
class ProbeController {
  @Post()
  @ApiBody({ type: NullableStringDto })
  create(@Body() _body: NullableStringDto) {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/** Minimal structural type for the parts of the generated document this spec reads. */
interface OpenApiDoc {
  components: {
    schemas: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
  };
}

let doc: unknown;

beforeAll(async () => {
  const app = await NestFactory.create(ProbeModule, new FastifyAdapter(), { logger: false });
  await app.init();
  const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
  const config = new DocumentBuilder().setTitle('spec').setVersion('1.0').build();
  doc = SwaggerModule.createDocument(app, config);
  await app.close();
});

describe('OpenAPI output for nullable zod fields (nestjs-zod patch)', () => {
  it('renders nullable fields as { type, nullable: true } — never a type list, never a wrong array', () => {
    const schemas = (doc as OpenApiDoc).components.schemas;
    const dtoSchema = Object.values(schemas).find((s) => s.properties?.actorName);
    expect(dtoSchema?.properties).toBeTruthy();
    for (const field of ['actorName', 'avatarUrl', 'timezone']) {
      const prop = dtoSchema!.properties![field];
      expect(prop).toBeTruthy();
      expect(Array.isArray(prop.type), `${field}: raw type list leaked into the spec`).toBe(false);
      expect(prop.type, `${field}: wrong array type leaked into the spec`).not.toBe('array');
      expect(prop.nullable).toBe(true);
    }
  });

  it('no schema in the whole document carries a 2020-12 style type list', () => {
    const typeLists: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        const t = (node as { type?: unknown }).type;
        if (Array.isArray(t)) typeLists.push(JSON.stringify(t));
        Object.values(node as Record<string, unknown>).forEach(walk);
      }
    };
    walk(doc);
    expect(typeLists).toEqual([]);
  });
});
