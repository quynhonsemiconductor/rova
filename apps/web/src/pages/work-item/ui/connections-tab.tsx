/**
 * Connections tab — SCM Pull Requests + Changesets linked to a work item
 * (Rally's "Connections" screen), with two sub-tabs.
 *
 * Both sub-tabs reuse the SAME shared table engine as the work-item / read-list
 * grids — `useDataTable` (column resize / reorder / Show-Fields) rendered through
 * `ListPageScaffold` (PageToolbar search + Show Filters + Show Fields, client
 * pagination + shared PaginationFooter). No bespoke table/footer. Lists are
 * small per work item, so we fetch one generous page and filter client-side.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitCommitHorizontal, GitPullRequest } from 'lucide-react'

import {
  useWorkItemConnections,
  useWorkItemChangesets,
  type ScmConnection,
  type ScmChangeset,
} from '@/features/work-items/api'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/shared/ui/tabs'
import { useDataTable, type ColumnSpec } from '@/shared/ui/table'
import { ListPageScaffold } from '@/shared/ui/list-page/list-page-scaffold'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { InlineSelect } from '@/shared/ui/native-select'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { formatWith } from '@/shared/lib/utils'
import { listResource } from '@/shared/lib/query/resource'
import { LoadErrorState } from '@/shared/ui/load-error-state'

// ── Shared cell helpers ───────────────────────────────────────────────────────

type ScmCtx = Record<string, never>
const EMPTY_CTX: ScmCtx = {}

function fmtDate(iso: string | null | undefined): string {
  return formatWith(iso, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const CONNECTION_TYPE_LABEL: Record<string, string> = {
  pull_request: 'Pull Request',
  build: 'Build',
  branch: 'Branch',
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      // `break-all`, not `break-words`: a URL or a file path has no spaces, so the normal
      // word-breaking rules find nowhere to break and the text would overflow instead of
      // wrapping. Breaking mid-token is the only way to show the whole value, and the tail
      // (the filename, the query) is usually the part worth reading.
      className="break-all text-primary hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}

// ── Column definitions (config-driven, rendered by table.renderCells) ─────────

type ConnColKey = 'name' | 'type' | 'url' | 'createdAt'
const CONNECTION_COLUMNS: ColumnSpec<ScmConnection, ScmCtx, ConnColKey>[] = [
  {
    key: 'name',
    label: 'Name',
    sortCol: 'name',
    defaultWidth: 320,
    minWidth: 160,
    locked: true,
    grow: true,
    cellClassName: 'flex min-w-0 items-center px-2',
    // Name is plain text; the Url column carries the link (matches Rally).
    cell: (c) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="break-words whitespace-normal text-foreground" title={c.name}>
          {c.name}
        </span>
        {c.state ? <span className="text-ui-xs text-foreground-subtle">({c.state})</span> : null}
      </span>
    ),
  },
  {
    key: 'type',
    label: 'Type',
    sortCol: 'type',
    defaultWidth: 130,
    minWidth: 90,
    cellClassName: 'flex items-center px-2',
    accessor: (c) => CONNECTION_TYPE_LABEL[c.type] ?? c.type,
    type: 'text',
  },
  {
    key: 'url',
    label: 'Url',
    defaultWidth: 300,
    minWidth: 140,
    cellClassName: 'flex min-w-0 items-center px-2',
    cell: (c) => <ExtLink href={c.url}>{c.url}</ExtLink>,
  },
  {
    key: 'createdAt',
    label: 'Creation Date',
    sortCol: 'createdAt',
    defaultWidth: 190,
    minWidth: 120,
    cellClassName: 'flex items-center px-2 text-muted-foreground',
    cell: (c) => <span className="whitespace-nowrap">{fmtDate(c.createdAt)}</span>,
  },
]

type ChangeColKey = 'name' | 'message' | 'changes' | 'author' | 'committedAt' | 'uri'
const CHANGESET_COLUMNS: ColumnSpec<ScmChangeset, ScmCtx, ChangeColKey>[] = [
  {
    key: 'name',
    label: 'Name',
    sortCol: 'name',
    defaultWidth: 240,
    minWidth: 120,
    locked: true,
    // `items-start` so a wrapped identifier stays aligned with the top of its row.
    cellClassName: 'flex min-w-0 items-start px-2',
    cell: (c) => (
      <span className="block font-mono break-all" title={c.name}>
        {c.uri ? <ExtLink href={c.uri}>{c.name}</ExtLink> : c.name}
      </span>
    ),
  },
  {
    key: 'message',
    label: 'Message',
    sortCol: 'message',
    defaultWidth: 360,
    minWidth: 160,
    grow: true,
    // `items-start`: a message that wraps reads from the top of the row, level with Name.
    cellClassName: 'flex min-w-0 items-start px-2 py-1',
    cell: (c) => (
      <WrapBox>
        <span
          // `break-words` breaks at spaces first and only splits an unbroken token (a long hash or
          // path inside the message) when it alone is wider than the column. `whitespace-pre-line`
          // keeps the commit body's own line breaks instead of collapsing it into one run.
          className="block break-words whitespace-pre-line"
          title={c.message ?? ''}
        >
          {c.message ?? '--'}
        </span>
      </WrapBox>
    ),
  },
  {
    key: 'changes',
    label: 'Changes',
    defaultWidth: 300,
    minWidth: 140,
    // One link per changed file (each opens the commit). Stacked, matching Rally.
    cellClassName: 'flex min-w-0 items-start px-2 py-1',
    cell: (c) =>
      c.changes.length === 0 ? (
        <span className="text-muted-foreground">--</span>
      ) : (
        <WrapBox className="flex flex-col gap-0.5">
          {c.changes.map((x) => (
            <span
              key={x.path}
              // `break-all`: a path has no spaces, so it can only wrap mid-token.
              className="block font-mono text-ui-xs break-all"
              title={`${x.action} ${x.path}`}
            >
              {/* `inline-block` + margin, so the action letter never fuses onto the path when the
                  text is copied ("Mapps/web/…"). */}
              <span className="mr-1.5 inline-block text-foreground-subtle">{x.action}</span>
              {c.uri ? <ExtLink href={c.uri}>{x.path}</ExtLink> : x.path}
            </span>
          ))}
        </WrapBox>
      ),
  },
  {
    key: 'author',
    label: 'Author',
    sortCol: 'author',
    defaultWidth: 160,
    minWidth: 100,
    cellClassName: 'flex items-center px-2',
    accessor: (c) => c.authorName ?? '--',
    type: 'text',
  },
  {
    key: 'committedAt',
    label: 'Commit Timestamp',
    sortCol: 'committedAt',
    defaultWidth: 190,
    minWidth: 120,
    cellClassName: 'flex items-center px-2 text-muted-foreground',
    cell: (c) => <span className="whitespace-nowrap">{fmtDate(c.committedAt)}</span>,
  },
  {
    key: 'uri',
    label: 'Uri',
    defaultWidth: 280,
    minWidth: 140,
    cellClassName: 'flex min-w-0 items-center px-2',
    cell: (c) => (c.uri ? <ExtLink href={c.uri}>{c.uri}</ExtLink> : <span>--</span>),
  },
]

