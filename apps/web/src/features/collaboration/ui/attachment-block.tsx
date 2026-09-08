/**
 * AttachmentBlock — Rally-style attachment table.
 *
 * Features:
 * - Table layout: Name (download link) · Description · When · Size, with a
 *   per-row gear actions menu (Delete).
 * - Hover thumbnail preview for image attachments (Rally parity).
 * - Slim "＋ Drag or click to add attachments" row that doubles as the
 *   drag-and-drop target and file picker (any file, max 10 MB).
 * - Click a name to download via /v1/work-items/{id}/attachments/{id}/content
 *   (authorizes, then 302s to a short-lived presigned URL).
 * - Read-only mode hides the gear menu and the add row.
 * - Pasted-image previews in the rich-text editors upload on Save (see
 *   useUploadPastedImages) and then appear here — this block only lists what
 *   the server already has.
 */
import { formatDate, relativeTime, cn } from '@/shared/lib/utils'
import { useClickOutside } from '@/shared/lib/hooks/use-click-outside'
import { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Settings, Trash2, X } from 'lucide-react'
import { IconButton } from '@/shared/ui/icon-button'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import {
  useAttachments,
  useUploadAttachment,
  useDeleteAttachment,
  type EntityRefType,
  type EntitySubject,
} from '@/features/collaboration/api'

/**
 * Row-level path prefix. The `/content` URL is built from the ROW's own subject, not from the
 * block's prop: they are always the same today, but a row already carries the truth and
 * reading it there means the link cannot point at the wrong entity.
 */
const ENTITY_PATH: Record<EntityRefType, string> = {
  work_item: '/v1/work-items',
  portfolio_item: '/v1/portfolio-items',
  test_case: '/v1/test-cases',
}

/** Column headers — an array (not literal JSX text) so labels stay data. */
const COLUMN_LABELS = ['Name', 'Description', 'When', 'Size']

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface AttachmentBlockProps {
  /**
   * The entity the files hang off — a work item, a portfolio item, or a Test Case. A pair rather
   * than a bare id because each lives at a different API path and carries different edit
   * permissions; the block itself is identical for all three.
   */
  subject: EntitySubject | undefined
  readOnly?: boolean
}

