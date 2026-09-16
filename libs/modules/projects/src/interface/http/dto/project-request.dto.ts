import { z } from 'zod';
import { PROJECT_ACCESS_LEVEL } from '@shared-kernel';
import { createZodDto } from 'nestjs-zod';
import { ISO_DATE, PageQuerySchema } from '@platform';
import { projectStatusEnum, projectMemberStatusEnum } from '../../../../../../../db/schema/enums';

// ── Estimation Settings (SRS §6.2) ───────────────────────────────────────────
//
// Declared BEFORE CreateProjectSchema because the create body embeds it (§4.2 lists the scale
// among the Create Project fields) — a `const` referenced before its initialiser is a
// runtime TDZ error, not a type error, so the order here is load-bearing.
//
// The per-PROJECT T-shirt → points scale + hours/point, stored in work.project_settings.
// Write side is WA-admin only (`PATCH :id/estimation-settings` carries `workspace:edit`, and
// `POST /projects` carries `project:create`, which the catalogue grants to `workspace_admin`
// alone — so embedding it in the create body widens nothing); readable by anyone who can view
// the project, because every progress bar and capacity figure already derives from it via
// PreliminaryEstimateMapService.forProject(). The full schema is the GET response (defaults
// filled when no row exists); the partial is the PATCH body, so omitted fields keep their
// current value rather than resetting to the default.
export const ProjectEstimationSettingsSchema = z.object({
  xsPoints: z.number().int().min(1),
  sPoints: z.number().int().min(1),
  mPoints: z.number().int().min(1),
  lPoints: z.number().int().min(1),
  xlPoints: z.number().int().min(1),
  // numeric(8,2), CHECK > 0 in migration 0106; the FE steps by 0.5 from 8, but the BE
  // enforces the column's own rule, not the input's UX convenience.
  hoursPerPoint: z.number().positive(),
});

export class ProjectEstimationSettingsDto extends createZodDto(ProjectEstimationSettingsSchema) {}

export const UpdateProjectEstimationSettingsSchema = ProjectEstimationSettingsSchema.partial();
export class UpdateProjectEstimationSettingsDto extends createZodDto(
  UpdateProjectEstimationSettingsSchema,
) {}

// ── Create Project ───────────────────────────────────────────────────────────

export const CreateProjectSchema = z.object({
  /**
   * 2-10 UPPERCASE letters/numbers, starting with a letter, immutable after creation
   * (`UpdateProjectSchema` carries no key) — Phase 1/08 §8.2's field table, and the same rule
   * `CreateTeamSchema` already enforced for a Team key.
   *
   * The case half was the gap: this accepted `[A-Za-z]` and stored whatever arrived, while the SPA
   * upper-cases every keystroke. So the only way to get a lowercase key was to bypass the form, and
   * the result reads as a different project everywhere a key is displayed — `nxp` beside `NXP` — for
   * a value the SRS makes immutable, so it could never be corrected in place.
   */
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(
      /^[A-Z][A-Z0-9]*$/,
      'Key must be 2-10 uppercase letters/numbers, starting with a letter',
    ),
  name: z.string().trim().min(2).max(255),
  description: z.string().max(2000).trim().optional(),
  leadId: z.string().uuid().optional(),
  startDate: ISO_DATE.optional(),
  endDate: ISO_DATE.optional(),
  teamIds: z.array(z.string().uuid()).optional(),
  /**
   * §4.2: the Estimation Settings are Create Project fields. They used to reach the database
   * through a SECOND request — a best-effort `PATCH :id/estimation-settings` the SPA skipped
   * whenever the six values still equalled the defaults, and swallowed on failure — so the
   * common path wrote no `work.project_settings` row at all.
   *
   * Optional, and it is the OVERRIDE that is optional rather than the row: `createProject`
   * writes the row unconditionally, from these values or from
   * `DEFAULT_PROJECT_ESTIMATION_SETTINGS`. Present-but-partial is refused (the object is the
   * full schema, not `.partial()`) — a half-specified scale is a mistake, not a merge, and the
   * PATCH route is where partial edits belong.
   */
  estimationSettings: ProjectEstimationSettingsSchema.optional(),
});

export class CreateProjectDto extends createZodDto(CreateProjectSchema) {}

// ── Update Project ───────────────────────────────────────────────────────────

