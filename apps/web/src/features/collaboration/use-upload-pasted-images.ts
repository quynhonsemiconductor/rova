/**
 * Uploads any pasted-image previews still living in a rich-text field's HTML
 * as blob: URLs, rewriting them to the durable, cookie-authenticated
 * `/attachments/{id}/content` route before the field is persisted.
 *
 * RichTextEditor inserts a pasted image immediately as a local
 * `URL.createObjectURL(file)` preview — no network call. The actual upload
 * only happens here, from the owning page's Save step, via the same
 * presign→PUT→confirm pipeline attachments already use (useUploadAttachment).
 */
import { useCallback } from 'react'
import { useUploadAttachment, type EntityRefType, type EntitySubject } from './api'

/** Same mapping the attachment list uses — see `ENTITY_PATH` in `ui/attachment-block.tsx`. */
const ENTITY_PATH: Record<EntityRefType, string> = {
  work_item: '/v1/work-items',
  portfolio_item: '/v1/portfolio-items',
  test_case: '/v1/test-cases',
}

const BLOB_IMG_RE = /<img\b[^>]*\bsrc="(blob:[^"]+)"[^>]*>/g

/** True when the HTML contains at least one blob: image that still needs uploading. */
export function hasPendingImages(html: string | null | undefined): boolean {
  return !!html && /<img\b[^>]*\bsrc="blob:/.test(html)
}

/**
 * `subject` is the entity the pasted images will hang off — a work item or a portfolio item.
 * Both detail pages paste into the same `RichTextEditor`, and since migration 0083 both can
 * own the resulting files, so this takes the pair rather than a work-item id.
 */
export function useUploadPastedImages(subject: EntitySubject | undefined) {
  const uploadMutation = useUploadAttachment(subject)

  /**
   * Replaces every `src="blob:..."` in `html` with the uploaded attachment's
   * durable content URL. A blob URL that fails to upload is left as-is rather
   * than silently dropping the image — the field save then surfaces the
   * error instead of quietly losing the picture.
   */
  const uploadAndRewrite = useCallback(
    async (html: string): Promise<string> => {
      if (!subject || !hasPendingImages(html)) return html

      const blobUrls = [...html.matchAll(BLOB_IMG_RE)].map((m) => m[1])
      const uniqueUrls = [...new Set(blobUrls)]

      const replacements = new Map<string, string>()
      for (const blobUrl of uniqueUrls) {
        const res = await fetch(blobUrl)
        const blob = await res.blob()
        const file = new File([blob], `pasted-image.${blob.type.split('/')[1] || 'png'}`, {
          type: blob.type,
        })
        const attachment = await uploadMutation.mutateAsync(file)
        replacements.set(
          blobUrl,
          `${ENTITY_PATH[subject.entityType]}/${subject.entityId}/attachments/${attachment.id}/content`,
        )
        URL.revokeObjectURL(blobUrl)
      }

      let rewritten = html
      for (const [blobUrl, contentUrl] of replacements) {
        rewritten = rewritten.split(blobUrl).join(contentUrl)
      }
      return rewritten
    },
    [subject, uploadMutation],
  )

  return { uploadAndRewrite, isUploading: uploadMutation.isPending }
}
