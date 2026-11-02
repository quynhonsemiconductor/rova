import { useMemo, useState } from 'react'
import { SettingsTabHeader } from './settings-tab-header'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { apiClient } from '@/shared/api/http-client'
import type { components } from '@/shared/api/generated/api'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useWorkspaceMembers } from '@/features/workspaces/api'
import { useWorkspaceTeams } from '@/features/teams/api'
import {
  describeAuditEvent,
  humanizeToken,
  type AuditNameResolver,
} from '@/entities/audit/model/describe-audit'
import {
  AUDIT_ACTION_OPTIONS,
  type AuditActionGroup,
} from '@/features/audit/model/action-filter-options'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PaginationFooter } from '@/shared/ui/pagination-footer'
import { SelectableTable, useDataTable, type ColumnSpec } from '@/shared/ui/table'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { formatWith } from '@/shared/lib/utils'
import { useSystemRoles } from '../model/use-system-roles'
import { memberSelectOption } from '@/shared/ui/owner-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { WrapBox } from '@/shared/ui/wrap-box'

const AUDIT_DEFAULT_PAGE_SIZE = 50

// Audit needs a precise "who did what, exactly when" timestamp, so — unlike the
// app-wide short `formatDateTime` — it includes the weekday and seconds, e.g.
// "Fri, Jul 31, 2026, 2:30:45 PM". Uses the `formatWith` escape hatch so it
// still resolves the user→workspace locale + timezone.
const AUDIT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
}

type AuditRow = components['schemas']['AuditLogResponseDto']
type AuditColKey = 'time' | 'actor' | 'detail'

// Per-render context: the id→name resolver `describeAuditEvent` needs, plus the
// resolved "System" fallback for actor-less (system) events.
interface AuditCtx {
  resolver: AuditNameResolver
  systemLabel: string
}

// Match the Users / Teams row look, but READ-ONLY: no cursor, no click, no gutter.
const ROW_CLASS =
  'group flex min-h-[35px] items-center gap-2 border-b border-border-subtle bg-card px-3 text-ui-md transition-colors duration-100 hover:bg-primary-lighter'

