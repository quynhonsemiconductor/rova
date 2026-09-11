/**
 * Settings > Workspaces & Projects — the BA's new administration surface (mockup
 * WorkspaceProjectsPanel). A Workspace > Project > Team TREE on the left selects a
 * node; the right pane shows a project's Details / Users & Permissions / Teams.
 *
 * Stage 1 (this file): tree + detail shell + the Details tab with editable per-project
 * Estimation Settings (SRS §6.2). Users & Permissions reuses the existing access list;
 * Teams is a placeholder until Stage 3. Project CRUD header actions arrive in Stage 4.
 *
 * 3-level access (WA / Admin / Editor) — no Viewer.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  ChevronRight,
  FolderKanban,
  Users,
  Plus,
  Archive,
  RotateCcw,
  Trash2,
  Pencil,
} from 'lucide-react'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { PERMISSION } from '@/shared/config/permissions'
import {
  useProjects,
  useProjectEstimationSettings,
  useUpdateProjectEstimationSettings,
  useUpdateProject,
  useDeleteProject,
  type ProjectEstimationSettings,
  type Project,
} from '@/features/projects/api'
import { useProjectTeams, type Team } from '@/features/teams/api'
import { useProjectPermissions } from '@/features/access/api'
import {
  canViewProjectRoster,
  effectiveProjectLevel,
  projectLevelLabel,
} from '../model/effective-access'
import { TeamDetail } from './project-teams-tab'
import { useWorkspaceMembers } from '@/features/workspaces/api'
import { SettingsTabHeader } from './settings-tab-header'
import { ProjectAccessList } from './projects-access-tab'
import { ProjectTeamsTab } from './project-teams-tab'
import { NewProjectModal } from '@/pages/projects/ui/project-parts'
import { TestCaseTypesSection } from './test-case-types-section'
import { notify } from '@/shared/lib/toast'
import { Button } from '@/shared/ui/button'
import { IconButton } from '@/shared/ui/icon-button'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { FormField } from '@/shared/ui/form-field'
import { SearchableSelect, type SelectOption } from '@/shared/ui/searchable-select'
import { memberSelectOption } from '@/shared/ui/owner-cell'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'

type TabKey = 'details' | 'users' | 'teams'
const SIZES: Array<{
  key: 'xsPoints' | 'sPoints' | 'mPoints' | 'lPoints' | 'xlPoints'
  label: string
}> = [
  { key: 'xsPoints', label: 'XS' },
  { key: 'sPoints', label: 'S' },
  { key: 'mPoints', label: 'M' },
  { key: 'lPoints', label: 'L' },
  { key: 'xlPoints', label: 'XL' },
]

export function WorkspaceProjectsPanel() {
  const workspaceId = useAppContext((s) => s.workspace?.workspaceId)
  const workspaceName = useAppContext((s) => s.workspace?.workspaceName) ?? 'Workspace'
  const { hasPermission } = useAuthStore()
  const isWA = hasPermission(PERMISSION.WORKSPACE_ALL)
  const { data: projects = [], isLoading } = useProjects(workspaceId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // A TEAM node clicked in the tree (mockup parity) — takes the detail pane.
  const [selectedTeam, setSelectedTeam] = useState<{
    projectId: string
    teamId: string
    team: Team
  } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const selected = projects.find((p) => p.id === selectedId) ?? null

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <SettingsTabHeader
        contained
        title="Workspaces & Projects"
        description="Administer projects, teams and per-project access in one place."
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── Tree ── */}
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-border-subtle bg-card px-2 py-3">
          {isWA && (
            <div className="mb-2 flex items-center justify-between px-2">
              <span className="text-ui-xs font-semibold tracking-wide text-foreground-subtle uppercase">
                Workspace
              </span>
              <IconButton
                size="sm"
                aria-label="Create project"
                title="Create project"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={13} />
              </IconButton>
            </div>
          )}
          {/* Workspace root */}
          <button
            onClick={() => setSelectedId(null)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm font-medium text-foreground hover:bg-surface-hover"
          >
            <FolderKanban size={14} className="text-foreground-subtle" />
            <span className="truncate">{workspaceName}</span>
            <span className="ml-auto rounded-full bg-surface-hover px-1.5 text-ui-xs text-foreground-subtle">
              {projects.length}
            </span>
          </button>
          {isLoading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-ui-xs text-foreground-subtle">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : (
            <div className="mt-1 space-y-0.5">
              {projects.map((p) => (
                <ProjectNode
                  key={p.id}
                  project={p}
                  selected={selectedId === p.id && selectedTeam?.projectId !== p.id}
                  activeTeamId={selectedTeam?.projectId === p.id ? selectedTeam.teamId : null}
                  expanded={expanded.has(p.id)}
                  onToggle={() => toggle(p.id)}
                  onSelect={() => {
                    setSelectedId(p.id)
                    setSelectedTeam(null)
                  }}
                  onSelectTeam={(team) =>
                    setSelectedTeam({ projectId: p.id, teamId: team.id, team })
                  }
                />
              ))}
              {projects.length === 0 && (
                <p className="px-2 py-2 text-ui-xs text-foreground-subtle">No projects yet.</p>
              )}
            </div>
          )}
        </aside>

        {/* ── Detail pane ── */}
        <section className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
          {selectedTeam ? (
            /* Mockup parity: clicking a TEAM node in the tree opens the team detail —
             * same view the Teams tab's row click opens, self-contained on edit. */
            <TeamDetail
              projectId={selectedTeam.projectId}
              team={selectedTeam.team}
              workspaceId={workspaceId}
              isWA={isWA}
            />
          ) : selected ? (
            <ProjectDetail
              project={selected}
              isWA={isWA}
              onOpenTeam={(team) =>
                setSelectedTeam({ projectId: selected.id, teamId: team.id, team })
              }
            />
          ) : (
            <WorkspaceOverview
              projects={projects}
              onSelect={setSelectedId}
              isWA={isWA}
              onCreate={() => setCreateOpen(true)}
            />
          )}
        </section>
      </div>

      {createOpen && workspaceId && (
        <NewProjectModal workspaceId={workspaceId} onClose={() => setCreateOpen(false)} />
      )}
    </>
  )
}

