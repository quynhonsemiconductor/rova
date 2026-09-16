/**
 * Per-project Teams tab inside Settings > Workspaces & Projects. Lists the project's
 * teams and lets a Workspace Admin create a team (linked to this project), edit, and
 * deactivate/restore. Mirrors the mockup's Teams tab (Key | Team | Lead | Status |
 * Members | Actions + Add Team).
 *
 * Reuses the team hooks (useCreateTeam / useUpdateTeam / useProjectTeams). Team lead
 * candidates come from the workspace roster. A team cannot be deleted — only
 * deactivated (history preserved), per SRS §488.
 *
 * ── §2.1 AND A WORKSPACE ADMIN: ONE HALF REVERSED, ONE HALF UNCHANGED ────────────────────────
 *
 * This file used to exclude a Workspace Admin from the Team lead options and the Members & Access
 * table outright, on the reading that "a Workspace Admin is company-level only — not a Team lead or
 * member candidate (§2)". **The BA has REVERSED exactly that.** A Workspace Admin may now be
 * MANUALLY added to and removed from one or more ACTIVE Teams, may be selected as that Team's Team
 * Lead and as a Work Item Owner within it, and may be a Project Owner. Never automatically: there is
 * no auto-enrolment anywhere, which is why the membership is a checkbox and a pick and never a
 * consequence of holding the role.
 *
 * **What did NOT reverse is the `project_members` half, and it is the correctness point of the whole
 * change.** §2.1 still keeps a Workspace Admin out of `project_members` — migration 0118 deletes
 * those rows, `AccessService.effectiveAssignments` would read one as a live Project Admin grant, and
 * the ruling states the reversal as OPERATIONAL scope only: team membership "must NOT create or
 * require an Admin/Editor Project Access assignment, and must not change their permissions". So:
 *
 *   • a Workspace Admin IS an eligible Team lead and an eligible Team member (reversed);
 *   • a Workspace Admin row offers NO access-level select and is EXCLUDED from the
 *     `useSetProjectAccess` sync — it renders the `Workspace Admin` badge instead (unchanged half);
 *   • `projects-access-tab.tsx`'s PROJECT ACCESS candidate list still filters them out entirely
 *     (also unchanged) — that list adds `project_members` rows and nothing else.
 *
 * The old reasoning is kept above rather than deleted because the two halves are one sentence in the
 * SRS, and the next reader of §2.1 will have to know which half a ruling moved.
 */
