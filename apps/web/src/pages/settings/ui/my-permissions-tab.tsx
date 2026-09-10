/**
 * Settings > My Permissions — shows the current user's effective access.
 *
 * Available to EVERY authenticated reader (`requires: null`), at every level: Phase 4
 * `03_Settings_Audit/SRS.md:53` gives all four principals a row — "View all effective access" for a
 * Workspace Admin, "View own assigned Projects" for an Admin, "View own assigned Projects/Teams" for
 * an Editor and "View own access or no-access state" for No Access.
 *
 * THE DEFECT THIS FILE CARRIED
 * ----------------------------
 * Every row read `useProjectMembers` — `GET /projects/:id/members`, the ADMINISTRATIVE roster, which
 * `ProjectsService.listProjectMembers` refuses for any level but `admin` (§3.1:71 hides it from an
 * Editor). A refused READ is silent by design (`http-client.ts`: a 403 belongs to the surface that
 * asked), and `const { data: members = [] }` turns it into "you are in no project" — so an Editor's
 * own access screen reported `No Access` for every project they are an Editor of. The screen that
 * exists to explain a reader's access was the one screen denying it to them.
 *
 * It now reads the SELF-SCOPED feed instead (`useProjectPermissionsFor` →
 * `GET /projects/:id/my-permissions`, `@SelfScoped`) and derives the level from it — see
 * `../model/effective-access.ts` for the derivation and what would let it be deleted. An unresolved
 * or failed read renders `EMPTY_VALUE`, never `No Access`: absent is not a level, and this is the one
 * screen where guessing it is a claim about the reader.
 */
import { Loader2 } from 'lucide-react'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects/api'
import { useProjectPermissionsFor } from '@/features/access/api'
import { PERMISSION } from '@/shared/config/permissions'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { SettingsTabHeader } from './settings-tab-header'
import { StatusBadge } from '@/shared/ui/status-badge'
import { Card, CardBody, CardHeader } from '@/shared/ui/card'
import {
  PanelTable,
  PanelTableCell,
  PanelTableRow,
  type PanelTableColumn,
} from '@/shared/ui/table/panel-table'
import { BRAND } from '@/shared/config/brand'
import { effectiveProjectLevel, projectLevelLabel } from '../model/effective-access'

