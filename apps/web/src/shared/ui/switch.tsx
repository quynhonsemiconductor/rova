/**
 * Switch — the standard on/off toggle for settings that apply immediately
 * (no Save button). Use this, not a checkbox, whenever a change is persisted
 * the moment it flips — a checkbox reads as "selected for a batch action".
 *
 * Backed by a visually-hidden native checkbox (`role="switch"`) so it stays
 * keyboard- and screen-reader-accessible; the track/thumb are pure CSS driven
 * by the peer's `:checked` state.
 */
import { cn } from '@/shared/lib/utils'

interface SwitchProps {
  checked: boolean
  onChange: () => void
  /** Required for a11y — e.g. "Work item assigned — Email". */
  ariaLabel: string
  disabled?: boolean
  className?: string
}

export function Switch({ checked, onChange, ariaLabel, disabled = false, className }: SwitchProps) {
  return (
    <label
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
        className="peer sr-only"
      />
      <span className="absolute inset-0 rounded-full bg-border transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 peer-focus-visible:ring-offset-1" />
      <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
    </label>
  )
}