const ROW_CLASS =
  'flex min-h-[35px] items-center gap-2 border-b border-border-inner px-3 text-ui-md transition-colors hover:bg-primary-lighter'

/**
 * Wraps free text inside a cell WITHOUT letting it size the row.
 *
 * Each row is `minWidth: max-content`, so a cell's max-content width becomes a floor on the row.
 * For Message — a `grow` column, which by design has no width ceiling — that floor was the whole
 * commit message on ONE line: the row widened to fit it, the text never wrapped, and the cell grew
 * past its header so Changes / Author / Commit Timestamp were pushed off to the right (Production,
 * 2026-10-06, the US-120 Changesets tab).
 *
 * `w-0` makes the content contribute nothing to that max-content measurement; `min-w-full` then
 * stretches it back to the cell's real width once the row is laid out, so it wraps inside the column
 * exactly as wide as its header.
 */
function WrapBox({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={`w-0 min-w-full ${className ?? ''}`}>{children}</div>
}

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase())
}

/** Click-to-sort state for the shared header (same contract as the list pages). */
function useColumnSort() {
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const onSort = useCallback(
    (col: string) => {
      if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      else {
        setSortCol(col)
        setSortDir('asc')
      }
    },
    [sortCol],
  )
  return { sortCol, sortDir, sort: { col: sortCol, dir: sortDir, onSort } }
}