export const UpdateProjectSchema = z.object({
  /**
   * Correcting a key after a rename. This schema deliberately carried no key, on the SRS rule that
   * a key is immutable after creation — written when a project key prefixed every item id in the
   * project, so changing it would have rewritten every identifier at once.
   *
   * `0036_type_prefixed_item_keys` gave items a type prefix (`US-1`) and `0060` moved the counters
   * to the workspace. No item key has contained a project key since, so the rule outlived its
   * reason, and what remained was a name that could be edited beside a key derived from it that
   * could not — leaving `OBSE` on a project called `Infrastructure` with no supported way to fix it.
   *
   * Optional, and never inferred from a rename: a key is displayed beside the name, in the project
   * switcher and in search, and some are chosen rather than derived, so regenerating one from a new
   * name would overwrite a deliberate value. Same shape as create, and uniqueness is re-checked
   * there, since the constraint is per workspace.
   */
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Key must be 2-10 uppercase letters/numbers, starting with a letter')
    .optional(),
  name: z.string().trim().min(2).max(255).optional(),
  description: z.string().max(2000).trim().optional().nullable(),
  leadId: z.string().uuid().optional().nullable(),
  startDate: ISO_DATE.nullable().optional(),
  endDate: ISO_DATE.nullable().optional(),
  status: z.enum(projectStatusEnum.enumValues).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export class UpdateProjectDto extends createZodDto(UpdateProjectSchema) {}

// ── Pagination query ─────────────────────────────────────────────────────────

export const ProjectQuerySchema = PageQuerySchema;

export class ProjectQueryDto extends createZodDto(ProjectQuerySchema) {}

// ── Member-options query (GAP-P1-WID-007) ────────────────────────────────────
//
// `teamId` narrows the assignee feed to that Team's ACTIVE roster: "Selected Team offers Unassigned
// plus its ACTIVE MEMBERS; No Team offers only Unassigned." OPTIONAL, and absent deliberately means
// the whole project — the same feed still resolves an owner's NAME on grids where a row's owner may
// no longer be on the team, and narrowing that would reprint them as `Unassigned`.
export const MemberOptionsQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
});

export class MemberOptionsQueryDto extends createZodDto(MemberOptionsQuerySchema) {}

// ── Labels ───────────────────────────────────────────────────────────────────

export const CreateLabelSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex code like #3b82f6')
    .optional(),
});

export class CreateLabelDto extends createZodDto(CreateLabelSchema) {}

export const UpdateLabelSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex code like #3b82f6')
    .optional(),
});

export class UpdateLabelDto extends createZodDto(UpdateLabelSchema) {}

// ── Set Project Access (level + Teams, one write) ─────────────────────────────
//
// PRJ-08 / §5.1-§5.2: the access level and the Teams it is scoped to arrive TOGETHER, because
// "an Editor must be assigned to at least one active Team" (§2.2) is only decidable when they do.
// This body used to be an INLINE `{ userId: string; accessLevel?: ProjectAccessLevel }` on the
// handler, which Swagger cannot see — so the generated SPA client typed the body as `never` and
// every caller cast through `as never`. A real schema is what makes the combined contract visible
// to the client at all.
export const SetProjectAccessSchema = z.object({
  userId: z.string().uuid(),
  /**
   * Optional, and it is the LEVEL that is optional rather than the row: a `project_members` row with
   * a NULL level is legitimate (§2.2's team-derived membership), and omitting it here leaves whatever
   * level the row already carries rather than clearing it.
   */
  accessLevel: z.enum(PROJECT_ACCESS_LEVEL).optional(),
  /**
   * The teams of THIS project the user should end up on, reconciled as a SET.
   *
   * Absent means "leave the memberships alone" — not "remove them all", which is what `[]` means. The
   * distinction is load-bearing: for an Editor, `[]` is exactly the state PRJ-08 refuses, while
   * absent is an ordinary bare level change judged against the teams they already hold.
   */
  teamIds: z.array(z.string().uuid()).optional(),
});

export class SetProjectAccessDto extends createZodDto(SetProjectAccessSchema) {}

// ── Update Project Member ─────────────────────────────────────────────────────

export const UpdateProjectMemberSchema = z.object({
  accessLevel: z.enum(PROJECT_ACCESS_LEVEL).optional(),
  status: z.enum(projectMemberStatusEnum.enumValues).optional(),
});

export class UpdateProjectMemberDto extends createZodDto(UpdateProjectMemberSchema) {}
