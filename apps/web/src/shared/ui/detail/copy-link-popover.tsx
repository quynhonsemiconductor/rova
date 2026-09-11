/**
 * CopyLinkPopover — the `Copy link` control that sits immediately after a record's key in
 * {@link DetailHeader}, mirroring Rally's own placement and its five rows.
 *
 * It renders in ONE place — the shared detail header — so every detail surface gets the same
 * control with the same formats in the same order. A per-page copy of this is the mistake it
 * exists to prevent: nine popovers drift into nine different Markdown shapes, and the reader
 * pasting them cannot tell which surface produced which.
 *
 * The formats themselves are NOT here. {@link entityLinkFormats} owns them, pure and pinned by
 * its own spec, because escaping a user-supplied title into Markdown and HTML is the part that
 * breaks quietly. This component only lays the rows out and hands each one to {@link CopyButton}.
 *
 * Each row shows its rendering in a READ-ONLY input rather than as text: an input is selectable
 * and scrollable, so a reader can inspect a long URL and select a fragment by hand — which is
 * what Rally's own rows allow, and what a truncated `<span>` would take away.
 */
import { useTranslation } from 'react-i18next'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { Copy, X } from 'lucide-react'

import { AppPopoverContent } from '@/shared/ui/app-popover'
import { CopyButton } from '@/shared/ui/copy-button'
import { IconButton } from '@/shared/ui/icon-button'
import { entityLinkFormats, type EntityLinkSubject } from '@/shared/lib/entity-link'

export interface CopyLinkPopoverProps {
  subject: EntityLinkSubject
}

export function CopyLinkPopover({ subject }: CopyLinkPopoverProps) {
  const { t } = useTranslation('common')
  const formats = entityLinkFormats(subject)

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={t('copyLink.trigger')}
          title={t('copyLink.trigger')}
          // `data-state` is Radix's own open flag, so the trigger reads as pressed while its
          // panel is up — Rally boxes the icon the same way, and without it nothing on screen
          // connects the open popover to the button that opened it.
          className="rounded p-1.5 text-white transition-colors hover:bg-white/10 data-[state=open]:bg-white/20 data-[state=open]:ring-1 data-[state=open]:ring-white/40"
        >
          <Copy size={15} />
        </button>
      </PopoverPrimitive.Trigger>

      <AppPopoverContent
        align="start"
        sideOffset={6}
        className="w-[26rem] rounded-md border border-border bg-card p-3 shadow-lg"
      >
        {/* Rally points the panel at its trigger. Every other popover in this app is
            arrow-less, so this is a deliberate, local divergence for parity on a control
            that is copied from Rally screen-for-screen. */}
        <PopoverPrimitive.Arrow className="fill-card" width={12} height={6} />

        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-ui-sm font-semibold text-foreground">{t('copyLink.title')}</p>
          {/* Explicit dismissal, as Rally has. Outside-click and Esc both still work; this
              panel is the one popover in the app a reader is meant to linger inside, with five
              inputs to click into, so "click away" is not a discoverable way out of it. */}
          <PopoverPrimitive.Close asChild>
            <IconButton type="button" size="sm" aria-label={t('close')} title={t('close')}>
              <X size={14} />
            </IconButton>
          </PopoverPrimitive.Close>
        </div>

        <div className="flex flex-col gap-2">
          {formats.map((format) => (
            <div key={format.id}>
              <label
                htmlFor={`copy-link-${format.id}`}
                className="mb-1 block text-ui-xs text-foreground-subtle"
              >
                {t(`copyLink.formats.${format.id}`)}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id={`copy-link-${format.id}`}
                  readOnly
                  value={format.value}
                  // Selecting on focus makes the keyboard path match the button: tab to the row,
                  // the value is already selected, copy with the OS shortcut.
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1.5 text-ui-xs text-foreground"
                />
                <CopyButton
                  value={format.value}
                  html={format.html}
                  label={t('copyLink.copyFormat', { format: t(`copyLink.formats.${format.id}`) })}
                />
              </div>
            </div>
          ))}
        </div>
      </AppPopoverContent>
    </PopoverPrimitive.Root>
  )
}
