import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { IconButton } from '@/shared/ui/icon-button'

interface CopyButtonProps {
  /** Text written to the clipboard on click. */
  value: string
  /**
   * Optional `text/html` flavour, written ALONGSIDE `value`.
   *
   * Pass it only where the copy is meant to paste as rendered markup — a live hyperlink in a
   * document — rather than as its own source text. `value` stays the `text/plain` flavour, so a
   * target that takes no HTML still receives something sensible.
   *
   * Falls back to `value` alone wherever `ClipboardItem` is unavailable (older Safari, any
   * insecure context), because a copy that silently does nothing is worse than a plain one.
   */
  html?: string
  /** Accessible label (icon-only button). */
  label: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

/**
 * CopyButton — copy-to-clipboard icon action. Shows a transient check for ~1.5s
 * after a successful copy. Built on {@link IconButton} so it matches every other
 * icon action (focus ring, hover, disabled) app-wide.
 */
export function CopyButton({ value, html, label, size = 'sm', className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([value], { type: 'text/plain' }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(value)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — no-op */
    }
  }

  return (
    <IconButton
      type="button"
      size={size}
      aria-label={label}
      title={label}
      className={className}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </IconButton>
  )
}
