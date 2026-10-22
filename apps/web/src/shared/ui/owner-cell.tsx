import { cn } from '@/shared/lib/utils'
import { BRAND } from '@/shared/config/brand'
import { SearchableSelect, type SelectOption } from '@/shared/ui/searchable-select'

interface OwnerCellProps {
  name?: string | null
  /** Extra classes merged onto the wrapper. */
  className?: string
  /**
   * Clip a long name to one line with an ellipsis instead of wrapping it.
   *
   * OPT-IN, because the right answer depends on the column and not on the component. A wide Owner
   * column (Home's Project Health, at 160px) should wrap — the name is the whole value, and a
   * clipped one is unreadable. A NARROW column in a dense grid should clip: Quality renders two
   * people per row (`Submitted By` and `Owner`) and a wrapped name there grew every row to two
   * lines, so eleven defects took the vertical space of twenty-two and the grid stopped being
   * scannable. The full name stays available as the element's `title`.
   */
  truncate?: boolean
}

/**
 * Owner cell: a small initials chip + truncated name, with an em-dash
 * fallback when unassigned. Previously hand-rolled identically in backlog,
 * releases-detail and milestones-detail — consolidated here.
 *
 * (Distinct from the larger dark `Avatar` used in headers/menus.)
 */
/** Initials chip shared by the read-only {@link OwnerCell} and the editable owner select. */
export function OwnerAvatar({
  name,
  avatarUrl,
  size = 20,
  className,
}: {
  name: string
  /** Optional profile image; falls back to initials when absent or it fails to load. */
  avatarUrl?: string | null
  /** Diameter in px (font scales with it). */
  size?: number
  className?: string
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        // DECORATIVE, in both branches. The person's name is always rendered beside this glyph — in a
        // cell, an option row, a roster line — so naming the image repeats it, and the initials branch
        // below is worse: it put "WA" into the accessible name of every option, so a picker announced
        // "WA Wanda Admin" and a test (or a screen-reader user) looking for the person found neither.
        alt=""
        aria-hidden
        loading="lazy"
        className={cn('shrink-0 rounded-full object-cover', className)}
        style={{ width: size, height: size }}
      />
    )
  }

  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join('')

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        backgroundColor: BRAND.avatarBg,
        color: BRAND.avatarText,
      }}
    >
      {initials}
    </span>
  )
}

export function OwnerCell({ name, className, truncate = false }: OwnerCellProps) {
  if (!name) {
    return <span className="text-ui-sm text-foreground-disabled">--</span>
  }

  return (
    /*
     * `items-center`, not `items-start`, and no `overflow-hidden`: a person's name is user-supplied
     * and so unbounded, so it still wraps — but the chip now centres against the WHOLE wrapped
     * block rather than pinning to its first line.
     *
     * Top-alignment was chosen for a one-line name, where the two are indistinguishable. On a name
     * that wraps to two lines — "Hieu Vu Minh Bui" in a 128px column, which is the ordinary case for
     * a Vietnamese full name — the glyph sat against the first line with the second hanging below
     * it, so the cell read as top-heavy beside every neighbouring cell, which centres. Wrapping is
     * the common case here, not the exception, which is what makes centring the right default.
     */
    <div className={cn('flex items-center gap-1', truncate && 'overflow-hidden', className)}>
      <OwnerAvatar name={name} />
      {/* `text-ui-sm` and a line box at least as tall as the avatar — the same rule `TeamCell` follows.
          At 10px, top-aligned, a read-only owner rendered visibly smaller and higher than the identical
          value in an owner PICKER one row up. */}
      <span
        // `title` only when clipped: a tooltip repeating a fully visible name is noise.
        title={truncate ? name : undefined}
        className={cn(
          'flex min-h-5 min-w-0 items-center text-ui-sm text-muted-foreground',
          truncate ? 'truncate whitespace-nowrap' : 'break-words whitespace-normal',
        )}
      >
        {name}
      </span>
    </div>
  )
}

/** Minimal member shape accepted by {@link OwnerSelectCell}. */
export interface OwnerSelectMember {
  userId: string
  displayName?: string | null
  email?: string | null
}

const memberName = (m: OwnerSelectMember) => m.displayName ?? m.email ?? m.userId

