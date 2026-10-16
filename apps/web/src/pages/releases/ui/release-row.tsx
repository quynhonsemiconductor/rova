import { TableRow } from '@/shared/ui/table'
import { type CSSProperties, type ReactNode } from 'react'
import { ProjectCell } from '@/shared/ui/project-cell'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'

import { useUpdateRelease, type Release, type ReleaseStatus } from '@/features/releases/api'
import { notify } from '@/shared/lib/toast'
import { stripHtml } from '@/shared/lib/utils'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { DateField } from '@/shared/ui/date-field'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { type ColKey } from '../model/columns'
import { RELEASE_STATES, RELEASE_STATUS_STYLE } from '../model/release-states'
import { entityDetailPath } from '@/shared/lib/entity-link'

// ── Inline editable row ───────────────────────────────────────────────────

export function ReleaseRow({
  release,
  canManage,
  colStyleFor,
  gutter,
}: {
  release: Release
  canManage: boolean
  colStyleFor: (key: ColKey, base?: CSSProperties) => CSSProperties
  /** Selection gutter node supplied by the list scaffold. */
  gutter: ReactNode
}) {
  const { t } = useTranslation('releases')
  const { project } = useAppContext()
  const update = useUpdateRelease(release.id)
  const status = release.status as ReleaseStatus

  function saveName(raw: string) {
    const val = raw.trim()
    if (!val || val === release.name) return
    update.mutate(
      { name: val },
      {
        onSuccess: () => notify.success(t('row.nameUpdated')),
        onError: (err) => notify.error(err.message),
      },
    )
  }

  function saveState(newState: ReleaseStatus) {
    if (newState === status) return
    update.mutate(
      { state: newState },
      {
        onSuccess: () =>
          notify.success(t('row.statusUpdated', { label: RELEASE_STATUS_STYLE[newState].label })),
        onError: (err) => notify.error(err.message),
      },
    )
  }

  function saveTheme(raw: string) {
    const val = raw.trim()
    if (val !== stripHtml(release.theme)) {
      update.mutate(
        { theme: val || undefined },
        {
          onSuccess: () => notify.success(t('row.themeUpdated')),
          onError: (err) => notify.error(err.message),
        },
      )
    }
  }

  function saveVersion(raw: string) {
    const val = raw.trim()
    if (val !== (release.version ?? '')) {
      update.mutate(
        { version: val || undefined },
        {
          onSuccess: () => notify.success(t('row.versionUpdated')),
          onError: (err) => notify.error(err.message),
        },
      )
    }
  }

  function saveVelocity(raw: string) {
    const val = raw.trim()
    const num = val === '' ? null : Number(val)
    if (num !== null && (isNaN(num) || num < 0)) {
      notify.error(t('row.velocityInvalid'))
      return
    }
    if (num !== release.plannedVelocity) {
      update.mutate(
        { plannedVelocity: num ?? undefined },
        {
          onSuccess: () => notify.success(t('row.velocityUpdated')),
          onError: (err) => notify.error(err.message),
        },
      )
    }
  }

  function saveStartDate(val: string | null) {
    update.mutate(
      { startDate: val },
      {
        onSuccess: () => notify.success(t('row.startDateUpdated')),
        onError: (err) => notify.error(err.message),
      },
    )
  }

  function saveReleaseDate(val: string | null) {
    update.mutate(
      { releaseDate: val },
      {
        onSuccess: () => notify.success(t('row.releaseDateUpdated')),
        onError: (err) => notify.error(err.message),
      },
    )
  }

  const navigate = useNavigate()

  function openDetail() {
    void navigate({ to: '/releases/$releaseId', params: { releaseId: release.id } })
  }

  return (
    <TableRow className="px-3">
      {gutter}

      {/* ID — type glyph + per-project key (RE-<n>), matching US/DE */}
      <div
        style={colStyleFor('id', { flexShrink: 0 })}
        className="flex items-center px-2"
        onClick={(e) => e.stopPropagation()}
      >
        <IdCell
          type="release"
          itemKey={release.releaseKey ?? '--'}
          onOpen={openDetail}
          href={entityDetailPath.release(release.id)}
        />
      </div>

      {/* Name — inline-editable (the ID cell is the click-to-open link),
          matching Iteration Status. */}
      <div
        style={colStyleFor('name', { flexShrink: 0 })}
        className="min-w-0 px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={release.name}
          canEdit={canManage}
          onCommit={saveName}
          ariaLabel="Name"
          title={release.name}
          className="block w-full break-words whitespace-normal text-foreground"
          style={{ fontSize: 12 }}
          inputClassName="w-full rounded border border-primary bg-transparent px-1 py-0.5 text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Theme — shared InlineEditableCell */}
      <div
        style={colStyleFor('theme', { flexShrink: 0 })}
        className="min-w-0 px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={stripHtml(release.theme)}
          canEdit={canManage}
          onCommit={saveTheme}
          ariaLabel="Theme"
          displayValue={
            <span className="block break-words whitespace-normal text-muted-foreground">
              {stripHtml(release.theme) || '--'}
            </span>
          }
          inputClassName="w-full rounded border-0 bg-transparent px-0.5 text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Version — shared InlineEditableCell */}
      <div
        style={colStyleFor('version', { flexShrink: 0 })}
        className="min-w-0 px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={release.version ?? ''}
          canEdit={canManage}
          onCommit={saveVersion}
          ariaLabel="Version"
          displayValue={
            <span className="block break-all text-muted-foreground">{release.version || '--'}</span>
          }
          inputClassName="w-full rounded border-0 bg-transparent px-0.5 text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Start Date — shared DateField */}
      <div
        style={colStyleFor('startDate', { flexShrink: 0 })}
        className="px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <DateField
          value={release.startDate}
          readOnly={!canManage}
          ariaLabel="Start date"
          onChange={canManage ? saveStartDate : undefined}
        />
      </div>

      {/* Release Date — shared DateField */}
      <div
        style={colStyleFor('releaseDate', { flexShrink: 0 })}
        className="px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <DateField
          value={release.releaseDate}
          readOnly={!canManage}
          ariaLabel="Release date"
          onChange={canManage ? saveReleaseDate : undefined}
        />
      </div>

      {/* Project — read-only (the list is scoped to the active project) */}
      <div
        style={colStyleFor('project', { flexShrink: 0 })}
        className="min-w-0 px-2"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="block break-words whitespace-normal text-muted-foreground">
          <ProjectCell projectKey={project?.projectKey} projectName={project?.projectName} />
        </span>
      </div>

      {/* Planned Velocity — shared InlineEditableCell */}
      <div
        style={colStyleFor('plannedVelocity', { flexShrink: 0 })}
        className="px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineEditableCell
          fullCell
          value={release.plannedVelocity != null ? String(release.plannedVelocity) : ''}
          canEdit={canManage}
          onCommit={saveVelocity}
          ariaLabel="Planned velocity"
          displayValue={
            <span className="block text-right font-mono text-muted-foreground tabular-nums">
              {release.plannedVelocity ?? '--'}
            </span>
          }
          inputClassName="w-full rounded border-0 bg-transparent px-0.5 text-right font-mono text-inherit text-foreground focus:outline-none"
        />
      </div>

      {/* Task Estimate — read-only roll-up of assigned work-item estimate hours (P3-REL-FR-004) */}
      <div
        style={colStyleFor('taskEstimate', { flexShrink: 0 })}
        className="pr-2 text-right font-mono text-muted-foreground tabular-nums"
        onClick={(e) => e.stopPropagation()}
      >
        <span>{release.taskEstimate ?? 0}</span>
      </div>

      {/* State (P3-REL-FR-008) — shared SearchableSelect */}
      <div
        style={colStyleFor('state', { flexShrink: 0 })}
        className="px-0"
        onClick={(e) => e.stopPropagation()}
      >
        <SearchableSelect
          value={status}
          readOnly={!canManage}
          ariaLabel="Release state"
          options={RELEASE_STATES.map((s) => ({
            value: s,
            label: RELEASE_STATUS_STYLE[s].label,
          }))}
          onChange={(v) => saveState(v as ReleaseStatus)}
        />
      </div>
    </TableRow>
  )
}
