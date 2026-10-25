import type { DbExecutor } from '@platform';
import type { StoredFile, CreateFileInput } from '../file.types';

export const FILE_REPOSITORY = Symbol('FILE_REPOSITORY');

/**
 * Every read is workspace-scoped. There is deliberately no `findById(id)`
 * overload without a workspaceId — the previous duplicate implementation in the
 * collaboration module had one, and it was a cross-tenant read waiting for a
 * route.
 *
 * This layer is the ONLY isolation boundary, by design rather than by omission.
 * Rova is single-tenant (see the drop-multi-tenant design doc), so DB-level
 * isolation is an explicit non-goal and migration 0070 removed the last
 * `tenant_isolation` RLS policies. An earlier version of this comment said RLS was
 * "currently inert", which read as a gap someone should close — it was not. Closing
 * it is what broke every upload: the policies required `app.workspace_id`, which
 * nothing sets, so they denied all writes the moment the app stopped being the
 * table owner. `test/workspace-scope.ratchet.spec.ts` holds this boundary.
 */
export interface IFileRepository {
  findById(id: string, workspaceId: string): Promise<StoredFile | null>;

  create(input: CreateFileInput): Promise<StoredFile>;

  /** Mark completed after the object was verified in the bucket. */
  confirm(id: string, checksumSha256: string | null): Promise<StoredFile>;

  /** `tx` enlists the soft delete in the caller's unit of work (see EntityAttachmentsService). */
  softDelete(id: string, tx?: DbExecutor): Promise<void>;
}
