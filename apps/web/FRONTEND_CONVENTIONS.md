# Rova Web — Frontend Conventions

The rules that keep the UI consistent as the app scales. Enforced by lint + the
ratchet tests in `src/test/fe-consistency.ratchet.test.ts`. Companion to
`FRONTEND_COMPONENT_AUDIT.md` (the why) — this file is the how.

> **Golden rule:** one component owns each pattern. **Pages compose; they never
> re-derive.** If you're about to hand-roll a button, tab bar, modal, grid
> header, status pill, or section card — stop, it already exists in `shared/ui`.

---

## 1. Architecture (Feature-Sliced Design)

Layers, highest → lowest. Import only **downward** (enforced by
`eslint-plugin-boundaries`):

```
app · pages · widgets · features · entities · shared
```

- **Pages are composition only.** No page-level component, modal, schema, or
  domain helper defined inside a `*-page.tsx`. Extract to `pages/<x>/ui/` and
  `pages/<x>/model/`.
- **No sideways slice imports.** A `features/a` slice must not import from
  `features/b`. Shared cross-feature data (members, teams) belongs in `entities`
  or `shared`, consumed through a slice's public `index.ts`.
- Every slice exposes a public API via `index.ts`; import the barrel, not deep paths.

## 2. File size

- Soft budget **300 lines**, hard cap **500**. The ratchet forbids any file
  growing past today's worst (2964) and that ceiling only comes down.
- One component per file. A file that defines 3+ components is a folder waiting
  to happen.

## 3. Components — use the shared primitive

| Need             | Use                                                                  | Never                                                       |
| ---------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Any button       | `Button` (`shared/ui/button`)                                        | raw `<button>`                                              |
| Icon-only action | `IconButton` (`shared/ui/icon-button`)                               | raw `<button>` + inline icon                                |
| Tabs             | `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` (`shared/ui/tabs`)     | hand-rolled active-underline `<button>`s                    |
| Modal            | `AppModal` + `ModalBody`/`ModalFooter`                               | `fixed inset-0` divs, `dialog.tsx`                          |
| Confirm delete   | `ConfirmDialog`                                                      | `window.confirm()`, inline confirm buttons                  |
| Multi-select     | `SelectionModal`                                                     | bespoke list + checkboxes                                   |
| Section / panel  | `Card` + `CardHeader`/`CardBody`                                     | `rounded bg-white border` blocks                            |
| Data grid        | `DataTableFrame` + one `ColumnSpec[]`                                | raw `<table>`, bespoke flex-grids, direct `DataTableHeader` |
| Status pill      | `StatusBadge` (+ a feature `status-colors` map)                      | inline `<span>` pills                                       |
| Row of KPIs      | `MetricStrip` + `MetricCard`                                         | hand-rolled metric tiles                                    |
| Empty / error    | `EmptyState`                                                         | centered `<div>` + text                                     |
| Loading          | `Spinner`/`PageSpinner`/`InlineSpinner`                              | inline `<Loader2 className="animate-spin"/>`                |
| Page header      | `PageHeader` / `PageToolbar`                                         | hand-rolled header bars                                     |
| Pagination       | `PaginationFooter` (+ `useClientPagination` / `useCursorPagination`) | bespoke prev/next footers                                   |
| Select / date    | `NativeSelect`/`InlineSelect`                                        | raw `<select>` / `<input type=date>`                        |
| Toast            | `notify` (`shared/lib/toast`)                                        | `import { toast } from 'sonner'` in a page                  |

## 4. Styling & tokens

- **Colour comes from tokens**, never raw hex/rgb (`no-raw-hex.ratchet` = 0).
  Prefer a Tailwind token utility (`text-foreground-subtle`, `bg-surface-hover`,
  `border-border-strong`); use `BRAND.*` inline only when the value is
  computed/data-driven (a status swatch, a `width:${pct}%`, SVG paint).
- **No static-colour inline `style={{}}`.** `style={{ color: BRAND.textMuted }}`
  → `className="text-muted-foreground"`. Inline style is for dynamic values only.