export function MyPermissionsTab() {
  const workspaceId = useAppContext((s) => s.workspace?.workspaceId)
  const { hasPermission, user } = useAuthStore()
  const isWA = hasPermission(PERMISSION.WORKSPACE_ALL)

  return (
    <>
      <SettingsTabHeader
        contained
        title="My Permissions"
        description="Your effective access across this workspace."
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Workspace authority */}
          <Card>
            <CardHeader title="Workspace Authority" />
            <CardBody>
              {isWA ? (
                <p className="text-ui-md text-foreground">
                  You are a <strong>Workspace Admin</strong> with full company authority. You can
                  manage all users, Projects, Teams, and Project access.
                </p>
              ) : (
                <p className="text-ui-md text-foreground-subtle">
                  You are a company member. Your Project access is managed per-Project by the
                  Workspace Admin.
                </p>
              )}
              {user?.displayName && (
                <p className="mt-1 text-ui-xs text-foreground-subtle">{user.displayName}</p>
              )}
            </CardBody>
          </Card>

          {/* Per-Project access */}
          {!isWA && <ProjectAccessSummary workspaceId={workspaceId ?? ''} />}

          {/* Quick capability reference */}
          <Card>
            <CardHeader title="Access Level Reference" />
            <CardBody className="space-y-2">
              {CAPABILITY_ROWS.map((row) => (
                <div key={row.level} className="flex items-center gap-3 text-ui-sm">
                  <StatusBadge
                    style={{
                      label: row.level,
                      text: row.color,
                      bg: row.bg,
                      border: row.border,
                    }}
                  />
                  <span className="text-foreground-subtle">{row.desc}</span>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}

/**
 * The reader's own level in each project they can see, from the self-scoped permission feed.
 *
 * `useProjects` is already narrowed server-side by `AccessService.listReadableProjectIds`, so a No
 * Access project never reaches this list — §3:53's "no-access state" for a reader with none is the
 * empty state below, not a row per project saying so.
 *
 * `useProjectPermissionsFor` is the cross-project form of the same read the whole SPA gates on, so
 * every project already resolved (the selected one, always, because `settings-page.tsx` reads it)
 * costs no extra request. Its `can` falls back to the WORKSPACE baseline while a project is in
 * flight, which for a non-admin holds nothing — so the level is only derived once `isLoading` is
 * false. Deriving through the fallback would print `No Access` for a moment on every load, which is
 * the same false claim this screen was fixed to stop making.
 */
function ProjectAccessSummary({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation('settings')
  const { data: projects = [], isLoading } = useProjects(workspaceId)
  const { can, isLoading: levelsLoading } = useProjectPermissionsFor(projects.map((p) => p.id))

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-ui-md text-foreground-subtle">
        <Loader2 size={14} className="animate-spin" /> Loading your Projects…
      </div>
    )
  }

  return (
    <Card>
      <PanelTable columns={ACCESS_COLUMNS}>
        {projects.length === 0 ? (
          <p className="px-4 py-6 text-center text-ui-md text-foreground-subtle">
            No Projects available.
          </p>
        ) : (
          projects.map((p) => {
            const level = levelsLoading ? undefined : effectiveProjectLevel((c) => can(p.id, c))
            return (
              <PanelTableRow key={p.id} className="min-h-0 py-2 last:border-b-0">
                <PanelTableCell column={ACCESS_COLUMNS[0]} className="gap-2">
                  <span className="font-mono text-ui-xs text-foreground-subtle">{p.key}</span>
                  <span className="truncate text-ui-sm text-foreground">{p.name}</span>
                </PanelTableCell>
                <PanelTableCell
                  column={ACCESS_COLUMNS[1]}
                  className="text-ui-sm text-foreground-subtle"
                >
                  {level === undefined
                    ? EMPTY_VALUE
                    : level === null
                      ? t('access.noAccess')
                      : level === 'workspace_admin'
                        ? t('access.workspaceAdmin')
                        : projectLevelLabel(level)}
                </PanelTableCell>
              </PanelTableRow>
            )
          })
        )}
      </PanelTable>
    </Card>
  )
}

/**
 * Project on the left, the reader's level beside it.
 *
 * The heading was one uppercase band reading `Your Project Access` over an unlabelled two-column
 * list, so the LEVEL column — the answer this screen exists to give — had no heading at all. Naming
 * both columns is what the shared table asks for, and it is also the honest layout: the level is a
 * value in a column, not a suffix on the project name.
 *
 * The level is LEFT-aligned, unlike every other `align: 'right'` column in the app. Those are all
 * numeric, where right alignment plus `tabular-nums` lines the digits up into a column that can be
 * scanned; this one holds words (`Admin`, `Editor`, `No Access`) of unequal length, so right
 * alignment ragged their first letters and gave the reader no edge to read down.
 */
const ACCESS_COLUMNS: PanelTableColumn[] = [
  { key: 'project', label: 'Project' },
  { key: 'level', label: 'Your Access', width: 148 },
]

const CAPABILITY_ROWS = [
  {
    level: 'Workspace Admin',
    desc: 'Full company authority — manages all users, Projects, Teams, access.',
    color: BRAND.primary,
    bg: BRAND.primaryLighter,
    border: BRAND.primary,
  },
  {
    level: 'Admin',
    desc: 'Full delivery admin in one Project (All Teams). No structural admin.',
    color: BRAND.success,
    bg: BRAND.successBg,
    border: BRAND.successBorder,
  },
  {
    level: 'Editor',
    desc: 'Create/edit/delete team-scoped work in assigned Teams.',
    color: BRAND.warning,
    bg: BRAND.warningBg,
    border: BRAND.warningBorder,
  },
  {
    level: 'No Access',
    desc: 'Project is hidden; direct URLs are denied.',
    color: BRAND.textSecondary,
    bg: BRAND.surfaceSubtle,
    border: BRAND.border,
  },
]