/** Client-side sort over the (small, fully-loaded) linked list. */
function sortRows<T>(
  rows: T[],
  sortCol: string | null,
  sortDir: 'asc' | 'desc',
  keyOf: (row: T, col: string) => string | number,
): T[] {
  if (!sortCol) return rows
  const dir = sortDir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = keyOf(a, sortCol)
    const bv = keyOf(b, sortCol)
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return 0
  })
}

// ── Connections (Pull Requests) sub-tab ──────────────────────────────────────

function ConnectionsSubTab({ workItemId }: { workItemId: string }) {
  const { t } = useTranslation('work-items')
  const connectionsQuery = useWorkItemConnections(workItemId)
  // A resource: `data?.data ?? []` printed `connections.empty` for a failed read, i.e. "this item has
  // no linked repositories" about a request that never landed. `ListPageScaffold` has had an `error`
  // slot all along — this tab simply never filled it.
  const feed = listResource({ ...connectionsQuery, data: connectionsQuery.data?.data })
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | ScmConnection['type']>('all')
  const { sortCol, sortDir, sort } = useColumnSort()
  const table = useDataTable<ScmConnection, ScmCtx, ConnColKey>(CONNECTION_COLUMNS, {
    storageKey: STORAGE_KEYS.SCM_CONNECTIONS_COLUMNS,
  })

  const filtered = useMemo(() => {
    const rows = feed.rows
    return rows.filter(
      (c) =>
        (typeFilter === 'all' || c.type === typeFilter) &&
        (search.trim() === '' || includesCI(`${c.name} ${c.url}`, search)),
    )
  }, [feed.rows, search, typeFilter])

  const sorted = useMemo(
    () =>
      sortRows(filtered, sortCol, sortDir, (c, col) => {
        switch (col) {
          case 'name':
            return c.name.toLowerCase()
          case 'type':
            return CONNECTION_TYPE_LABEL[c.type] ?? c.type
          case 'createdAt':
            return c.createdAt ?? ''
          default:
            return ''
        }
      }),
    [filtered, sortCol, sortDir],
  )

  return (
    <ListPageScaffold<ScmConnection, ConnColKey>
      selectable={false}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: t('connections.search'),
        width: 220,
      }}
      activeFilterCount={typeFilter === 'all' ? 0 : 1}
      filters={
        <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
          {t('connections.type')}
          <InlineSelect
            value={typeFilter}
            aria-label={t('connections.type')}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="w-auto"
          >
            <option value="all">{t('connections.allTypes')}</option>
            <option value="pull_request">{t('connections.types.pull_request')}</option>
            <option value="build">{t('connections.types.build')}</option>
            <option value="branch">{t('connections.types.branch')}</option>
          </InlineSelect>
        </label>
      }
      fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      headerProps={table.headerProps}
      headerColumns={table.headerColumns}
      colStyles={table.colStyles}
      sort={sort}
      padClassName="gap-2 px-3"
      items={sorted}
      loading={feed.isLoading}
      skeleton={{ rows: 6 }}
      error={feed.phase === 'error' ? <LoadErrorState error={feed.error} size="sm" /> : undefined}
      empty={
        feed.phase !== 'error' && sorted.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-3 py-10 text-center text-ui-sm text-foreground-subtle">
            {t('connections.empty')}
          </div>
        ) : undefined
      }
      renderRow={(c) => (
        <div key={c.id} className={ROW_CLASS} style={{ minWidth: 'max-content' }}>
          {table.renderCells(c, EMPTY_CTX)}
        </div>
      )}
    />
  )
}

// ── Changesets (commits) sub-tab ─────────────────────────────────────────────

