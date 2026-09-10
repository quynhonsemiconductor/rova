import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Attachment request/response contracts, shared by every surface that owns files.
 *
 * These lived in `@modules/work-items` while work items were the only owner. Migration 0083
 * made the link table polymorphic, so a portfolio item uses the identical shapes — leaving
 * them in work-items would have made `PortfolioModule` import that module for a contract that
 * has nothing to do with work items.
 */

// ── Request ───────────────────────────────────────────────────────────────────

export const PresignAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  /**
   * Base64 SHA-256 of the file the client is about to upload. Bound into the
   * presigned PUT signature so the bucket rejects any other body — this is what
   * makes the upload tamper-evident rather than merely size-checked.
   * Always 44 chars: 32 bytes base64-encoded, one '=' of padding.
   */
  checksumSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'must be a base64 SHA-256 digest'),
});

export class PresignAttachmentDto extends createZodDto(PresignAttachmentSchema) {}

// ── Response ──────────────────────────────────────────────────────────────────

export const PresignAttachmentResponseSchema = z.object({
  attachmentId: z.string().uuid(),
  uploadUrl: z.string().url().describe('Presigned PUT URL — expires in 5 minutes'),
  requiredHeaders: z
    .record(z.string(), z.string())
    .describe(
      'Headers the client MUST send on the PUT. They are part of the signature — ' +
        'omitting or altering any of them fails with SignatureDoesNotMatch.',
    ),
});

export class PresignAttachmentResponseDto extends createZodDto(PresignAttachmentResponseSchema) {}

// `status` is intentionally absent: only confirmed attachments are ever returned
// by a route, so it carried no information and invited clients to branch on it.
export const AttachmentResponseSchema = z.object({
  id: z.string().uuid(),
  /** The subject this file hangs off (0083; `test_case` added Phase 7 Phase C). Replaced `workItemId`. */
  entityType: z.enum(['work_item', 'portfolio_item', 'test_case']),
  entityId: z.string().uuid(),
  uploadedBy: z.string().uuid(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.string().datetime(),
});

export class AttachmentResponseDto extends createZodDto(AttachmentResponseSchema) {}

export const DownloadUrlResponseSchema = z.object({
  downloadUrl: z.string().url().describe('Presigned S3 GET URL — expires in 15 minutes'),
});

export class DownloadUrlResponseDto extends createZodDto(DownloadUrlResponseSchema) {}
