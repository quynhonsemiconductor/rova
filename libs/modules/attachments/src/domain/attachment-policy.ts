/**
 * Upload policy descriptors.
 *
 * Every upload surface in the product declares one of these. The shared
 * AttachmentsService enforces it; the surface's own module enforces
 * authorization. That split is deliberate:
 *
 *   - the MECHANICS (key layout, presign, checksum, size/MIME/quota gates,
 *     confirm, reap) are identical everywhere → they live here, once
 *   - the AUTHORIZATION ("may this actor attach to this thing?") depends on the
 *     owning context's permission model → it stays in the owning module
 *
 * Adding a surface is a descriptor + a link table. It is never a change to
 * StorageService or to storage.files.
 */

/** Identifies a surface. Also the first segment of every key it produces. */
export type UploadSurface =
  | 'work-item-attachment'
  | 'comment-attachment'
  | 'user-avatar'
  | 'workspace-logo'
  | 'test-case-attachment'
  | 'test-result-attachment';

export interface UploadPolicy {
  readonly surface: UploadSurface;

  /** Accepted MIME types. Client-declared and therefore advisory — see the
   *  note on `inlineDisposition` for why that is acceptable here. */
  readonly allowedMimeTypes: ReadonlySet<string>;

  readonly maxSizeBytes: number;

  /** Max completed files per owner. `null` = unbounded (e.g. a logo that is
   *  replaced rather than accumulated). */
  readonly maxPerOwner: number | null;

  /**
   * Which bucket the object lands in. `public` objects are world-readable by
   * key and CDN-cacheable — only ever correct for non-sensitive assets.
   */
  readonly visibility: 'private' | 'public';

  /**
   * Whether downloads may render in the browser (`inline`) or must always be
   * forced to disk (`attachment`).
   *
   * Defaults to `attachment` everywhere it possibly can, because MIME is
   * client-declared: a file claiming `image/png` can contain script. Serving it
   * with `Content-Disposition: attachment` makes that inert regardless of what
   * the bytes actually are. Surfaces that must render inline (avatars) pay for
   * it by accepting a raster-only MIME set — no SVG, ever.
   */
  readonly inlineDisposition: boolean;
}

/**
 * SVG is excluded from every policy on purpose. It is an active-content format
 * (inline <script>, foreignObject, external refs). It was previously accepted
 * for work-item attachments, which was survivable only because presigned GETs
 * are served from a foreign origin — the moment a CDN custom domain fronts the
 * bucket it becomes same-site stored XSS. Excluding it here removes the trap
 * rather than relying on a deployment detail to defuse it.
 */
const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
] as const;

/** Raster only — no SVG. Safe to render inline. */
const RASTER_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

const MB = 1024 * 1024;

/**
 * Files attached to a work item OR a portfolio item — one policy, because the two carry the
 * same limits and the same MIME allow-list. Renamed from `WORK_ITEM_ATTACHMENT_POLICY` when
 * migration 0083 made the link table polymorphic.
 *
 * `surface` deliberately keeps the old `work-item-attachment` value: it is the S3 KEY PREFIX
 * every already-uploaded object lives under, so changing it would strand them — the reaper
 * would still see them referenced, but no download URL would resolve. The prefix is an
 * implementation detail of where bytes sit, not a claim about which entity owns them.
 */
export const ENTITY_ATTACHMENT_POLICY: UploadPolicy = {
  surface: 'work-item-attachment',
  allowedMimeTypes: new Set([...RASTER_IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES]),
  maxSizeBytes: 25 * MB,
  maxPerOwner: 25,
  visibility: 'private',
  inlineDisposition: false,
};

/**
 * Files attached to a Test Case (Phase 7 Phase C, plan §2.6/C4). A NEW descriptor rather than
 * reusing `ENTITY_ATTACHMENT_POLICY` — the plan calls for admitting the new owner deliberately,
 * not implicitly, per `entity_ref_type`'s widening being "not neutral" (migration 0129's own
 * docblock). Same limits and MIME allow-list as the work-item/portfolio-item policy: the SRS
 * names no different rule for a Test Case's attachments.
 */
export const TEST_CASE_ATTACHMENT_POLICY: UploadPolicy = {
  surface: 'test-case-attachment',
  allowedMimeTypes: new Set([...RASTER_IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES]),
  maxSizeBytes: 25 * MB,
  maxPerOwner: 25,
  visibility: 'private',
  inlineDisposition: false,
};

/**
 * Files attached to a Test Result (Phase 7 Phase E). A NEW descriptor, same reasoning as
 * `TEST_CASE_ATTACHMENT_POLICY`: the plan calls for admitting each new owner deliberately. Same
 * limits and MIME allow-list — the SRS names no different rule for a Test Result's attachments.
 */
export const TEST_RESULT_ATTACHMENT_POLICY: UploadPolicy = {
  surface: 'test-result-attachment',
  allowedMimeTypes: new Set([...RASTER_IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES]),
  maxSizeBytes: 25 * MB,
  maxPerOwner: 25,
  visibility: 'private',
  inlineDisposition: false,
};

export const COMMENT_ATTACHMENT_POLICY: UploadPolicy = {
  surface: 'comment-attachment',
  allowedMimeTypes: new Set([...RASTER_IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES]),
  maxSizeBytes: 25 * MB,
  maxPerOwner: 10,
  visibility: 'private',
  inlineDisposition: false,
};

export const USER_AVATAR_POLICY: UploadPolicy = {
  surface: 'user-avatar',
  allowedMimeTypes: new Set(RASTER_IMAGE_MIME_TYPES),
  maxSizeBytes: 2 * MB,
  maxPerOwner: 1,
  visibility: 'public',
  inlineDisposition: true,
};

export const WORKSPACE_LOGO_POLICY: UploadPolicy = {
  surface: 'workspace-logo',
  allowedMimeTypes: new Set(RASTER_IMAGE_MIME_TYPES),
  maxSizeBytes: 2 * MB,
  maxPerOwner: 1,
  visibility: 'public',
  inlineDisposition: true,
};