- **Type size comes from the scale.** Use `text-ui-xs … text-ui-xl` (11–15px,
  defined in `globals.css @theme`), never arbitrary `text-[11px]`.
  - 11px `text-ui-xs` · 12px `text-ui-sm` · 13px `text-ui-md` · 14px `text-ui-lg`
    · 15px `text-ui-xl`
  - **11px is the floor, and `text-ui-2xs` (9px) no longer exists.** The scale moved
    up one step on 2026-08-20 — 68% of the app's text had been 11px or smaller — and
    the token was retired rather than left defined, so it cannot return one class at
    a time. `type-scale.test.ts` pins the px values, the floor and its absence.
- **A clickable target is at least 24×24 CSS px** (WCAG 2.5.8 AA), and the floor is
  defined ONCE in `shared/ui/target-size.ts`. Compose `TARGET_SQUARE` on an icon-only
  control and `TARGET_HEIGHT` on a labelled one — never write the literal again;
  `type-scale.test.ts` fails if a second copy appears in `shared/ui`. `Button` and
  `IconButton` already carry it, so reaching for a primitive gets it for free.
  - It is a px literal inside that module on purpose: `min-h-6` is a rem, and the root
    resolves to 14px, so it would land at 21px — under the floor it exists to hold.
  - `TARGET_HEIGHT` alone is right where 2.5.8's SPACING exception already applies (the
    drag grip and expand chevron in a 34px grid row). Widening those would move every
    grid's gutter to satisfy a criterion that is already met.
- **The root font size is `87.5%`, never a px value** (`globals.css`). A percentage
  scales with the reader's own browser font-size preference; an absolute px root
  discards it, which is what the literal `14px` here used to do.
- **Dark mode is automatic** via CSS-var flipping — never write `dark:` variants,
  and never hardcode `bg-white`/`text-white` (use `bg-card`/`bg-input-background`).
- Compose classes with `cn()` from `shared/lib/utils`.

## 5. Shared logic — reuse the hook

| Need                          | Hook                                                        | Location           |
| ----------------------------- | ----------------------------------------------------------- | ------------------ |
| Modal/popover open state      | `useDisclosure`                                             | `shared/lib/hooks` |
| Grid sort (toggle field/dir)  | `useTableSort`                                              | `shared/lib/hooks` |
| Server cursor pagination      | `useCursorPagination`                                       | `shared/lib/hooks` |
| Client offset pagination      | `useClientPagination`                                       | `shared/lib/hooks` |
| Auto-save field FSM           | `useSaveState`                                              | `shared/lib/hooks` |
| Row selection                 | `useRowSelection`                                           | `shared/lib/hooks` |
| Column layout / resize / drag | `useColumnLayout` / `useResizableColumns` / `useColumnDrag` | `shared/lib/hooks` |
| Date formatting               | `formatDate` / `formatDateTime` / `relativeTime`            | `shared/lib/utils` |
| Error → message               | `errorMessage` / `notify.fromError`                         | `shared/lib/toast` |

Don't re-implement these inline. If you write a `toggleSort` or a `commit<Field>`
handler, check the table above first.

## 5a. Two feeds per entity — a picker never reads an administrative list

**An endpoint that returns a field a participant may not see is ADMINISTRATIVE, and it must not be
the only feed for a picker, a filter or a name lookup.** Every entity that appears in a dropdown has
two reads, with two hooks, two schemas and two gates:

|          | REFERENCE feed                                                                                  | ADMINISTRATIVE feed                                                            |
| -------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| answers  | "which ones are there, and what are they called?"                                               | "what IS this record?"                                                         |
| carries  | id, key, display name, and only what a picker labels/orders/filters by                          | the record — notes, estimates, status, owner, contact details, roles, counts   |
| gate     | the PARENT's own view permission (`project:view`) or a service scope (`listReadableProjectIds`) | the surface's own code (`release:view`, `milestone:view`, `workspace:view`, …) |
| audience | anyone who can see the parent                                                                   | whoever the BA grants that surface                                             |

Hooks today:

