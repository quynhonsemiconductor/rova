import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityLogger, type ActivitySubject } from './activity-logger.service';
import type { IActivityLogRepository } from '../domain/ports/activity-log.repository';
import type { ActivityDiffConfig } from '../domain/activity-diff';
import { requestContextStorage } from '@platform';

const SUBJECT: ActivitySubject = {
  workspaceId: 'ws',
  projectId: 'pr',
  entityType: 'work_item',
  entityId: 'wi-1',
};

function makeRepo() {
  return {
    appendMany: vi.fn().mockResolvedValue(undefined),
    listFor: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 }),
  } satisfies IActivityLogRepository;
}

describe('ActivityLogger', () => {
  let repo: ReturnType<typeof makeRepo>;
  let logger: ActivityLogger;

  beforeEach(() => {
    repo = makeRepo();
    logger = new ActivityLogger(repo);
  });

  describe('build', () => {
    it('produces a uuid, defaults contextId to null and metadata to {}', () => {
      const input = logger.build(SUBJECT, 'actor', 'work_item.created');
      expect(input.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(input.contextId).toBeNull();
      expect(input.metadata).toEqual({});
      expect(input.entityId).toBe('wi-1');
      expect(input.action).toBe('work_item.created');
    });

    it('carries an explicit contextId (task anchored to its parent)', () => {
      const input = logger.build(
        { ...SUBJECT, entityType: 'task', entityId: 't-1', contextId: 'wi-1' },
        'actor',
        'task.updated',
      );
      expect(input.contextId).toBe('wi-1');
    });
  });

  describe('buildDiff', () => {
    const config: ActivityDiffConfig<{ name: string }> = {
      fields: ['name'],
      action: (f) => `wi.${f}_changed`,
    };

    it('maps each changed field to an input, using the config action', () => {
      const inputs = logger.buildDiff(
        SUBJECT,
        'actor',
        { name: 'A' },
        { name: 'B' },
        config,
        'wi.updated',
      );
      expect(inputs).toHaveLength(1);
      expect(inputs[0].action).toBe('wi.name_changed');
      expect(inputs[0].changes).toEqual({ field: 'name', old: 'A', new: 'B' });
    });

    it('falls back to fallbackAction when the config maps no action', () => {
      const inputs = logger.buildDiff(
        SUBJECT,
        'a',
        { name: 'A' },
        { name: 'B' },
        { fields: ['name'] },
        'wi.updated',
      );
      expect(inputs[0].action).toBe('wi.updated');
    });
  });

  describe('log / logSafe', () => {
    it('no-ops on empty input (no repo write)', async () => {
      await logger.log([]);
      await logger.logSafe([]);
      expect(repo.appendMany).not.toHaveBeenCalled();
    });

    it('stamps metadata.source = mcp on every row appended by an MCP-bridged write (G5)', async () => {
      const input = logger.build(SUBJECT, 'a', 'work_item.updated', null, { extra: 'kept' });
      await new Promise<void>((resolve) =>
        requestContextStorage.run(
          {
            workspaceId: 'ws',
            userId: 'u',
            sessionId: 's',
            correlationId: 'c',
            mcpBridged: true,
          } as never,
          () => {
            void logger.log([input]).then(resolve);
          },
        ),
      );
      expect(repo.appendMany).toHaveBeenCalledWith(
        [expect.objectContaining({ metadata: { extra: 'kept', source: 'mcp' } })],
        undefined,
      );
    });

    it('does not stamp a row from a normal request (or a job)', async () => {
      const input = logger.build(SUBJECT, 'a', 'work_item.updated');
      await logger.log([input]);
      expect(repo.appendMany).toHaveBeenCalledWith([input], undefined);
    });

    it('log forwards the transaction executor', async () => {
      const tx = {} as never;
      const input = logger.build(SUBJECT, 'a', 'work_item.created');
      await logger.log([input], { tx });
      expect(repo.appendMany).toHaveBeenCalledWith([input], tx);
    });

    it('log propagates repo failures', async () => {
      repo.appendMany.mockRejectedValueOnce(new Error('db down'));
      const input = logger.build(SUBJECT, 'a', 'work_item.created');
      await expect(logger.log([input])).rejects.toThrow('db down');
    });

    it('logSafe swallows repo failures', async () => {
      repo.appendMany.mockRejectedValueOnce(new Error('db down'));
      const input = logger.build(SUBJECT, 'a', 'work_item.created');
      await expect(logger.logSafe([input])).resolves.toBeUndefined();
    });
  });

  it('listFor delegates to the repository, carrying the workspace scope', async () => {
    await logger.listFor('wi-1', 'ws-1', 2, 25);
    expect(repo.listFor).toHaveBeenCalledWith('wi-1', 'ws-1', 2, 25);
  });
});