export function AuditLogTab() {
  const { t } = useTranslation('settings')
  const [pageSize, setPageSize] = useState(AUDIT_DEFAULT_PAGE_SIZE)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  /**
   * ACTOR, filtered server-side. §"Search supports Actor name and Time text" asks for exactly this,
   * and `GET /v1/audit-logs` has taken an `actorId` all along — it was simply never sent, so the only
   * way to find one person's actions was to type their name into a box that searched the 50 rows
   * already on screen. On a log of any size that reads as "this user did nothing".
   *
   * A select rather than free text because the API takes one id: a name fragment matching two people
   * cannot be expressed as `actorId`, and silently picking the first match would be worse than not
   * offering it. The member list is already loaded for the Detail column's name resolution.
   */
  const [actorId, setActorId] = useState('')
  /**
   * ACTION, filtered server-side — the half of P45-04 the free-text box below cannot do.
   *
   * What a reader wants from that box is usually a KIND of event ("who deleted a project?",
   * "show me the role changes"), and the kind is what `audit_logs.action` stores. The sentence in
   * the Detail column is not stored anywhere: it is chosen from `action` and assembled in this
   * browser by `describeAuditEvent`, so "Granted", "Revoked" and "Signed in through SSO" exist in
   * no column and no query can match them. `action` can, exactly, across the whole log — so the
   * text box keeps only the residue it alone can serve, and this select carries the rest to the
   * server.
   *
   * `GET /v1/audit-logs` has accepted `action` since the endpoint shipped; like `actorId` before
   * it, nothing ever sent it. The picker's vocabulary is mirrored in
   * `features/audit/model/action-filter-options.ts` and pinned to the backend catalogue by
   * `fe-audit-action-filter.contract.spec.ts`, so it cannot offer a code the query would not match
   * or miss one the log can hold.
   */
  const [action, setAction] = useState('')

  const workspaceId = useAppContext((s) => s.workspace?.workspaceId)
  const { data: members = [] } = useWorkspaceMembers(workspaceId)
  const { data: teams = [] } = useWorkspaceTeams(workspaceId)
  const { data: roles = [] } = useSystemRoles()

  // Server offset/limit pagination — logs are large, so the API is the source of
  // truth for the page window (never client-sliced).
  const { data, isLoading, isError } = useQuery({
    queryKey: ['audit-logs', offset, pageSize, from, to, actorId, action],
    queryFn: async () => {
      const query: {
        limit: number
        offset: number
        from?: string
        to?: string
        actorId?: string
        action?: string
      } = {
        limit: pageSize,
        offset,
      }
      if (from) query.from = `${from}T00:00:00`
      if (to) query.to = `${to}T23:59:59`
      if (actorId) query.actorId = actorId
      if (action) query.action = action
      const res = await apiClient.GET('/v1/audit-logs', { params: { query } })
      return res.data
    },
    placeholderData: (prev) => prev,
  })

  const rows = data?.data ?? []
  const hasNextPage = data?.pageInfo?.hasNextPage ?? false
  /**
   * The size of the MATCHING SET, straight from the server (`pageInfo.total`) — never derived
   * from `rows`.
   *
   * It is what makes a filter on this screen readable: "1–50 of 1,284" against "1–3 of 3" says
   * whether a filter reached the log or only the window. Left `undefined` while a request is in
   * flight or after it fails, because the footer then omits the "of N" suffix — `?? 0` would turn
   * a network fault into the measured claim "this workspace has no audit history", the same
   * mistake the Phase 6 reports made with their KPI strips.
   */
  const total = data?.pageInfo?.total
  const pageCount = total == null ? undefined : Math.max(1, Math.ceil(total / pageSize))

  const resolver = useMemo<AuditNameResolver>(() => {
    const userNames = new Map(members.map((m) => [m.userId, m.displayName || m.email]))
    const teamNames = new Map(teams.map((team) => [team.id, team.name]))
    const roleNames = new Map(roles.map((r) => [r.id, r.name]))
    return {
      user: (id) => userNames.get(id),
      team: (id) => teamNames.get(id),
      role: (id) => roleNames.get(id),
    }
  }, [members, teams, roles])

  /**
   * Only members are offerable, and that is a real limit worth naming: an audit row's actor may be a
   * user who has since been removed from the workspace, and such a row cannot be selected here. It is
   * still reachable — clear the filter and page to it — and the alternative (a distinct-actor endpoint)
   * is a bigger change than this finding.
   */
  const actorOptions = useMemo(
    () => [
      { value: '', label: t('audit.allActors') },
      // Avatars here too: the log's own rows name actors, so a filter that lists them plainly reads as
      // a different set of people.
      ...members.map((m) => memberSelectOption(m)),
    ],
    [members, t],
  )

  /**
   * Option labels are the humanised action CODE ("Project Deleted"), not new copy.
   *
   * That is the same humanisation the Detail column already falls back to for an action with no
   * template (`describeFallback` → `humanizeToken`), and the vocabulary is a machine contract
   * (`AUDIT_ACTION`) pinned by a spec — thirty-odd translated labels would fork the mirror the
   * spec exists to keep in step, and the first one to drift would be a filter naming an event the
   * log does not record. The GROUP headings are translated, since those are ours to word, and
   * `searchText` carries the raw code so typing "role." or "deleted" narrows the list.
   *
   * The cost, accepted knowingly: five sign-in codes read as their machine name ("Auth Login Sso")
   * rather than as the sentence the row shows ("Signed in through SSO"). Re-wording them here would
   * put a second opinion about how an event is phrased next to `describeAuditEvent`'s, and a filter
   * whose label disagrees with the rows it returns is worse than one that is plainly the event's
   * identifier. The "Sign-in" group heading carries the meaning instead.
   */
  const actionGroupLabels = useMemo<Record<AuditActionGroup, string>>(
    () => ({
      auth: t('audit.actionGroups.auth'),
      users: t('audit.actionGroups.users'),
      projects: t('audit.actionGroups.projects'),
      teams: t('audit.actionGroups.teams'),
      workspace: t('audit.actionGroups.workspace'),
    }),
    [t],
  )

  const actionOptions = useMemo(
    () => [
      { value: '', label: t('audit.allActions') },
      ...AUDIT_ACTION_OPTIONS.map((o) => ({
        value: o.code,
        label: humanizeToken(o.code),
        searchText: `${humanizeToken(o.code)} ${o.code}`,
        group: actionGroupLabels[o.group],
      })),
    ],
    [t, actionGroupLabels],
  )

  const systemLabel = t('audit.system')
  const cellCtx = useMemo<AuditCtx>(() => ({ resolver, systemLabel }), [resolver, systemLabel])

  /**
   * Free text still refines the CURRENT server page only, and says so twice: in its own
   * placeholder (`audit.searchPlaceholderPage`) and — where it would otherwise mislead — in the
   * empty state it produces, which names the term and the number of rows it looked at.
   *
   * A filter that silently searches one page is the P45-04 defect; one that states its scope at
   * the moment it finds nothing is a documented limitation. The moment matters: "no match" over 50
   * of 1,284 rows reads exactly like "this never happened".
   *
   * Kept rather than removed because it is the only way to search the Detail sentence, which is
   * assembled client-side from `action` + `changes` + resolved names and therefore cannot be a
   * server predicate at all — that would need the sentence to become a stored, indexed column
   * written at projection time, which is a schema change, not a query change. The parts that CAN
   * be answered across the whole log are the two selects and the date range above: Actor (§3.7
   * "search audit rows by actor name"), Action, and the window (§3.7 "search audit rows by time
   * text").
   */
  const q = search.trim().toLowerCase()
  const actorLabel = (a: AuditRow): string => a.actorName ?? a.actorEmail ?? systemLabel
  const filtered = q
    ? rows.filter(
        (a) =>
          actorLabel(a).toLowerCase().includes(q) ||
          describeAuditEvent(a, resolver).toLowerCase().includes(q),
      )
    : rows

  /**
   * Shared table engine (resize / reorder / Show-Fields). Still no `sortCol` on any column and no
   * `sort` passed — the header is deliberately static.
   *
   * The original reason (a click would reorder one page, which is misleading) is the right reason,
   * and it has not changed: `GET /v1/audit-logs` takes no `sort`, so the order is fixed at newest
   * first with `id` as the tiebreaker (`AuditDrizzleRepository.listForWorkspace`). Enabling
   * click-sort therefore needs the SERVER to take a sort field first; a header that sorts 50 of
   * 1,284 rows would be the same defect as a search box that searches them. Two of the three
   * columns could never be server-sorted anyway: Detail is not a column, and Actor is a
   * `coalesce` over a joined name and a stored email.
   */
  const columns = useMemo<ColumnSpec<AuditRow, AuditCtx, AuditColKey>[]>(
    () => [
      {
        key: 'time',
        label: t('audit.colTime'),
        defaultWidth: 264,
        minWidth: 210,
        locked: true,
        cellClassName: 'flex items-center',
        cell: (r) => (
          <span className="truncate text-ui-md text-foreground-subtle">
            {formatWith(r.occurredAt, AUDIT_TIME_FORMAT)}
          </span>
        ),
      },
      {
        key: 'actor',
        label: t('audit.colActor'),
        defaultWidth: 200,
        minWidth: 140,
        cellClassName: 'flex min-w-0 items-center',
        cell: (r, ctx) => (
          <span
            className="text-ui-md break-words whitespace-normal text-foreground"
            title={r.actorEmail ?? r.actorId ?? undefined}
          >
            {r.actorName ?? r.actorEmail ?? ctx.systemLabel}
          </span>
        ),
      },
      {
        key: 'detail',
        label: t('audit.colDetail'),
        defaultWidth: 420,
        minWidth: 220,
        grow: true,
        cellClassName: 'flex min-w-0 items-center',
        // A `grow` column of wrapping text in a `max-content` row: `WrapBox`, or a long event widens
        // the row and pushes the columns after it off-screen.
        cell: (r, ctx) => (
          <WrapBox>
            <span
              className="text-ui-md break-words whitespace-normal text-foreground"
              title={`${r.action} · ${r.resourceType} · ${r.resourceId}`}
            >
              {describeAuditEvent(r, ctx.resolver)}
            </span>
          </WrapBox>
        ),
      },
    ],
    [t],
  )

  const table = useDataTable<AuditRow, AuditCtx, AuditColKey>(columns, {
    storageKey: STORAGE_KEYS.SETTINGS_AUDIT_COLUMNS,
  })

  // Counts only the SERVER-side filters, deliberately: the badge tells the reader how much of the
  // whole log this page is a window onto, and the page-local text box narrows the window itself.
  const activeFilterCount = (from ? 1 : 0) + (to ? 1 : 0) + (actorId ? 1 : 0) + (action ? 1 : 0)

  if (!workspaceId) {
    return <p className="text-ui-lg text-foreground-subtle">{t('members.noWorkspace')}</p>
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-foreground-subtle">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-ui-lg">{t('audit.loading')}</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SettingsTabHeader title={t('nav.audit')} description={t('tabDescriptions.audit')} />

      {/* ── Toolbar — page filter · actor / action / date range filters · Show Fields ── */}
      <PageToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t('audit.searchPlaceholderPage'),
          ariaLabel: t('audit.searchPlaceholderPage'),
          width: 256,
        }}
        activeFilterCount={activeFilterCount}
        defaultFiltersOpen={!!(from || to || actorId || action)}
        filters={
          <>
            <SearchableSelect
              variant="field"
              value={actorId}
              ariaLabel={t('audit.actorFilter')}
              placeholder={t('audit.allActors')}
              options={actorOptions}
              onChange={(v) => {
                setActorId(v)
                setOffset(0)
              }}
            />
            <SearchableSelect
              variant="field"
              value={action}
              ariaLabel={t('audit.actionFilter')}
              placeholder={t('audit.allActions')}
              options={actionOptions}
              onChange={(v) => {
                setAction(v)
                setOffset(0)
              }}
            />
            <Input
              type="date"
              value={from}
              max={to || undefined}
              aria-label={t('audit.fromDate')}
              className="w-40"
              onChange={(e) => {
                setFrom(e.target.value)
                setOffset(0)
              }}
            />
            <Input
              type="date"
              value={to}
              min={from || undefined}
              aria-label={t('audit.toDate')}
              className="w-40"
              onChange={(e) => {
                setTo(e.target.value)
                setOffset(0)
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFrom('')
                setTo('')
                setActorId('')
                setAction('')
                setOffset(0)
              }}
            >
              {t('audit.clear')}
            </Button>
          </>
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      />

      {/* ── Table — read-only (no selection gutter / bulk bar) ── */}
      <SelectableTable
        rows={filtered}
        selectable={false}
        headerProps={table.headerProps}
        padClassName="gap-2 px-3"
        error={
          isError ? (
            <div className="flex flex-1 items-center justify-center px-3 py-10 text-ui-sm text-destructive">
              {t('audit.loadError')}
            </div>
          ) : undefined
        }
        empty={
          filtered.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-3 py-10 text-center text-ui-sm text-foreground-subtle">
              {/*
                Three different absences, and saying "No audit events found" for all three is what
                let a page-local search read as a fact about the log:
                  • the server returned rows and the text box hid them → name the term, the number
                    of rows it looked at, and where the whole-log filters are;
                  • the server matched nothing WITH filters set → the workspace has none, which the
                    footer's total agrees with;
                  • no filters, no rows → the log is empty.
              */}
              {rows.length > 0
                ? t('audit.pageFilterNoMatch', { term: search.trim(), rows: rows.length })
                : activeFilterCount > 0
                  ? t('audit.emptyFiltered')
                  : t('audit.empty')}
            </div>
          ) : undefined
        }
        footer={
          rows.length > 0 ? (
            <PaginationFooter
              pageSize={pageSize}
              setPageSize={(n) => {
                setPageSize(n)
                setOffset(0)
              }}
              currentPage={Math.floor(offset / pageSize) + 1}
              rangeStart={rows.length === 0 ? 0 : offset + 1}
              rangeEnd={offset + rows.length}
              total={total}
              pageCount={pageCount}
              hasPrevPage={offset > 0}
              hasNextPage={hasNextPage}
              onPrevPage={() => setOffset((o) => Math.max(0, o - pageSize))}
              onNextPage={() => setOffset((o) => o + pageSize)}
            />
          ) : undefined
        }
        renderRow={(r) => (
          <div key={r.id} className={ROW_CLASS} style={{ minWidth: 'max-content' }}>
            {table.renderCells(r, cellCtx)}
          </div>
        )}
      />
    </div>
  )
}