/**
 * ONE person as a dropdown option: label, leading avatar, and searchable email.
 *
 * The smallest reusable piece, because `ownerSelectOptions` below is not always the right shape — an
 * actor FILTER leads with "All actors", an add-member picker offers no empty row, and neither wants
 * Rally's "Quick Picks" grouping. Those callers each hand-rolled `{ value, label }` instead, so the
 * same person appeared with a glyph in a list and without one in the dropdown two lines away.
 *
 * `searchText` carries the email so typing an address finds someone whose display name does not
 * contain it — the reason a person picker is a search dropdown at all. `extraSearch` is for a caller
 * that also wants a badge word to match (a Workspace Admin, say).
 */
export function memberSelectOption(
  m: OwnerSelectMember,
  { group, extraSearch }: { group?: string; extraSearch?: string } = {},
): SelectOption {
  const label = memberName(m)
  return {
    value: m.userId,
    label,
    icon: <OwnerAvatar name={label} size={16} />,
    searchText: `${m.displayName ?? ''} ${m.email ?? ''}${extraSearch ? ` ${extraSearch}` : ''}`,
    ...(group ? { group } : {}),
  }
}

/**
 * Grouped options for a person picker (Rally parity): a "Quick Picks" group
 * with "— No Entry —" and the current owner, then an alphabetical "Team
 * Members" group — each with a round {@link OwnerAvatar} glyph. Shared by the
 * in-grid {@link OwnerSelectCell} and the form-field OwnerSelectField.
 */
export function ownerSelectOptions(
  members: readonly OwnerSelectMember[],
  currentId?: string | null,
  currentName?: string | null,
): SelectOption[] {
  // The current owner may not be IN `members` (they can have left the team), so this keeps taking a
  // bare id + label rather than a member row; `memberSelectOption` covers the rows that are.
  const withAvatar = (value: string, label: string, group: string): SelectOption => ({
    value,
    label,
    group,
    icon: <OwnerAvatar name={label} size={16} />,
  })

  const options: SelectOption[] = [{ value: '', label: '— No Entry —', group: 'Quick Picks' }]

  const current = currentId ? members.find((m) => m.userId === currentId) : undefined
  const currentLabel = current ? memberName(current) : (currentName ?? null)
  if (currentId && currentLabel) {
    options.push(withAvatar(currentId, currentLabel, 'Quick Picks'))
  }

  const sorted = [...members].sort((a, b) => memberName(a).localeCompare(memberName(b)))
  for (const m of sorted) options.push(memberSelectOption(m, { group: 'Team Members' }))

  return options
}

interface OwnerSelectCellProps {
  /** Resolved display name for the current assignee (null → unassigned). */
  ownerName?: string | null
  /** Current assignee user id (null → unassigned). */
  assigneeId?: string | null
  members: readonly OwnerSelectMember[]
  canEdit: boolean
  onChange: (userId: string | null) => void
  ariaLabel?: string
  /** Extra classes for the editable trigger (e.g. full-cell padding). */
  className?: string
  /**
   * Clip rather than wrap in the READ-ONLY branch — see {@link OwnerCell}'s own `truncate`. The
   * editable branch already clips, since `SearchableSelect` renders a single-line trigger; passing
   * this makes the two branches of one column agree about row height instead of the cell growing
   * the moment the reader loses edit rights.
   */
  truncate?: boolean
}

/**
 * Owner column — single source of truth for the whole Owner cell across every
 * grid. `owner`/`user`/`team` are the "search dropdown" attribute type: when
 * editable it renders the shared {@link SearchableSelect} (search a member,
 * plain-text options, hover-to-edit); when read-only it falls back to the
 * initials-chip {@link OwnerCell}. Replaces the hand-rolled `<select>` +
 * `editingOwner` toggles previously duplicated per page.
 */
export function OwnerSelectCell({
  ownerName,
  assigneeId,
  members,
  canEdit,
  onChange,
  ariaLabel = 'Owner',
  className,
  truncate = false,
}: OwnerSelectCellProps) {
  if (!canEdit) return <OwnerCell name={ownerName} truncate={truncate} />

  return (
    <SearchableSelect
      value={assigneeId ?? ''}
      ariaLabel={ariaLabel}
      placeholder="Unassigned"
      searchPlaceholder="Search"
      className={className}
      options={ownerSelectOptions(members, assigneeId, ownerName)}
      onChange={(v) => onChange(v || null)}
    />
  )
}