| entity           | reference (use in pickers)                 | administrative        |
| ---------------- | ------------------------------------------ | --------------------- |
| project member   | `useProjectMemberOptions`                  | `useProjectMembers`   |
| workspace member | `useWorkspaceMemberOptions`                | `useWorkspaceMembers` |
| release          | `useReleaseOptions` (alias `useReleases`)  | `useReleaseRecords`   |
| milestone        | `useMilestoneOptions`                      | `useMilestones`       |
| iteration        | `useIterationOptions` (assignment options) | `useIterations`       |

**Why this is a rule and not a preference.** It has been violated four times, always the same way:
the administrative read was ALSO the picker feed, so the gate and the picker could not both be right.

- `GET /workspaces/:id/members-with-profile` carried `phone`, `lastLoginAt` and every role id and had
  **no authorization at all**, because gating it would have 403'd the Portfolio and Projects owner
  pickers.
- `GET /projects/:id/members` was then gated correctly (§3.1: Editor Hidden) — and **every project
  Editor saw `Unassigned` on every owned item** on Backlog and Iteration Status, and could not assign
  an owner at all, because the owner's display NAME is resolved by finding the assignee in that array.
- `GET /releases` is `release:view`, which an Editor does not hold, and it labelled the Backlog's
  Release column — so **a row assigned to a real release read as unscheduled**.
- `GET /milestones` is `milestone:view`, same shape, on Iteration Status and the Work Item sidebar.

Three properties make this class invisible, so none of them may be relied on:

1. **A failed request renders as a fact.** `const { data = [] } = useX()` turns a 403 into "there are
   none" — so the gate is never observed to have refused anything.
2. **The dev principal is a Workspace Admin** whose `workspace:*` grants every code, so none of the
   above reproduces locally.
3. **The surface's gate and the feed's gate coinciding is a coincidence**, not an invariant. A picker
   on an admin-only screen still reads the reference feed — the next permission ruling moves one gate
   and not the other.

Rules for writing one:

- **Declare the reference schema separately — never `.pick()`** of the administrative one, and never a
  shared base. A shared base is precisely how a field added for User Management joins the feed every
  participant reads. (`MemberOptionResponseSchema` shipped a fifth field, a person's account
  `status`, while its own docblock said "four display fields and nothing else".)
- **Expose the DECISION, not the state it came from.** A picker needs to know whether it may offer
  someone (`assignable: boolean`), not why it may not (`status: 'suspended'`).
- **A reference feed is unpaged.** A picker offering a page of a project's releases is the defect.
- **If a level can WRITE a reference, it must be able to READ the feed it picks from.** Pinned
  statically by `test/route-audience.ratchet.spec.ts` (`REFERENCE_FEEDS`), and over HTTP by
  `test/e2e/authz-cluster.e2e.spec.ts`. Two pairs are still open and are declared there.
- **Both directions, in tests.** A test that only proves the administrative feed is gated passes when
  you over-restrict — which IS the defect. Assert that a project Editor can read the reference feed.

## 6. i18n

All user-facing copy goes through `t()` (i18next). No hardcoded strings in TSX.
(Currently under-adopted — new/edited code must comply; migration is Phase 4.)

## 7. Accessibility

- Icon-only controls require `aria-label` (`IconButton` enforces it in its type).
- Use native semantics / Radix primitives (focus trap, roving focus, Escape) —
  which is why modals/tabs/menus must come from `shared/ui`, not raw divs.

## 8. Naming

- Dismiss callback is `onClose` (not `onCancel`/`onDismiss`).
- Native a11y attr is `aria-label` (not a custom `ariaLabel` prop).
- Size scale is `sm | md | lg` across components.
- Form controls forward refs.

---

### PR checklist (paste into description)

- [ ] No file > 500 lines; no component defined inside a `*-page.tsx`.
- [ ] No raw `<button>` / `<table>` / `window.confirm` in the diff.
- [ ] Grids use `DataTableFrame` + one `ColumnSpec[]`; modals via `AppModal`; tabs via `Tabs`.
- [ ] No static-colour inline `style`; colours via tokens; sizes via `text-ui-*`.
- [ ] Status via `StatusBadge`; toasts via `notify`; shared logic via the hooks above.
- [ ] Cross-slice imports only through a slice `index.ts`; user strings via `t()`.
- [ ] Ratchet tests still green (counts did not rise).