/** Workspace-node view: the project list (mockup's workspace overview). */
function WorkspaceOverview({
  projects,
  onSelect,
  isWA,
  onCreate,
}: {
  projects: Project[]
  onSelect: (id: string) => void
  isWA: boolean
  onCreate: () => void
}) {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-ui-lg font-semibold text-foreground">Projects</h2>
        {isWA && (
          <Button type="button" onClick={onCreate}>
            <Plus size={14} /> Create project
          </Button>
        )}
      </div>
      {projects.length === 0 ? (
        <div className="rounded-lg border border-border-subtle px-4 py-8 text-center text-ui-md text-foreground-subtle">
          No projects yet.
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle">
          <div className="flex border-b border-border-subtle bg-surface-hover px-4 py-2 text-ui-xs font-semibold tracking-wide text-foreground-subtle uppercase">
            <span className="w-20">Key</span>
            <span className="flex-1">Project</span>
            <span className="w-24">Status</span>
            <span className="w-20 text-center">Teams</span>
          </div>
          {projects.map((p) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(p.id)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(p.id)}
              className="flex cursor-pointer items-center border-b border-border-subtle px-4 py-2.5 text-left last:border-b-0 hover:bg-surface-hover"
            >
              <span className="w-20 font-mono text-ui-xs text-foreground-subtle">{p.key}</span>
              <span className="flex-1 truncate text-ui-sm font-medium text-foreground">
                {p.name}
              </span>
              <span className="w-24 text-ui-xs text-foreground-subtle capitalize">{p.status}</span>
              <span className="w-20 text-center text-ui-sm text-foreground-subtle">
                {p.teamCount ?? 0}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Lean Edit modal for the core project identity fields (name/description/dates/lead).
 *  Estimation lives on the Details tab; teams on the Teams tab — no duplication. */
function EditProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const workspaceId = useAppContext((s) => s.workspace?.workspaceId)
  const { data: wsMembers = [] } = useWorkspaceMembers(workspaceId)
  const update = useUpdateProject()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [startDate, setStartDate] = useState(project.startDate ?? '')
  const [endDate, setEndDate] = useState(project.endDate ?? '')
  const [leadId, setLeadId] = useState<string | null>(project.leadId ?? null)

  /**
   * A WORKSPACE ADMIN IS A VALID PROJECT OWNER, and this filter said otherwise.
   *
   * The 2026-08-20 feature (PR 463) states it as AC3 — "a Workspace Admin who is an eligible active
   * company user can be selected as Project Owner" — and the server has always agreed:
   * `WorkspaceMemberRepository.listMemberOptions` unions in `projects.lead_id` precisely BECAUSE a WA
   * holds no `project_members` row and would otherwise be unnameable. The identical filter on Team lead
   * was removed with that feature; this twin was missed, so the one screen that edits a project's owner
   * still withheld them.
   *
   * `memberSelectOption` also gives each row the avatar this list renders everywhere else.
   */
  const leadOptions: SelectOption[] = wsMembers
    .filter((m) => m.status === 'active')
    .map((m) => memberSelectOption(m))

  function handleSave() {
    update.mutate(
      {
        id: project.id,
        input: {
          name: name.trim(),
          description: description.trim() || null,
          startDate: startDate || null,
          endDate: endDate || null,
          leadId: leadId || null,
        },
      },
      {
        onSuccess: () => {
          notify.success('Project updated')
          onClose()
        },
        onError: (e) => notify.fromError(e, 'Failed to update project'),
      },
    )
  }

  return (
    <AppModal open onClose={onClose} title={`Edit ${project.key}`} width={460}>
      <ModalBody className="space-y-4">
        <FormField label="Project name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Start date">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </FormField>
          <FormField label="End date">
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Project owner">
          <SearchableSelect
            variant="field"
            value={leadId ?? ''}
            ariaLabel="Project owner"
            placeholder="Unassigned"
            options={leadOptions}
            onChange={(v) => setLeadId(v as string | null)}
          />
        </FormField>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={name.trim().length < 2 || update.isPending}
          onClick={handleSave}
        >
          {update.isPending && <Loader2 size={12} className="animate-spin" />}
          Save
        </Button>
      </ModalFooter>
    </AppModal>
  )
}

/** One project row in the tree, expanding to its team children. */
function ProjectNode({
  project,
  selected,
  activeTeamId,
  expanded,
  onToggle,
  onSelect,
  onSelectTeam,
}: {
  project: Project
  /** Project row is the highlighted node only when no TEAM under it is selected. */
  selected: boolean
  activeTeamId: string | null
  expanded: boolean
  onToggle: () => void
  onSelect: () => void
  onSelectTeam: (team: Team) => void
}) {
  // Each node fetches its own teams so the hook rules hold; only fetched when needed.
  const { data: teams = [] } = useProjectTeams(expanded ? project.id : undefined)
  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-ui-sm ${
          selected
            ? 'bg-surface-hover font-medium text-foreground'
            : 'text-foreground hover:bg-surface-hover'
        }`}
      >
        <button
          onClick={onToggle}
          className="shrink-0 text-foreground-subtle"
          aria-label="Toggle teams"
        >
          <ChevronRight
            size={13}
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <span className="block truncate">{project.name}</span>
          <span className="block truncate text-ui-xs text-foreground-subtle">
            {project.key} · {project.teamCount ?? teams.length} teams
          </span>
        </button>
      </div>
      {expanded && (
        <div className="ml-5 border-l border-border-subtle pl-2">
          {teams.length === 0 ? (
            <p className="px-2 py-1 text-ui-xs text-foreground-subtle">No teams.</p>
          ) : (
            teams.map((t) => (
              /* Mockup parity: a team node in the tree is CLICKABLE — selecting it
               * opens the team detail in the right pane, like selecting a project. */
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                aria-current={t.id === activeTeamId ? 'true' : undefined}
                onClick={() => onSelectTeam(t)}
                onKeyDown={(e) => e.key === 'Enter' && onSelectTeam(t)}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-ui-xs transition-colors hover:bg-surface-hover ${
                  t.id === activeTeamId
                    ? 'bg-surface-hover font-medium text-foreground'
                    : 'text-foreground-subtle hover:text-foreground'
                }`}
              >
                <Users size={11} /> <span className="truncate">{t.name}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ProjectDetail({
  project,
  isWA,
  onOpenTeam,
}: {
  project: Project
  isWA: boolean
  onOpenTeam: (team: Team) => void
}) {
  const [tab, setTab] = useState<TabKey>('details')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()

  /**
   * `Users & Permissions` is HIDDEN for an Editor, so the TAB is absent — not rendered and then
   * refused.
   *
   * §3.1:71 — "View Project `Users & Permissions` | Edit | Read-only | Hidden | Hidden" — and
   * `P3_RBAC_AND_SYSTEM_STATES.md:56` states the same three outcomes. What it used to do is the worst
   * available combination: the tab rendered for every reader, and `ProjectAccessList`'s first request
   * (`GET /projects/:id/members`) then 403'd for an Editor, whose silent failure printed "No members
   * in this project yet." So the surface confirmed its own existence and answered with a fabricated
   * fact about the project. `:38` of the same file forbids exactly this ("Disabled ... must not be
   * used as a replacement for No Access"), and disabling it would have been no better.
   *
   * The rule is derived from the reader's own self-scoped permissions, so it mirrors the check the
   * SERVER makes on the feed the tab reads — `listProjectMembers` refuses any level but `admin` —
   * rather than approximating it. `Details` and `Teams` stay for every level: §3.1:70 gives an Editor
   * "Read-only, scoped" on "View Project Details and Teams".
   */
  const { can } = useProjectPermissions(project.id)
  const canViewRoster = canViewProjectRoster(effectiveProjectLevel(can))

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'details', label: 'Details' },
    ...(canViewRoster ? [{ key: 'users' as TabKey, label: 'Users & Permissions' }] : []),
    { key: 'teams', label: 'Teams' },
  ]
  /**
   * DERIVED from the same `tabs` the strip renders, so the two cannot disagree — the strip and the
   * panel answer with ONE predicate.
   *
   * The tree switches project WITHOUT remounting this component, so the open tab outlives the project
   * it was opened on: a reader who opens `Users & Permissions` on a project they administer and then
   * selects one they only edit would otherwise keep the hidden surface mounted under a strip that no
   * longer offers it. `details` is visible at every level (§3.1:70), so the fallback always lands and
   * the panel can never go blank.
   *
   * Deliberately NOT held while the permission read is in flight, which was tried: `canViewRoster` is
   * false during the fetch (the hook falls back to the workspace baseline, which holds nothing for a
   * normal user), so holding the panel produced a mounted roster under a strip with no tab for it —
   * the dead panel this rule exists to prevent, reached from the other side. `tab` state is left
   * alone, so once the grants land the reader is returned to the tab they chose rather than stranded
   * on Details.
   */
  const activeTab: TabKey = tabs.some((tt) => tt.key === tab) ? tab : 'details'

  function setStatus(status: 'active' | 'archived') {
    updateProject.mutate(
      { id: project.id, input: { status } },
      {
        onSuccess: () =>
          notify.success(status === 'archived' ? 'Project archived' : 'Project restored'),
        onError: (e) => notify.fromError(e, 'Failed to update project'),
      },
    )
  }

  function confirmDelete() {
    deleteProject.mutate(project.id, {
      onSuccess: () => {
        notify.success('Project deleted')
        setDeleteOpen(false)
      },
      onError: (e) => notify.fromError(e, 'Failed to delete project'),
    })
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* Header — destructive project lifecycle actions (Edit is the inline Details tab) */}
      <div className="mb-4 flex items-start justify-between border-b border-border-subtle pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-ui-lg font-semibold text-foreground">
            {project.name}
            {!isWA && <EffectiveAccessChip projectId={project.id} />}
          </h2>
          <p className="text-ui-xs text-foreground-subtle">
            {project.key} · {project.status} · {project.teamCount ?? 0} teams
          </p>
        </div>
        {isWA && (
          <div className="flex gap-1">
            {/* P0-PRJ-008: an archived project offers Restore ONLY — Edit/Delete
                are hidden so the read-only state is not half-enforced by icons. */}
            {project.status === 'active' && (
              <IconButton
                size="sm"
                aria-label="Edit project"
                title="Edit"
                onClick={() => setEditOpen(true)}
              >
                <Pencil size={14} />
              </IconButton>
            )}
            {project.status === 'active' ? (
              <IconButton
                size="sm"
                aria-label="Archive project"
                title="Archive"
                onClick={() => setArchiveOpen(true)}
              >
                <Archive size={14} />
              </IconButton>
            ) : (
              <IconButton
                size="sm"
                aria-label="Restore project"
                title="Restore"
                onClick={() => setStatus('active')}
              >
                <RotateCcw size={14} />
              </IconButton>
            )}
            {project.status === 'active' && (
              <IconButton
                size="sm"
                aria-label="Delete project"
                title="Delete"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 size={14} />
              </IconButton>
            )}
          </div>
        )}
      </div>

      {/* Tab strip */}
      <div className="mb-5 flex gap-1 border-b border-border-subtle">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-ui-sm transition-colors ${
              activeTab === t.key
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-foreground-subtle hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'details' && <DetailsTab project={project} isWA={isWA} />}
      {activeTab === 'users' && <ProjectAccessList projectId={project.id} isWA={isWA} />}
      {activeTab === 'teams' && (
        <ProjectTeamsTab projectId={project.id} isWA={isWA} onOpenTeam={onOpenTeam} />
      )}

      {editOpen && <EditProjectModal project={project} onClose={() => setEditOpen(false)} />}

      {/* Archive is a real state flip (read-only project, dropped from selectors) —
          guarded like every other destructive action on this header. Restore stays
          inline: it reverses the same flip and destroys nothing. */}
      <ConfirmDialog
        open={archiveOpen}
        title="Archive project"
        message={`Archive ${project.name}? It becomes read-only and is removed from active delivery selectors. Existing work and audit history are preserved.`}
        confirmLabel="Archive project"
        pending={updateProject.isPending}
        onConfirm={() => {
          setStatus('archived')
          setArchiveOpen(false)
        }}
        onCancel={() => setArchiveOpen(false)}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete project"
        message={`Type ${project.key} to confirm permanent deletion.`}
        confirmText={project.key}
        confirmLabel="Delete project"
        pending={deleteProject.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  )
}

/**
 * PM-FR-005 / mockup:424 — a non-WA reader sees their effective access beside the project name (the WA
 * sees everything, so no chip).
 *
 * IT USED TO SAY "No Access" TO EVERYONE. The chip read `accessLevel` off
 * `GET /projects/:projectId/my-permissions`, and that response has never carried the field —
 * `ProjectPermissionsResponseSchema` is `{ projectId, permissions }`. So `data.accessLevel` was always
 * `undefined`, `?? 'no_access'` turned that into a claim, and an Admin or Editor was told, beside their
 * own project's name, that they had no access to it. Its docblock said it "reads the same feed
 * MyPermissions renders from", which was true of the URL and false of the field.
 *
 * Now it derives the level from the PERMISSIONS that feed really returns, through the same
 * `effectiveProjectLevel` the tab strip and the roster gate use — so the chip, the visible tabs and
 * the server's own refusal cannot disagree about who the reader is. `useProjectPermissions` also means
 * one shared cache entry instead of this component's hand-rolled key, which never matched
 * `accessKeys.myProjectPermissions` and so refetched per row.
 *
 * An UNRESOLVED read renders nothing rather than "No Access": absent is not denied, and a chip is not
 * worth a fabricated claim about the reader while the answer is still in flight.
 */
function EffectiveAccessChip({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings')
  const { can, isLoading } = useProjectPermissions(projectId)
  if (isLoading) return null

  const level = effectiveProjectLevel(can)
  // `workspace_admin` is not a per-project LEVEL, so it has no entry in the option list the labels
  // come from — it gets its own string, and `null` gets "No Access", which is the absence of a level
  // rather than one of them.
  const label =
    level === null
      ? t('access.noAccess')
      : level === 'workspace_admin'
        ? t('access.workspaceAdmin')
        : projectLevelLabel(level)
  return (
    <span
      className={
        level === 'admin' || level === 'workspace_admin'
          ? 'rounded bg-primary-lighter px-1.5 py-0.5 text-ui-xs font-medium text-primary'
          : 'rounded bg-surface-hover px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle'
      }
    >
      {label}
    </span>
  )
}

/** Details tab: read-only project fields + editable Estimation Settings (WA only). */
function DetailsTab({ project, isWA }: { project: Project; isWA: boolean }) {
  return (
    <div className="space-y-6">
      <FieldGrid project={project} />
      <EstimationSettingsBlock projectId={project.id} isWA={isWA} />
      <TestCaseTypesSection projectId={project.id} isWA={isWA} />
    </div>
  )
}

function FieldGrid({ project }: { project: Project }) {
  const rows: Array<{ label: string; value: string | null }> = [
    { label: 'Project name', value: project.name },
    { label: 'Project key', value: project.key },
    { label: 'Status', value: project.status },
    { label: 'Start date', value: project.startDate },
    { label: 'End date', value: project.endDate },
    { label: 'Project owner', value: project.leadName },
  ]
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4">
      {rows.map((r) => (
        <div key={r.label}>
          <p className="text-ui-xs font-medium tracking-wide text-foreground-subtle uppercase">
            {r.label}
          </p>
          <p className="mt-0.5 text-ui-sm text-foreground">{r.value || '--'}</p>
        </div>
      ))}
      <div className="col-span-2">
        <p className="text-ui-xs font-medium tracking-wide text-foreground-subtle uppercase">
          Description
        </p>
        <p className="mt-0.5 text-ui-sm text-foreground">{project.description || '--'}</p>
      </div>
    </div>
  )
}

/**
 * The per-project T-shirt → points scale + hours/point (SRS §6.2). WA can edit; others
 * read the effective scale the progress bars compute with. Defaults 1/3/5/8/13 + 8.
 */
function EstimationSettingsBlock({ projectId, isWA }: { projectId: string; isWA: boolean }) {
  const { data, isLoading } = useProjectEstimationSettings(projectId)
  const save = useUpdateProjectEstimationSettings()
  const [draft, setDraft] = useState<ProjectEstimationSettings | null>(null)

  // Seed local draft once the read lands (or when it changes after save).
  const current = draft ?? data ?? null
  if (!current && isLoading) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
        <Loader2 size={13} className="animate-spin" /> Loading estimation settings…
      </div>
    )
  }
  if (!current) return null
  const effective = draft ?? data ?? current

  function patch(key: keyof ProjectEstimationSettings, value: number) {
    setDraft((d) => ({ ...(d ?? data!), [key]: value }))
  }

  function commit() {
    if (!draft) return
    save.mutate(
      { id: projectId, input: draft },
      {
        onSuccess: () => {
          notify.success('Estimation settings saved')
          setDraft(null)
        },
        onError: (e) => notify.fromError(e, 'Failed to save estimation settings'),
      },
    )
  }

  return (
    <div className="rounded-lg border border-border-subtle p-4">
      <h3 className="text-ui-sm font-semibold text-foreground">Estimation Settings</h3>
      <p className="mt-0.5 text-ui-xs text-foreground-subtle">
        Preliminary Estimate — the T-shirt → points scale consumed by Capacity Planning and Reports.
      </p>
      <div className="mt-3 grid grid-cols-5 gap-2">
        {SIZES.map((s) => (
          <FormField key={s.key} label={s.label}>
            <Input
              type="number"
              min={1}
              disabled={!isWA}
              value={String(effective[s.key])}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v > 0) patch(s.key, v)
              }}
              className="text-center"
            />
          </FormField>
        ))}
      </div>
      <div className="mt-3">
        <FormField label="Hours per point">
          <Input
            type="number"
            min={0.5}
            step={0.5}
            disabled={!isWA}
            value={String(effective.hoursPerPoint)}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v > 0) patch('hoursPerPoint', v)
            }}
            className="w-24"
          />
        </FormField>
      </div>
      {isWA && (
        <div className="mt-3 flex justify-end">
          <Button type="button" disabled={!draft || save.isPending} onClick={commit}>
            {save.isPending && <Loader2 size={12} className="animate-spin" />}
            Save estimation
          </Button>
        </div>
      )}
    </div>
  )
}
