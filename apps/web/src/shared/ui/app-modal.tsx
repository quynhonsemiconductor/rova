/**
 * AppModal — Rally's standard modal shell built on Radix Dialog.
 *
 * Benefits over hand-rolled `fixed inset-0` divs:
 *  - Focus trap (Tab stays inside the modal)
 *  - Escape key closes automatically
 *  - Body scroll-lock while open
 *  - Accessible: role=dialog, aria-modal, aria-labelledby via DialogTitle
 *  - Animated open/close (fade + zoom)
 *
 * Exports:
 *   <AppModal>     — modal shell with header (title + subtitle + X button)
 *   <ModalBody>    — scrollable content area with standard padding
 *   <ModalFooter>  — sticky footer row (border-top + surface bg + right-aligned)
 *
 * Usage:
 *   <AppModal open={open} onClose={onClose} title="New Iteration" width={480}>
 *     <ModalBody className="space-y-4">
 *       <FormField label="Name" required>
 *         <Input value={name} onChange={(e) => setName(e.target.value)} />
 *       </FormField>
 *     </ModalBody>
 *     <ModalFooter>
 *       <button onClick={onClose}>Cancel</button>
 *       <button onClick={submit}>Create</button>
 *     </ModalFooter>
 *   </AppModal>
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/shared/lib/utils'
import { TARGET_SQUARE } from '@/shared/ui/target-size'
import { BRAND } from '@/shared/config/brand'

// ── AppModal ──────────────────────────────────────────────────────────────────

interface AppModalProps {
  open: boolean
  onClose: () => void
  /** Shown in the modal header (maps to aria-labelledby via DialogTitle) */
  title: string
  /** Optional secondary line in the header */
  subtitle?: string
  /** Optional leading icon in the header, rendered in a tinted tile before the title. */
  icon?: ReactNode
  /**
   * Card width in pixels. Default: 480. Never wider than the viewport: the card is capped at
   * `100vw - 1.5rem`, so a wide modal (e.g. Split story) shrinks on a narrow screen instead of
   * overflowing it.
   */
  width?: number
  children: ReactNode
  className?: string
}

export function AppModal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  width = 480,
  children,
  className,
}: AppModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogPrimitive.Portal>
        {/* ── Backdrop ─────────────────────────────────────────────────────── */}
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.28)' }}
        />

        {/* ── Card ─────────────────────────────────────────────────────────── */}
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'flex flex-col overflow-hidden rounded bg-white shadow-2xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            'duration-150 outline-none',
            className,
          )}
          /**
           * `maxHeight` is what makes `ModalBody`'s scrolling work at all.
           *
           * The card is centred with `top-1/2 -translate-y-1/2`, so with no height ceiling a tall
           * form grows in BOTH directions and runs off the top and bottom of the screen at once.
           * `ModalBody` is already `flex-1 overflow-y-auto` — built to scroll — but a flex child
           * only scrolls when its parent has a height to be constrained by, so without this it
           * simply grew instead and took the header and the footer BUTTONS off-screen with it.
           * That is the failure mode: not a clipped form, an unreachable Create button. Reported
           * on Settings > Workspaces & Projects > Create project, 2026-08-24.
           *
           * `90dvh`, not `90vh`: on a mobile browser `vh` is the tallest viewport, including the
           * space the collapsing URL bar occupies, so a `90vh` card can still be cut off there.
           */
          style={{
            width,
            maxWidth: 'calc(100vw - 1.5rem)',
            maxHeight: '90dvh',
            border: `1px solid ${BRAND.border}`,
          }}
        >
          {/* ── Header ───────────────────────────────────────────────────── */}
          <div
            className="flex shrink-0 items-center justify-between px-5 py-3.5"
            style={{
              backgroundColor: BRAND.surfaceHover,
              borderBottom: `1px solid ${BRAND.borderSubtle}`,
            }}
          >
            <div className="flex min-w-0 items-center gap-3">
              {icon && (
                <span
                  aria-hidden="true"
                  className="flex shrink-0 items-center justify-center rounded bg-accent-blue p-2 text-primary"
                >
                  {icon}
                </span>
              )}
              <div className="min-w-0">
                <DialogPrimitive.Title
                  className="text-ui-lg font-semibold break-words"
                  style={{ color: BRAND.textPrimary }}
                >
                  {title}
                </DialogPrimitive.Title>
                {subtitle && (
                  <DialogPrimitive.Description
                    className="text-ui-sm"
                    style={{ color: BRAND.textMuted }}
                  >
                    {subtitle}
                  </DialogPrimitive.Description>
                )}
              </div>
            </div>

            <DialogPrimitive.Close asChild>
              <button
                className={cn(TARGET_SQUARE, 'rounded transition-colors hover:bg-border-inner')}
                aria-label="Close"
                style={{ color: BRAND.textMuted }}
              >
                <X size={15} />
              </button>
            </DialogPrimitive.Close>
          </div>

          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// ── ModalBody ─────────────────────────────────────────────────────────────────

interface ModalBodyProps {
  children: ReactNode
  className?: string
}

/** Scrollable content area with standard 20px padding. */
export function ModalBody({ children, className }: ModalBodyProps) {
  return <div className={cn('flex-1 overflow-y-auto p-5', className)}>{children}</div>
}

// ── ModalFooter ───────────────────────────────────────────────────────────────

interface ModalFooterProps {
  children: ReactNode
  className?: string
}

/** Sticky footer row with top border, surface background, and right-aligned content. */
export function ModalFooter({ children, className }: ModalFooterProps) {
  return (
    <div
      className={cn('flex shrink-0 items-center justify-end gap-2 px-5 py-3', className)}
      style={{
        borderTop: `1px solid ${BRAND.borderSubtle}`,
        backgroundColor: BRAND.surfaceHover,
      }}
    >
      {children}
    </div>
  )
}