import { useState } from 'react'
import { Loader2, Plus, Pencil, Archive, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import {
  useProjectTeams,
  useCreateTeam,
  useUpdateTeam,
  useProjectMembers,
  useSetProjectAccess,
  useTeamMembers,
  type Team,
} from '@/features/teams/api'
import { useWorkspaceMembers, useWorkspaceMemberOptions } from '@/features/workspaces/api'
import { SearchableSelect, type SelectOption } from '@/shared/ui/searchable-select'
import { SelectionCheckbox } from '@/shared/ui/selection-checkbox'
import { memberSelectOption, OwnerAvatar } from '@/shared/ui/owner-cell'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { IconButton } from '@/shared/ui/icon-button'
import {
  PanelTable,
  PanelTableCell,
  PanelTableRow,
  type PanelTableColumn,
} from '@/shared/ui/table/panel-table'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { FormField } from '@/shared/ui/form-field'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { WorkspaceAdminBadge } from '@/shared/ui/workspace-admin-badge'
import { TeamMemberRoster } from './team-member-roster'
import { notify } from '@/shared/lib/toast'
import { suggestKey } from '@/shared/lib/suggest-key'
import {} from '@/shared/config/access-levels'

export function ProjectTeamsTab({
  projectId,
  isWA,
  onOpenTeam,
}: {
  projectId: string
  isWA: boolean
  /** Row click bubbles to the panel, which shows the team detail in the whole
   *  detail pane (mockup parity — replaces the project header + tabs, so the
   *  team's own header is never stacked under the project's). */
  onOpenTeam: (team: Team) => void
}) {
  const { t } = useTranslation('settings')
  const workspaceId = useAppContext((s) => s.workspace?.workspaceId)
  const { data: teams = [], isLoading } = useProjectTeams(projectId)
  /**
   * The Lead's name/avatar comes from the PICKER feed, not the administrative roster.
   *
   * This tab is gated `project:view`, so an EDITOR reaches it — and the administrative roster is now
   * `workspace:view` (Workspace Admin only), because it carries `phone`, `lastLoginAt` and the role ids
   * (RBE-07). Reading it here would 403 for every non-WA and silently degrade every Lead to `--`: no
   * crash, no error, just a column that quietly stops working for the level that uses it most.
   */
  const { data: wsMembers = [] } = useWorkspaceMemberOptions(workspaceId)
  /**
   * Column widths, stated once for the heading and the cells alike.
   *
   * `Team` is the flexible one; every other column is fixed, so a long team name yields instead of
   * squeezing `Members` and `Actions` until their headings wrap. The `Actions` column exists only
   * for a Workspace Admin, which is why this is built rather than a module constant — the row
   * renders the same conditional, from the same array.
   */
  const teamColumns: PanelTableColumn[] = [
    { key: 'key', label: t('teams.colKey'), width: 80 },
    { key: 'name', label: t('teams.colTeam') },
    { key: 'lead', label: t('teams.colLead'), width: 128 },
    { key: 'status', label: t('common:status'), width: 96 },
    { key: 'members', label: t('teams.colMembers'), width: 80, align: 'center' },
    ...(isWA
      ? [{ key: 'actions', label: t('common:actions'), width: 80, align: 'center' as const }]
      : []),
  ]
  const [editing, setEditing] = useState<Team | null>(null)
  const [creating, setCreating] = useState(false)
  const [deactivateTarget, setDeactivateTarget] = useState<Team | null>(null)
  const updateTeam = useUpdateTeam(deactivateTarget?.id ?? editing?.id ?? '')

  function confirmDeactivate() {
    if (!deactivateTarget) return
    updateTeam.mutate(
      { status: 'archived' },
      {
        onSuccess: () => {
          notify.success(`Deactivated ${deactivateTarget.name}`)
          setDeactivateTarget(null)
        },
        onError: (e) => notify.fromError(e, 'Failed to deactivate team'),
      },
    )
  }

  return (
    <>
      {isWA && (
        <div className="mb-3 flex justify-end">
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus size={14} /> Add team
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-ui-md text-foreground-subtle">
          <Loader2 size={14} className="animate-spin" /> Loading teams…
        </div>
      ) : teams.length === 0 ? (
        <div className="rounded-lg border border-border-subtle px-4 py-8 text-center text-ui-md text-foreground-subtle">
          No teams linked to this project yet.
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle">
          {/*
           * The shared panel table, for the reason Home's two tables gave: `flex-1` on the Team
           * column with no `min-w-0` cannot shrink below its own content, so a long team name
           * squeezes the fixed columns until their headings wrap. Same shape, same latent defect,
           * so the same component rather than a third copy of the geometry.
           */}
          <PanelTable columns={teamColumns} gapClassName="gap-2">
            {/* `team`, not `t` — `t` is the translator in this scope now. */}
            {teams.map((team) => {
              const lead = wsMembers.find((m) => m.userId === team.leadId)
              const leadName = lead?.displayName ?? lead?.email ?? EMPTY_VALUE
              return (
                <PanelTableRow
                  key={team.id}
                  gapClassName="gap-2"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenTeam(team)}
                  onKeyDown={(e) => e.key === 'Enter' && onOpenTeam(team)}
                  className="cursor-pointer py-2.5 text-left last:border-b-0"
                >
                  <PanelTableCell
                    column={teamColumns[0]}
                    className="font-mono text-ui-xs text-foreground-subtle"
                  >
                    {team.key}
                  </PanelTableCell>
                  <PanelTableCell column={teamColumns[1]}>
                    <span className="truncate text-ui-sm font-medium text-foreground">
                      {team.name}
                    </span>
                  </PanelTableCell>
                  <PanelTableCell column={teamColumns[2]} className="gap-1.5">
                    <OwnerAvatar name={leadName} size={16} />
                    <span className="truncate text-ui-xs text-foreground-subtle">{leadName}</span>
                  </PanelTableCell>
                  <PanelTableCell
                    column={teamColumns[3]}
                    className="text-ui-xs text-foreground-subtle capitalize"
                  >
                    {team.status === 'active' ? 'Active' : 'Deactivated'}
                  </PanelTableCell>
                  <PanelTableCell
                    column={teamColumns[4]}
                    className="text-ui-sm text-foreground-subtle"
                  >
                    {team.memberCount ?? 0}
                  </PanelTableCell>
                  {isWA && (
                    /* stopPropagation: the row opens detail; the icon acts alone. */
                    <PanelTableCell
                      column={teamColumns[5]}
                      className="gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <IconButton
                        size="sm"
                        aria-label="Edit team"
                        title="Edit"
                        onClick={() => setEditing(team)}
                      >
                        <Pencil size={13} />
                      </IconButton>
                      {team.status === 'active' ? (
                        <IconButton
                          size="sm"
                          aria-label="Deactivate team"
                          title="Deactivate"
                          onClick={() => setDeactivateTarget(team)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Archive size={13} />
                        </IconButton>
                      ) : (
                        <RestoreButton teamId={team.id} name={team.name} />
                      )}
                    </PanelTableCell>
                  )}
                </PanelTableRow>
              )
            })}
          </PanelTable>
        </div>
      )}

      {/*
        TYPED target confirmation (GAP-P4-SET-004). It already named the team; what it lacked was
        `confirmText`, so a mis-aimed click on a 13px icon in a dense row committed immediately.
        A Team deactivation is a MULTI-USER action — the team leaves every picker, assignment
        surface and capacity-plan eligibility list at once — which is why it is gated harder than a
        single user's Deactivate (that one stays a plain named confirm, `members-tab.tsx`).
      */}
      <ConfirmDialog
        open={!!deactivateTarget}
        title={t('teams.deactivateTitle')}
        message={
          deactivateTarget ? t('teams.deactivateConfirm', { name: deactivateTarget.name }) : ''
        }
        confirmText={deactivateTarget?.name}
        confirmLabel={t('teams.deactivateConfirmLabel')}
        destructive
        pending={updateTeam.isPending}
        onConfirm={confirmDeactivate}
        onCancel={() => setDeactivateTarget(null)}
      />

      {(creating || editing) && (
        <TeamFormModal
          projectId={projectId}
          workspaceId={workspaceId}
          team={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

/**
 * Restore needs its own hook instance (per-teamId), and owns its own confirmation.
 *
 * TARGET-NAMED, not TYPED (GAP-P4-SET-004). The BA asks for "a target-specific confirmation" on
 * Deactivate/restore Team and reserves typed confirmation for removing access; a restore is not
 * destructive — it reverses a deactivation and destroys nothing — so making someone retype a team
 * name here is friction with no safety value. What it DID lack is any confirmation at all: the
 * mutation fired straight from `onClick`, so a stray click on a 13px icon silently put a disbanded
 * team back into every picker and assignment surface. Naming the team is what makes the prompt
 * useful, because the icon is identical on every row.
 */
function RestoreButton({ teamId, name }: { teamId: string; name: string }) {
  const { t } = useTranslation('settings')
  const updateTeam = useUpdateTeam(teamId)
  const [confirming, setConfirming] = useState(false)

  function confirmRestore() {
    updateTeam.mutate(
      { status: 'active' },
      {
        onSuccess: () => {
          notify.success(`Restored ${name}`)
          setConfirming(false)
        },
        onError: (e) => notify.fromError(e, 'Failed to restore team'),
      },
    )
  }

  return (
    <>
      <IconButton
        size="sm"
        aria-label="Restore team"
        title="Restore"
        onClick={() => setConfirming(true)}
      >
        <RotateCcw size={13} />
      </IconButton>
      <ConfirmDialog
        open={confirming}
        title={t('teams.restoreTitle')}
        message={t('teams.restoreConfirm', { name })}
        confirmLabel={t('teams.restoreConfirmLabel')}
        pending={updateTeam.isPending}
        onConfirm={confirmRestore}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}

/** Team DETAIL view (mockup parity): fields grid + member roster + WA Edit.
 *  Reached by clicking a team row OR a team node in the tree; Back returns to
 *  whatever surface opened it. Self-contained on edit (renders TeamFormModal). */
export function TeamDetail({
  projectId,
  team,
  workspaceId,
  isWA,
}: {
  projectId: string
  team: Team
  workspaceId: string | undefined
  isWA: boolean
}) {
  // The COUNT only — the roster itself (and its add/remove controls) is `TeamMemberRoster`, which
  // owns the same `teamKeys.members` cache entry, so the two cannot disagree about the membership.
  const { data: members = [] } = useTeamMembers(team.id)
  // Display-only, so the picker feed — see the note on the row above.
  const { data: wsMembers = [] } = useWorkspaceMemberOptions(workspaceId)
  const [editing, setEditing] = useState(false)
  const leadName =
    wsMembers.find((m) => m.userId === team.leadId)?.displayName ??
    wsMembers.find((m) => m.userId === team.leadId)?.email

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-ui-lg font-semibold text-foreground">{team.name}</h3>
          <p className="text-ui-xs text-foreground-subtle">{team.key}</p>
        </div>
        {isWA && (
          <IconButton
            size="sm"
            aria-label="Edit team"
            title="Edit team"
            onClick={() => setEditing(true)}
          >
            <Pencil size={14} />
          </IconButton>
        )}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-4">
        {(
          [
            ['Team key', team.key],
            ['Status', team.status === 'active' ? 'Active' : 'Deactivated'],
            ['Team lead', leadName ?? '--'],
            ['Members', String(members.length)],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <p className="text-ui-xs font-medium tracking-wide text-foreground-subtle uppercase">
              {label}
            </p>
            <p className="mt-0.5 text-ui-sm text-foreground">{value}</p>
          </div>
        ))}
      </div>

      <TeamMemberRoster team={team} workspaceId={workspaceId} projectId={projectId} isWA={isWA} />

      {editing && (
        <TeamFormModal
          projectId={projectId}
          workspaceId={workspaceId}
          team={team}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

/**
 * Create or edit a team — mockup parity: NO project picker. The tab's own project IS
 * the context: create links the team to exactly this project (the API's ≥1-project
 * rule is satisfied by construction); edit sends no projectIds at all, so existing
 * links are untouched. (Cross-project links are managed from each project's own
 * Teams tab, exactly like the mockup.)
 */
function TeamFormModal({
  projectId,
  workspaceId,
  team,
  onClose,
}: {
  projectId: string
  workspaceId: string | undefined
  team: Team | null
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  // The administrative roster ON PURPOSE, and it still is after the reversal — the modal no longer
  // filters a Workspace Admin OUT of the eligible list, but it still has to KNOW which rows are one,
  // because those rows get the badge and are excluded from the project-access sync. `roleSlug` exists
  // only on this feed. Creating or editing a Team is a Workspace Admin action anyway, so the
  // `workspace:view` gate costs nothing here. Do not "align" this with the two display-only lookups
  // above: they carry no role, so a picker fed from them could not tell a Workspace Admin apart and
  // would write the `project_members` row §2.1 forbids.
  const { data: wsMembers = [] } = useWorkspaceMembers(workspaceId)
  // Existing project members — only needed on create, to sync access for selected members.
  const { data: projectMembers = [] } = useProjectMembers(team ? undefined : projectId)
  const createTeam = useCreateTeam()
  const updateTeam = useUpdateTeam(team?.id ?? '')
  const setAccess = useSetProjectAccess(projectId)
  const [name, setName] = useState(team?.name ?? '')
  /**
   * What the reader TYPED into Team key, which is not the same as what the field shows.
   *
   * The field was required, empty, and advertised `CP` as a placeholder with nothing filling it in —
   * so creating a team meant inventing a key by hand, and the BA reported the placeholder as a stray
   * value. It is derived from the name now (`Core Platform` gives `CP`, exactly what the placeholder
   * promised) and stays editable: a touched value always wins, and clearing the box hands control back
   * to the suggestion rather than sticking on an empty required field.
   *
   * Editing an existing team starts from the stored key and can change it, but only by typing: the
   * suggestion is never re-applied to an existing team, so a rename does not re-key it on its own.
   *
   * The input was disabled here on `PM-FR-022`/AC16's "immutable after" — a rule from when a key
   * prefixed every item id, which `0036_type_prefixed_item_keys` ended. What it left behind was a name
   * that could be edited beside a key derived from it that could not, so `Observability` renamed to
   * `DevOps` kept `OBSERVABIL` and the only fix left was an UPDATE against the database.
   */
  // The stored roster, for the Team Lead options while EDITING (`PM-FR-021`: a lead is a member).
  // Skipped on create — there is no team yet and the ticked rows are the roster.
  const { data: teamMembers = [] } = useTeamMembers(team?.id)
  const [keyTouched, setKeyTouched] = useState(team?.key ?? '')
  const [leadId, setLeadId] = useState<string | null>(team?.leadId ?? null)
  // Per-user access map: presence of a userId = included; its value = the level that
  // row gets. Replaces the old (memberUserIds[] + one shared memberLevel) shape, which
  // could only add everyone at the SAME level — the mockup's Members & Access table lets
  // Priya Nair land as Admin while everyone else stays Editor in the same action.
  /**
   * Team members are Admin or Editor only — never Viewer (SRS §5.3, and Rally removes team
   * membership on demotion to viewer). Deliberately NOT `AccessLevel`: see
   * `TEAM_MEMBER_ACCESS_LEVELS`.
   *
   * `null` is a THIRD state and it is the reversal's load-bearing detail: "this row is a team
   * member, and NO project access level is to be written for it" — a Workspace Admin. It is not
   * `'No Access'` and not the absence of a key: the key's presence is what puts the user in
   * `memberUserIds`, and the value is what {@link syncMemberAccess} decides to write. Collapsing the
   * two would either drop the Workspace Admin's membership or write them a `project_members` row.
   */
  /**
   * Membership only, keyed by userId — `PM-FR-021` removed the level this used to carry ("Project
   * Access is read-only in this flow"). Kept as a record rather than a Set so the existing
   * presence checks and `Object.keys` read unchanged.
   */
  const [memberAccess, setMemberAccess] = useState<Record<string, true>>({})

  /**
   * Every ACTIVE workspace member, Workspace Admins INCLUDED — the reversed half of §2.1 (see the
   * file docblock). The exclusion that used to live on this line
   * (`m.roleSlug !== 'workspace_admin'`) removed a Workspace Admin from BOTH the Team Lead options
   * and this table, which is precisely what the ruling reverses: they may be a Team member and that
   * Team's Lead. `status === 'active'` stays — the ruling's own "an active company user" — and the
   * `project_members` half of §2.1 is enforced per ROW below, not by hiding the row.
   */
  /**
   * CANDIDATES ARE ALREADY ELIGIBLE IN THIS PROJECT (`PM-FR-020`, BA 2026-08-22).
   *
   * "Members | Maintained from active users already eligible in the selected Project; Project Access
   * is read-only in this flow." So the create form offers the project's own active members plus the
   * active Workspace Admin — who holds no `project_members` row by §2.1 and is eligible anyway — and
   * NOT the workspace directory it used to list.
   */
  const eligible = wsMembers.filter((m) => {
    if (m.status !== 'active') return false
    if (m.roleSlug === 'workspace_admin') return true
    return projectMembers.some((pm) => pm.userId === m.userId && pm.status === 'active')
  })
  /**
   * Auto-generated from the name while creating, and correctable afterwards.
   *
   * `keyTouched` first in both branches, so what was typed always wins; the stored key is the fallback
   * while editing and the derived suggestion is the fallback while creating. The suggestion is never
   * re-applied to an existing team, which is what keeps a rename from re-keying it silently.
   * `max: 10` is the column's own ceiling (`varchar(10)`) and the server takes `^[A-Z][A-Z0-9]{1,9}$`.
   */
  const key = team
    ? keyTouched || team.key
    : keyTouched || suggestKey(name, { style: 'initials', max: 10 })

  /**
   * A TEAM LEAD MUST BE AN ACTIVE MEMBER OF THIS TEAM (`PM-FR-021`, AC15).
   *
   * "Team Lead must be an active Team member. The Team Lead label grants no separate Project
   * permission or Work Item Owner eligibility." So the options are the team's own roster — the rows
   * ticked in this form while creating, and the stored roster while editing — not the directory. The
   * server refuses the rest (`TEAM_LEAD_NOT_MEMBER`).
   *
   * `memberSelectOption`, so a lead carries the same avatar the member table below draws for the same
   * person, and typing an email finds them.
   */
  const leadCandidateIds = new Set(
    team ? teamMembers.map((m) => m.userId) : Object.keys(memberAccess),
  )
  const leadOptions: SelectOption[] = wsMembers
    .filter((m) => m.status === 'active' && leadCandidateIds.has(m.userId))
    .map((m) => memberSelectOption(m))
  const valid = name.trim().length >= 2 && /^[A-Z][A-Z0-9]{1,9}$/.test(key)

  /**
   * Toggling a row includes or excludes it, and that is now the WHOLE decision.
   *
   * It used to also pick a project access LEVEL for the row — carrying an existing Admin across and
   * promoting anyone else to Editor, Rally's own team-membership rule. `PM-FR-021` ends that: "Adding
   * or removing a Team member never creates or changes Project Access", and the candidates are users
   * who already hold a level, so there is nothing left to decide or to write.
   */
  function toggleMemberRow(userId: string) {
    setMemberAccess((prev) => {
      const next = { ...prev }
      if (userId in next) delete next[userId]
      else next[userId] = true
      return next
    })
  }

  async function handleSave() {
    if (!valid) return
    if (team) {
      // No projectIds — links are not this modal's concern. The key IS sent: it is the only way to
      // correct one that a rename left behind, and it is only ever what the reader typed.
      updateTeam.mutate(
        { name: name.trim(), key, leadId: leadId ?? null },
        {
          onSuccess: () => {
            notify.success('Team updated')
            onClose()
          },
          onError: (e) => notify.fromError(e, 'Failed to update team'),
        },
      )
      return
    }
    try {
      await createTeam.mutateAsync({
        workspaceId: workspaceId ?? '',
        name: name.trim(),
        key,
        leadId: leadId ?? null,
        // No project picker (mockup parity): the tab's project IS the context.
        projectIds: [projectId],
        memberUserIds: Object.keys(memberAccess),
      })
      // No access sync: `PM-FR-021` forbids this flow from touching Project Access, and every
      // candidate already holds a level (that is what made them eligible).
      notify.success('Team created')
      onClose()
    } catch (e) {
      notify.fromError(e, 'Failed to create team')
    }
  }

  const pending = createTeam.isPending || updateTeam.isPending || setAccess.isPending

  return (
    <AppModal open onClose={onClose} title={team ? 'Edit team' : 'Create team'} width={460}>
      <ModalBody className="space-y-4">
        <FormField label="Team name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Core Platform"
          />
        </FormField>
        <FormField label="Team key" hint="2–10 uppercase letters/numbers" required>
          <Input
            value={key}
            onChange={(e) =>
              setKeyTouched(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, '')
                  .slice(0, 10),
              )
            }
            placeholder="CP"
            className="font-mono"
          />
        </FormField>
        <FormField label="Team lead">
          <SearchableSelect
            variant="field"
            value={leadId ?? ''}
            ariaLabel="Team lead"
            placeholder="Unassigned"
            options={leadOptions}
            onChange={(v) => setLeadId(v as string | null)}
          />
        </FormField>
        {!team && eligible.length > 0 && (
          <FormField
            label={
              <div className="flex items-center justify-between gap-2">
                <span>{t('teams.membersAndAccess')}</span>
                <span className="text-ui-xs font-normal text-foreground-subtle">
                  {t('teams.membersAndAccessHint')}
                </span>
              </div>
            }
          >
            <div className="rounded-lg border border-border-subtle">
              <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-hover px-3 py-2 text-ui-xs font-semibold tracking-wide text-foreground-subtle uppercase">
                <span className="w-5" />
                <span className="flex-1">{t('teams.colUser')}</span>
                <span className="w-20 text-center">{t('teams.colCurrentAccess')}</span>
                <span className="w-32 text-center">{t('teams.colNewAccess')}</span>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {eligible.map((m) => {
                  const currentLevel =
                    projectMembers.find((pm) => pm.userId === m.userId)?.accessLevel ?? null
                  const checked = m.userId in memberAccess
                  const label = m.displayName ?? m.email ?? m.userId
                  const isWorkspaceAdmin = m.roleSlug === 'workspace_admin'
                  return (
                    <div
                      key={m.userId}
                      className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0"
                    >
                      <span className="flex w-5 justify-center">
                        <SelectionCheckbox
                          checked={checked}
                          onChange={() => toggleMemberRow(m.userId)}
                          ariaLabel={`Add ${label} to this team`}
                        />
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <OwnerAvatar name={label} size={20} />
                        <span className="truncate text-ui-sm text-foreground">{label}</span>
                      </span>
                      {/* The badge stands where the level would be — the ruling's "never as Admin
                          or Editor". For a Workspace Admin `currentLevel` is null by construction
                          (§2.1 keeps them out of `project_members`), so printing `No Access` here
                          would state the opposite of the truth about the most privileged principal
                          in the workspace. */}
                      <span className="flex w-20 justify-center text-center text-ui-xs text-foreground-subtle">
                        {isWorkspaceAdmin ? (
                          <WorkspaceAdminBadge />
                        ) : currentLevel ? (
                          <span className="capitalize">{currentLevel}</span>
                        ) : (
                          t('teams.memberNoAccess')
                        )}
                      </span>
                      <span className="w-32">
                        {isWorkspaceAdmin ? (
                          /* No select, deliberately: `canEdit={false}` on a level picker is one
                             prop away from `true`, and there is no state in which writing this row
                             a level is legal. Same reasoning as the deleted `ProjectSelectCell`. */
                          <span
                            className="block text-center text-ui-xs text-foreground-subtle"
                            title={t('teams.memberNoLevelWrittenHint')}
                          >
                            {t('teams.memberNoLevelWritten')}
                          </span>
                        ) : checked ? (
                          /* PROJECT ACCESS IS READ-ONLY IN THIS FLOW (`PM-FR-021`, BA 2026-08-22):
                             "Adding or removing a Team member never creates or changes Project
                              Access." The level select wrote one, so the cell states the membership
                             it IS about instead. The access level beside it is the existing grant,
                             which is now the PRECONDITION for being offered at all. */
                          <span className="block text-center text-ui-xs text-foreground-subtle">
                            {t('teams.memberWillJoin')}
                          </span>
                        ) : (
                          <span className="block text-center text-ui-xs text-foreground-subtle opacity-60">
                            {t('teams.memberNotAdded')}
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </FormField>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={!valid || pending} onClick={handleSave}>
          {pending && <Loader2 size={12} className="animate-spin" />}
          {team ? 'Save' : 'Create team'}
        </Button>
      </ModalFooter>
    </AppModal>
  )
}
