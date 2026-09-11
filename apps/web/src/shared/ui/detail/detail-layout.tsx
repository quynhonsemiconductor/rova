/**
 * DetailLayout — the single, shared *shell* for every entity detail page
 * (release, milestone, iteration, work-item). The detail-surface equivalent of
 * `shared/ui/table/data-table-frame.tsx`.
 *
 * Why this exists
 * ---------------
 * Release-detail and milestone-detail were byte-for-byte identical chrome — the
 * `flex flex-1 flex-col overflow-hidden bg-background` outer, the
 * `bg-primary-dark text-white` header block, the `<DetailHeader>` and the
 * hand-rolled dark tab bar — and had already drifted (sidebar `w-72` vs `w-80`,
 * `bg-surface` vs `bg-card`). This component owns that chrome so it can never
 * drift again: a detail page supplies header props + tabs, and renders the
 * active tab's panel as `children`.
 *
 * Composition:
 *   <DetailLayout {...headerProps} tabs activeTab onTabChange>
 *     {activeTab === 'details' ? <DetailTwoPane .../> : <SomeTab .../>}
 *   </DetailLayout>
 */
import { useState, type ReactNode } from 'react'
import { Minimize2, PanelRightClose, PanelRightOpen } from 'lucide-react'

import { DetailHeader } from '@/shared/ui/detail-header'
import type { EntityLinkSubject } from '@/shared/lib/entity-link'
import { IconButton } from '@/shared/ui/icon-button'
import { DetailTabBar, type DetailTab } from '@/shared/ui/detail/detail-tab-bar'

/** Fallback accessible name for the collapse control; callers pass a `t()` string. */
const COLLAPSE_FALLBACK_LABEL = 'Collapse to summary panel'

interface DetailLayoutProps {
  // ── Header (forwarded to DetailHeader) ───────────────────────────────────
  onBack: () => void
  backLabel?: string
  /** Leading glyph/badge (e.g. a type chip). */
  badge?: ReactNode
  /** Monospace key shown before the title. */
  itemKey?: ReactNode
  /** Title — a string, or an inline-edit input node. */
  title: ReactNode
  /** Status badge, right-aligned before actions. */
  status?: ReactNode
  /** Right-side action controls (save, delete menu…). */
  actions?: ReactNode
  /** `Copy link` subject, forwarded to {@link DetailHeader}. Every detail page passes it. */
  copyLink?: EntityLinkSubject
  /**
   * Collapse this full-page detail back to the *summary panel* on its list
   * surface (WID-FR-003 / WID-AC-07, mockup `shared.tsx` → `WorkItemDetailPage.onMinimize`).
   *
   * Omit it and no control renders — the slot is opt-in because only a surface that HAS a
   * summary panel to collapse into can honour it. It lives here rather than in each page's
   * `actions` so the control's glyph, position (last before the divider + close) and
   * accessible name cannot drift between detail surfaces, the same reason `onBack` does.
   *
   * This is NOT the close button: `onBack` leaves the item behind, `onCollapse` must keep it
   * SELECTED on the surface it returns to. That is the whole of AC 7, and it is the caller's
   * responsibility — this component only renders the affordance.
   */
  onCollapse?: () => void
  /** Accessible name + tooltip for the collapse control. Pass a `t()` string. */
  collapseLabel?: string
  /**
   * Entity-wide summary rendered BETWEEN the header and the tabs.
   *
   * For anything that describes the whole record rather than one tab — the capacity plan's metric
   * panel, for instance. Omit and the tabs join the dark header block.
   *
   * Passing this ALSO changes where the tabs live: a summary has to sit under the header it
   * describes, so the tabs move below it and onto the page background. Otherwise the page would
   * read navy / white summary / navy tabs — three bands where there should be two. The tab bar
   * follows suit and renders light (see {@link DetailTabBar}); only the Capacity Plan does this.
   */
  summary?: ReactNode
  // ── Tabs ─────────────────────────────────────────────────────────────────
  tabs: DetailTab[]
  activeTab: string
  onTabChange: (key: string) => void
  /** The active tab's panel. */
  children: ReactNode
}

export function DetailLayout({
  onBack,
  backLabel,
  badge,
  itemKey,
  title,
  status,
  actions,
  copyLink,
  onCollapse,
  collapseLabel,
  summary,
  tabs,
  activeTab,
  onTabChange,
  children,
}: DetailLayoutProps) {
  const collapseName = collapseLabel ?? COLLAPSE_FALLBACK_LABEL
  // A real <button> via IconButton — so Enter/Space work and the control has an accessible
  // name. Tuned for the navy bar like the header's own back/close controls.
  const headerActions = onCollapse ? (
    <>
      {actions}
      <IconButton
        size="lg"
        variant="ghost"
        aria-label={collapseName}
        title={collapseName}
        onClick={onCollapse}
        className="text-white/80 hover:bg-white/10 hover:text-white"
      >
        <Minimize2 size={17} />
      </IconButton>
    </>
  ) : (
    actions
  )

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* ONE dark block: the header, and the tabs with it when there is no summary. Rally keeps
          its tabs on the page background, and this deliberately diverges — a white band between
          the navy header and the tabs split one heading into two, and the tabs name the entity the
          header names. */}
      <div className="shrink-0 bg-primary-dark text-white">
        <DetailHeader
          onBack={onBack}
          backLabel={backLabel}
          badge={badge}
          itemKey={itemKey}
          title={title}
          status={status}
          actions={headerActions}
          copyLink={copyLink}
        />
        {!summary && <DetailTabBar tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />}
      </div>

      {/* A summary describes the whole entity, so it belongs directly under the header rather than
          below the tabs, where it would read as part of whichever tab is selected. That pushes the
          tabs out of the dark block — three bands of navy / white / navy is worse than the light
          tab bar this keeps, which is what the Capacity Plan had all along. */}
      {summary}
      {summary && (
        <DetailTabBar tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} light />
      )}

      {children}
    </div>
  )
}

/**
 * DetailTwoPane — the standard "details" tab body: a scrollable main column
 * (rich-text editors / primary content) and a collapsible right sidebar
 * (metadata fields). The sidebar owns the SAME chrome as the Work Item detail
 * sidebar — a sticky `{title}` header with a collapse toggle + divider, and a
 * thin re-open handle when hidden — so every detail page reads identically.
 *
 * Callers pass only the field controls as `sidebar`; the uppercase title header
 * is rendered here (do NOT also pass a `DetailSectionHeading`).
 */
export function DetailTwoPane({
  main,
  sidebar,
  sidebarTitle = 'Details',
}: {
  main: ReactNode
  sidebar: ReactNode
  /** Uppercased header label for the sidebar (e.g. "Details", "Metadata"). */
  sidebarTitle?: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex-1 space-y-6 overflow-y-auto bg-card p-6">{main}</div>

      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          title="Show sidebar"
          className="flex w-6 shrink-0 items-center justify-center border-l border-input bg-surface-subtle transition-colors hover:bg-border-subtle"
        >
          <PanelRightOpen size={14} className="text-muted-foreground" />
        </button>
      ) : (
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-input bg-card">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-avatar bg-card px-3 py-2">
            <span className="text-ui-sm font-semibold tracking-wide text-muted-foreground uppercase">
              {sidebarTitle}
            </span>
            <button
              onClick={() => setCollapsed(true)}
              title="Hide sidebar"
              className="rounded p-1 transition-colors hover:bg-surface-subtle"
            >
              <PanelRightClose size={14} className="text-muted-foreground" />
            </button>
          </div>
          <div className="space-y-5 p-5">{sidebar}</div>
        </aside>
      )}
    </div>
  )
}