export function AttachmentBlock({ subject, readOnly = false }: AttachmentBlockProps) {
  const { t } = useTranslation('work-items')
  const { data: attachments = [], isLoading } = useAttachments(subject)
  const uploadMutation = useUploadAttachment(subject)
  const deleteMutation = useDeleteAttachment(subject)

  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Holds the attachment id pending a delete confirmation (null = dialog closed).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const menuRef = useClickOutside<HTMLDivElement>(menuId !== null, () => setMenuId(null))

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || readOnly) return
      setSizeError(null)
      for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_SIZE) {
          setSizeError(`"${file.name}" exceeds the 10 MB limit.`)
          continue
        }
        await uploadMutation.mutateAsync(file).catch(() => null)
      }
    },
    [readOnly, uploadMutation],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      void handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      setMenuId(null)
      setDeletingId(id)
      await deleteMutation.mutateAsync(id).catch(() => null)
      setDeletingId(null)
    },
    [deleteMutation],
  )

  const isUploading = uploadMutation.isPending
  const hasRows = attachments.length > 0

  return (
    <section>
      {/* Section label — sits above the box (Rally parity). */}
      <span className="mb-1 flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground select-none">
        Attachments
        {hasRows && (
          <span className="rounded-full bg-avatar px-1.5 py-px text-ui-xs font-bold text-muted-foreground">
            {attachments.length}
          </span>
        )}
      </span>

      <div className="rounded border border-input bg-card">
        {isLoading && <div className="px-4 py-3 text-ui-md text-foreground-subtle">Loading…</div>}

        {!isLoading && hasRows && (
          <table className="w-full text-left text-ui-sm">
            <thead>
              <tr className="border-b border-input bg-surface-hover text-ui-xs font-semibold tracking-wider text-foreground-subtle uppercase select-none">
                {!readOnly && <th className="w-8" />}
                {COLUMN_LABELS.map((label, i) => (
                  <th
                    key={label}
                    className={`px-3 py-1.5 font-medium whitespace-nowrap ${
                      i === COLUMN_LABELS.length - 1 ? 'text-right' : ''
                    }`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {attachments.map((a) => {
                const isDeleting = deletingId === a.id
                // /content re-authorizes then 302s to a fresh presigned URL.
                const downloadUrl = `${ENTITY_PATH[a.entityType]}/${a.entityId}/attachments/${a.id}/content`
                const isImage = a.mimeType?.startsWith('image/')
                return (
                  <tr
                    key={a.id}
                    className="group border-b border-border-inner transition-colors last:border-0 hover:bg-surface-hover"
                    style={{ opacity: isDeleting ? 0.5 : 1 }}
                  >
                    {/* Gear actions menu */}
                    {!readOnly && (
                      <td className="px-2">
                        <div className="relative" ref={menuId === a.id ? menuRef : undefined}>
                          <IconButton
                            aria-label={`Actions for ${a.filename}`}
                            title="Actions"
                            onClick={() => setMenuId((id) => (id === a.id ? null : a.id))}
                          >
                            {isDeleting ? (
                              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            ) : (
                              <Settings size={13} />
                            )}
                          </IconButton>
                          {menuId === a.id && (
                            <>
                              <div className="absolute top-full left-0 z-50 mt-1 w-32 overflow-hidden rounded border border-input bg-card shadow-lg">
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(a.id)}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-ui-sm text-destructive transition-colors hover:bg-destructive-bg"
                                >
                                  <Trash2 size={12} /> Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    )}

                    {/* Name — download link + hover thumbnail for images */}
                    <td className="relative px-3 py-2">
                      <a
                        href={downloadUrl}
                        download={a.filename}
                        className="block truncate text-ui-md font-medium text-primary-light hover:underline"
                        title={a.filename}
                      >
                        {a.filename}
                      </a>
                      {isImage && (
                        <div className="pointer-events-none absolute top-full left-3 z-50 mt-1 hidden w-64 overflow-hidden rounded-md bg-tooltip-bg p-1.5 shadow-xl group-hover:block">
                          <div className="mb-1 truncate px-1 text-ui-xs font-medium text-white">
                            {a.filename}
                          </div>
                          <img
                            src={downloadUrl}
                            alt={a.filename}
                            className="max-h-40 w-full rounded object-contain"
                            loading="lazy"
                          />
                        </div>
                      )}
                    </td>

                    {/* Description — not tracked yet; reserved column for parity */}
                    <td className="px-3 py-2 text-foreground-subtle" />

                    <td className="px-3 py-2 whitespace-nowrap text-foreground-subtle">
                      <span title={formatDate(a.createdAt)}>{relativeTime(a.createdAt)}</span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-foreground-subtle tabular-nums">
                      {formatBytes(a.sizeBytes)}
                    </td>
                  </tr>
                )
              })}

              {isUploading && (
                <tr>
                  <td colSpan={readOnly ? 4 : 5} className="px-3 py-2">
                    <span className="flex items-center gap-2 text-ui-md text-muted-foreground">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary-light border-t-transparent" />
                      Uploading…
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {/* Add row — drop target + file picker (Rally's single-line add bar) */}
        {!readOnly && (
          <div
            className={cn(
              'flex items-center gap-2 px-3 py-2 text-ui-sm transition-colors',
              hasRows && 'border-t border-input',
              dragging ? 'bg-primary-lighter text-primary-light' : 'text-primary-light',
            )}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
              aria-label="Upload file"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex w-full items-center gap-1.5 font-medium hover:underline"
            >
              <Plus size={14} />
              {dragging ? 'Drop to upload' : 'Drag or click to add attachments'}
            </button>
          </div>
        )}
      </div>

      {/* Error messages */}
      {sizeError && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded border border-destructive-border bg-destructive-bg px-3 py-2 text-ui-sm text-destructive">
          <span>{sizeError}</span>
          <button type="button" onClick={() => setSizeError(null)} aria-label="Dismiss error">
            <X size={12} />
          </button>
        </div>
      )}
      {uploadMutation.isError && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded border border-destructive-border bg-destructive-bg px-3 py-2 text-ui-sm text-destructive">
          <span>Upload failed: {(uploadMutation.error as Error)?.message ?? 'Unknown error'}</span>
          <button type="button" onClick={() => uploadMutation.reset()} aria-label="Dismiss error">
            <X size={12} />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title={t('attachments.deleteTitle', 'Delete attachment')}
        message={t('attachments.deleteConfirm', 'Delete this attachment? This cannot be undone.')}
        confirmLabel={t('attachments.delete', 'Delete')}
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => {
          const id = confirmDeleteId
          setConfirmDeleteId(null)
          if (id) void handleDelete(id)
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </section>
  )
}