function ChangesetsSubTab({ workItemId }: { workItemId: string }) {
  const { t } = useTranslation('work-items')
  const changesetsQuery = useWorkItemChangesets(workItemId)
  // Same shape as the connections list above: a 403/500 must not read as "no commits".
  const feed = listResource({ ...changesetsQuery, data: changesetsQuery.data?.data })
  const [search, setSearch] = useState('')
  const [authorFilter, setAuthorFilter] = useState('all')
  const { sortCol, sortDir, sort } = useColumnSort()
  const table = useDataTable<ScmChangeset, ScmCtx, ChangeColKey>(CHANGESET_COLUMNS, {
    storageKey: STORAGE_KEYS.SCM_CHANGESETS_COLUMNS,
  })

  const rows = feed.rows
  // Distinct authors present on this item's commits — the changeset filter facet.
  const authors = useMemo(
    () => [...new Set(rows.map((c) => c.authorName).filter((a): a is string => !!a))].sort(),
    [rows],
  )

  const filtered = useMemo(
    () =>
      rows.filter(
        (c) =>
          (authorFilter === 'all' || c.authorName === authorFilter) &&
          (search.trim() === '' ||
            includesCI(`${c.name} ${c.message ?? ''} ${c.authorName ?? ''}`, search)),
      ),
    [rows, search, authorFilter],
  )

  const sorted = useMemo(
    () =>
      sortRows(filtered, sortCol, sortDir, (c, col) => {
        switch (col) {
          case 'name':
            return c.name.toLowerCase()
          case 'message':
            return (c.message ?? '').toLowerCase()
          case 'author':
            return (c.authorName ?? '').toLowerCase()
          case 'committedAt':
            return c.committedAt ?? ''
          default:
            return ''
        }
      }),
    [filtered, sortCol, sortDir],
  )

  return (
    <ListPageScaffold<ScmChangeset, ChangeColKey>
      selectable={false}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: t('connections.searchChangesets'),
        width: 220,
      }}
      activeFilterCount={authorFilter === 'all' ? 0 : 1}
      filters={
        <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
          {t('connections.author')}
          <InlineSelect
            value={authorFilter}
            aria-label={t('connections.author')}
            onChange={(e) => setAuthorFilter(e.target.value)}
            className="w-auto"
          >
            <option value="all">{t('connections.allAuthors')}</option>
            {authors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </InlineSelect>
        </label>
      }
      fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      headerProps={table.headerProps}
      headerColumns={table.headerColumns}
      colStyles={table.colStyles}
      sort={sort}
      padClassName="gap-2 px-3"
      items={sorted}
      loading={feed.isLoading}
      skeleton={{ rows: 6 }}
      error={feed.phase === 'error' ? <LoadErrorState error={feed.error} size="sm" /> : undefined}
      empty={
        feed.phase !== 'error' && sorted.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-3 py-10 text-center text-ui-sm text-foreground-subtle">
            {t('connections.emptyChangesets')}
          </div>
        ) : undefined
      }
      renderRow={(c) => (
        <div key={c.id} className={ROW_CLASS} style={{ minWidth: 'max-content' }}>
          {table.renderCells(c, EMPTY_CTX)}
        </div>
      )}
    />
  )
}

// ── Tab entry ─────────────────────────────────────────────────────────────────

export function ConnectionsTab({ workItemId }: { workItemId: string }) {
  const [tab, setTab] = useState<'connections' | 'changesets'>('connections')
  const { data: conns } = useWorkItemConnections(workItemId)
  const { data: changes } = useWorkItemChangesets(workItemId)

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as typeof tab)}
      className="flex flex-1 flex-col overflow-hidden"
    >
      <TabsList className="shrink-0 px-4">
        <TabsTrigger value="connections" icon={<GitPullRequest size={13} />} count={conns?.total}>
          Connections
        </TabsTrigger>
        <TabsTrigger
          value="changesets"
          icon={<GitCommitHorizontal size={13} />}
          count={changes?.total}
        >
          Changesets
        </TabsTrigger>
      </TabsList>
      <TabsContent value="connections" className="flex flex-1 flex-col overflow-hidden">
        <ConnectionsSubTab workItemId={workItemId} />
      </TabsContent>
      <TabsContent value="changesets" className="flex flex-1 flex-col overflow-hidden">
        <ChangesetsSubTab workItemId={workItemId} />
      </TabsContent>
    </Tabs>
  )
}
