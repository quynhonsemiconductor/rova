import 'reflect-metadata';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { WorkItemsController } from '@modules/work-items/interface/http/work-items.controller';
import { CollaborationController } from '@modules/collaboration/interface/http/collaboration.controller';
import { TestCaseRecordsController } from '@modules/test-cases/interface/http/test-case-records.controller';
import { WorkItemTestCasesController } from '@modules/test-cases/interface/http/test-cases.controller';
import { PortfolioItemsController } from '@modules/portfolio/interface/http/portfolio-items.controller';
import { IterationsController } from '@modules/iterations/interface/http/iterations.controller';

/**
 * G2 (MCP v2): the seven CREATE routes carry `@UseIdempotency()`. MCP sends an
 * `Idempotency-Key` on every create it makes, and the interceptor is opt-in per route — a route
 * without it silently ignores the header, so an LLM retry would create a duplicate.
 *
 * Asserted from the decorator metadata rather than by calling a route: the question is "is the
 * interceptor attached", and Nest stores exactly that.
 */
const CREATE_ROUTES: Array<{ label: string; controller: object; method: string }> = [
  {
    label: 'POST /v1/work-items',
    controller: WorkItemsController.prototype,
    method: 'createWorkItem',
  },
  {
    label: 'POST /v1/work-items/:id/tasks',
    controller: WorkItemsController.prototype,
    method: 'createTask',
  },
  {
    label: 'POST /v1/work-items/:id/comments',
    controller: CollaborationController.prototype,
    method: 'createComment',
  },
  {
    label: 'POST /v1/test-cases/:id/test-results',
    controller: TestCaseRecordsController.prototype,
    method: 'createResult',
  },
  {
    label: 'POST /v1/work-items/:id/test-cases',
    controller: WorkItemTestCasesController.prototype,
    method: 'create',
  },
  {
    label: 'POST /v1/portfolio-items',
    controller: PortfolioItemsController.prototype,
    method: 'createItem',
  },
  {
    label: 'POST /v1/iterations',
    controller: IterationsController.prototype,
    method: 'createIteration',
  },
];

describe('create routes are idempotent (G2)', () => {
  for (const route of CREATE_ROUTES) {
    it(`${route.label} carries @UseIdempotency`, () => {
      const handler = (route.controller as Record<string, unknown>)[route.method];
      expect(typeof handler).toBe('function');
      const interceptors = Reflect.getMetadata(INTERCEPTORS_METADATA, handler!);
      expect(Array.isArray(interceptors), 'no interceptor metadata on the route').toBe(true);
      expect(interceptors.length).toBeGreaterThan(0);
    });
  }
});
