# Rova Web — Frontend Component & Consistency Audit

**Scope:** `apps/web` (React 19, Vite, TanStack Router/Query/Table/Virtual, Tailwind 4, Zustand, react-hook-form + Zod, i18next, shadcn-style primitives, Feature-Sliced Design).
**Method:** full read of all 19 pages + `shared/ui`, `features`, `entities`, `widgets`, design tokens, and lint/CI config. 87 `.tsx` files, ~18k lines of page code.

---

## 1. TL;DR — the one-sentence diagnosis

> **The infrastructure is good. The adoption discipline is not.**

Rova already has a well-designed design-token system (CI-enforced), a headless table engine, and ~40 shared UI primitives. The inconsistency you feel does **not** come from a missing foundation — it comes from **pages being allowed to bypass that foundation**: monolithic page files, hand-rolled copies of components that already exist, inline styling instead of tokens, and no enforcement stopping any of it.

This is a **governance + refactor problem, not a rebuild.** Do not throw anything away. Close the gaps, force adoption with lint, and decompose the monoliths.

### The single most important number

| File                        | Lines                             |
| --------------------------- | --------------------------------- |
| `settings-page.tsx`         | 2,964                             |
| `iteration-status-page.tsx` | 2,669                             |
| `work-item-detail-page.tsx` | 1,624                             |
| **Top 3 combined**          | **7,257 (~40% of all page code)** |

Three files hold 40% of the page code. `settings-page.tsx` alone is one file with **20+ components, schemas, and helpers** inline. Fixing decomposition on ~5 files fixes most of the pain.

---

## 2. Per-page scorecard

Legend — Table: ✅ full shared frame · 🟡 engine only, hand-rolled chrome · ❌ bespoke/no engine. Sev: 🔴 high · 🟠 med · 🟢 ok.

| Page              |  LOC | Inline `style` | Raw `<button>` |      Table       | Headline problems                                                                                 | Sev |
| ----------------- | ---: | -------------: | -------------: | :--------------: | ------------------------------------------------------------------------------------------------- | :-: |
| settings          | 2964 |            184 |             16 | ❌ 5 fake tables | 20+ components in 1 file; 6 hand-rolled empties; 6 loaders; `['system-roles']` query ×3           | 🔴  |
| iteration-status  | 2669 |             91 |            15+ |        🟡        | `AZ` palette **fork** + `Segoe UI`/`Consolas` fonts; commit-handlers dup; 8+ subcomponents inline | 🔴  |
| work-item-detail  | 1624 |             55 |              7 |  🟡 + 2 bespoke  | `window.confirm()` for delete; History/Defects roll own CSS-grid tables; tabs hand-rolled         | 🔴  |
| quality           | 1181 |             21 |              0 |        🟡        | hand-rolled chrome; status coloring not via StatusBadge                                           | 🟠  |
| projects          | 1080 |             43 |              4 |        🟡        | hand-rolled chrome; column-spec pattern copied from releases                                      | 🟠  |
| backlog           | 1019 |            ~30 |              2 |        🟡        | 4 parallel column `Record`s + 3 derived arrays; `BacklogRow` 280 lines                            | 🟠  |
| releases          |  965 |             38 |              4 |        🟡        | 8 copy-paste inline-edit inputs; `ReleaseRow` 324 lines; detail-modal dupes detail-page           | 🟠  |
| iterations        |  937 |             47 |              5 |        ❌        | does **not** use `useDataTable`; 2nd raw `<table>`; hand-rolled pagination                        | 🔴  |
| team-status       |  880 |             39 |              5 |        ✅        | **reference impl** — the only `DataTableFrame` user                                               | 🟢  |
| releases-detail   |  759 |             72 |              3 |        ❌        | imports almost no shared layout; hand-rolls StatusBadge/pagination/metrics/header                 | 🔴  |
| milestones-detail |  728 |             53 |             ~5 |   (delegates)    | `PaginationFooter` reimplemented from scratch; inline status pills ×2                             | 🟠  |
| reports           |  702 |             28 |              1 |        ❌        | no table module; chart fills as raw `rgba()`                                                      | 🟠  |
| milestones        |  593 |            ~15 |              4 |        🟡        | **best factored**; but delete = inline Confirm/Cancel buttons; raw `<select>`                     | 🟢  |
| portfolio         |  494 |             25 |              1 |        ❌        | no shared header/table; hand-rolled grid                                                          | 🟠  |
| home              |  487 |             39 |              0 |        —         | local date formatting; status coloring hand-rolled                                                | 🟢  |
| login             |  334 |             29 |              2 |        —         | **only file with hardcoded hex (5)**; imports **zero** shared/ui                                  | 🟠  |
| notifications     |  148 |              6 |              2 |        —         | small, mostly clean                                                                               | 🟢  |

**Totals:** raw `<button>` ≈ 60+ across pages; inline `style={{}}` = **1,070** app-wide (730 carry color/background).

---

## 3. What is already good — do NOT rebuild these

Protect these; they are the spine of the target system.

1. **Design tokens (exemplary).** `src/app/styles/globals.css` — ~90 CSS vars + full `.dark` overrides + `@theme inline`, mirrored as typed `BRAND.*` in `src/shared/config/brand.ts`. Sync is CI-guarded (`brand-palette-sync.test.ts`). Radius scale exists.
2. **Hex ratcheted to zero.** `no-raw-hex.ratchet.test.ts` enforces `MAX_RAW_HEX=0` (migrated 732 → 0). Only exemption: the login SSO logo (5).
3. **Dark mode is architecturally correct.** Zero `dark:` variants in TSX — dark mode works purely by flipping CSS vars, so every token-backed style adapts for free.
4. **FSD vertical boundaries enforced.** `eslint-plugin-boundaries` blocks upward imports (`error`). No layer violations found.
5. **Headless table engine is real and adopted.** `table/use-data-table` + `ColumnSpec` used by 8/8 grid pages. Clean API.
6. **Single `cn()`** (`twMerge(clsx())`), 39 uses, zero direct `twMerge`/`clsx`.
7. **Modal layering is correct where used.** `AppModal` is canonical; `ConfirmDialog` and `SelectionModal` are correctly built on top of it.
8. **`milestones-page.tsx` and `team-status-page.tsx` are the reference implementations** — copy their patterns.

---

## 4. Root causes (fix these, not just the symptoms)

**RC-1 — No decomposition rule.** Nothing stops a page from growing to 2,964 lines with 20 components inline. There is no file-size lint, no "one component per file" convention, no per-slice folder structure for pages.

**RC-2 — Adoption is optional.** The shared components exist but nothing forces their use. `DataTableFrame` (1 user), `PageHeader` (3), `Tabs` (doesn't exist), `Button` (bypassed 60+ times), `EmptyState`, `Spinner`, `ConfirmDialog` — all routinely re-hand-rolled because the lint allows it and the alternative is one `<div>` away.

**RC-3 — Inline-style-first authoring culture.** 1,070 `style={{}}` objects. Even when they reference `BRAND.*` (token-backed, so they _work_), they are verbose, un-mergeable, un-lintable, and invite drift (`AZ` palette fork, `Segoe UI`, raw `rgba()`, `bg-white`). The token system is bypassed _at the point of use_ even though the tokens are excellent.

---

## 5. Findings by system

### 5.1 Monolithic pages (🔴 top priority)

- 5 files >900 lines each hold multiple page-level components, modals, schemas, and domain helpers inline.
- `settings-page.tsx`: `ProfileTab`, `MembersTab`, `WorkspaceSettingsTab`, `ProjectSettingsTab`, `WorkflowTab`, `LabelsTab`, `TeamsTab`, `AuditLogTab`, `RolesTab` + ~10 modals — all one file.
- `iteration-status-page.tsx`: `StatusRow` (575 lines), `ChildTaskRow` (270), `MilestoneSelectCell` (200), plus 6 more — one file.
- **Consequence:** every consistency fix touches a 2,000-line file, so it doesn't happen, so pages drift further. This is the mechanical cause of "I have to fix too much."

### 5.2 Table subsystem — engine adopted, chrome abandoned

- `useDataTable` engine: 8/8 grids ✅.
- `DataTableFrame` chrome shell: **1/8** (team-status only). The other 7 import `DataTableHeader` directly and re-hand-assemble scroll region + `SkeletonList` + totals + footer — the exact drift the frame's own docstring says it prevents.
- **3 table idioms coexist:** shared `useDataTable` div-grid · bespoke flex-div grid (`iterations` list) · raw `<table>` (`iterations` IterationScope, `work-item` History/Defects, `entities/.../artifact-table.tsx`).
- Column defs fragmented: `backlog` has 4 parallel `Record<ColumnKey,…>` + 3 derived arrays; `iteration-status` has `ITERATION_STATUS_COLUMNS` **and** a duplicate `HEADER_META`. Intended shape is a single `ColumnSpec[]` (milestones/work-item do this right).

### 5.3 Buttons — canonical component, 60+ bypasses

- `button.tsx` is documented "single source of truth" (6 variants × 4 sizes). Yet 60+ raw `<button>` across pages.
- **Missing primitive: `IconButton`.** The same `rounded p-1 disabled:opacity-30 style={{color:BRAND.textMuted}}` icon button is hand-written ~8× in settings alone, and across every row-actions cell (edit/delete/reorder).

### 5.4 Modals & confirmation — 3 ways to confirm a delete

- `ConfirmDialog` (iteration-status) vs **`window.confirm()`** (work-item `:1339`, releases `:846`) vs **inline Confirm/Cancel buttons** (milestones `:383`). Pick one.
- `dialog.tsx` (shadcn primitive, 156 lines) is **dead code** — imported by nobody. Delete or converge on it.
- `InvitePanel` (settings `:925`) hand-rolls a modal instead of `AppModal`.

### 5.5 Missing primitives → hand-rolled everywhere (highest-frequency gaps)

| Missing                          | Hand-rolled in                                                                 | Cost                                          |
| -------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| **Tabs**                         | work-item, releases-detail, milestones-detail, iteration-status, settings (5+) | 5 different tab-bar idioms                    |
| **DropdownMenu / Popover**       | app-shell (×4), iteration-picker, column-fields-menu, notification-popover     | outside-click + Escape re-coded per site      |
| **Card / Panel** (section shell) | attachment-block, rich-text-editor, ~12 pages                                  | `rounded bg-white border + header` copy-paste |
| **Toast wrapper**                | `sonner` imported raw in 17 dirs                                               | no shared variants/config                     |
| **ProgressBar**                  | metric-card, iteration-board, milestones-detail                                | reinvented inline                             |
| **FilterBar**                    | every grid page                                                                | filter dropdowns hand-rolled                  |

### 5.6 Two parallel status/badge systems

- System A: `shared/config/status-colors.ts` → `StatusStyle {bg,text,border,label}` → `<StatusBadge>`; feature-owned maps (releases/milestones/projects/iterations).
- System B: `entities/work-item/model` `*_CONFIG {color,bg,icon,label}` → `entities/.../badges.tsx` (`TypeBadge`/`SeverityBadge`/`ScheduleStateBadge`/`PriorityBadge`).
- Two conventions, two prop shapes. Plus **hand-rolled inline pills** bypassing both (iteration-status `DefectStatusPill` + Block pill; milestones-detail header/sidebar; settings "you"/"Default"/"System"/"Lead"/count pills). Pages not using either system for status color: home, team-status, quality, portfolio, reports, notifications, login.

### 5.7 Styling / tokens — the authoring-culture leak

- **1,070 inline `style={{}}`** (730 color/bg). Worst: settings 184, iteration-status 91, releases-detail 72, app-shell 69, work-item 55.
- **594 arbitrary `text-[Npx]`, 18 distinct sizes, NO typography token.** 5 sizes (9–13px) cover 551 of them — a de-facto scale that must be tokenized. **This is the single largest and least-controlled axis.**
- **49 raw `rgba()`** bypass tokens (app-shell 22 white-opacity, login 9, reports chart fills, shadow literals).
- **93 `bg-white`/`text-white`** literals (incl. shared `form-tokens.ts` `FIELD_CLS`) = **dark-mode holes** — form inputs stay white in dark mode.
- `iteration-status` `AZ` palette alias + `Segoe UI` + `Consolas ×10` = a per-page theme fork. `onMouseOver/Out` JS hover instead of Tailwind `hover:`. Raw `bg-gray-50/100`.
- Spacing/radius are clean — not a concern.

### 5.8 Duplicated logic (extract to hooks/utils)

- `toggleSort` copy-pasted **4×** (backlog, work-item, iteration-status, iterations) → `useTableSort`.
- Cursor-pagination state machine **2×** (backlog, milestones-detail) → `useCursorPagination`.
- Inline commit-handlers (`commitTitle`/`commitEstimate`/`commitTodo`/`handleOwnerChange`…) near-verbatim across `StatusRow` + `ChildTaskRow` + `TaskRow` + `BacklogRow` → `useInlineFieldSave`.
- `relativeTime()` redefined in `comment-thread.tsx:23`, shadowing `shared/lib/utils.ts:9`.
- `formatAuditTime` (settings) reimplements imported `formatDateTime`. No shared date formatter — home/settings/releases format locally.
- `['system-roles']` query defined **3×** in settings → `useSystemRoles`.
- `canManage = can(x)||can(y)||can(z)` duplicated across both release files.
- `RELEASE_STATES` + `STATUS_STYLE` alias + state-select `<option>` body duplicated across releases-page and releases-detail.

### 5.9 FSD & module boundaries

- Vertical boundaries enforced ✅. **But same-layer (horizontal) slice isolation is not** — `features/work-items` imports `features/teams` (`useProjectMembers`, `useProjectTeams`) freely. Shared cross-feature data (members/teams) belongs in a lower layer (`entities`) or must go through a slice public API.
- **No per-slice public API.** Only 1 `index.ts` barrel in all of `src` (the table one). Imports are deep paths; there is no `@/shared/ui` barrel and no `features/x` public surface — so nothing controls what a slice exposes.

### 5.10 Naming / API inconsistency

- `ariaLabel` (custom camelCase, 9 files) vs native `aria-label` (18 files).
- Dismiss callback: `onClose` vs `onCancel` vs `onClear` — same concept, 3 names.
- Size scales differ per component (Button `md/sm/xs/icon`; Spinner/EmptyState `sm/md/lg`; KeyChip `sm/md`; avatars raw px).
- `forwardRef` inconsistent: `native-select`/`row-gutter` forward refs; `input`/`textarea` don't.
- Select nullability: `entity-select-field` emits `''`; `OwnerSelectCell` emits `string | null` — two contracts for the same concept.
- `i18next` installed with 117 locale lines but **`t()` used in 0/17 pages** — all copy hardcoded.

---

## 6. Target component system

The canonical library, split into "keep", "harden", and "build". This is the reference every page must draw from.

### 6.1 Layer contract (make it explicit and enforced)

```
app        router, providers, global styles              (composes everything)
pages      route screens = thin composition only         (NO domain components inline)
widgets    cross-feature blocks (app-shell, boards)
features   one business capability per slice; public API via index.ts
entities   domain models + domain-bound UI (work-item badges, cells)
shared     framework-agnostic: ui/ lib/ config/ api/ i18n/  (knows nothing above it)
```

Rules: import only downward **and** never sideways across slices except through a slice's `index.ts` public API.

### 6.2 `shared/ui` — keep (already good)

Button, Input, Textarea, NativeSelect (+Inline variants), FormField, Skeleton, Spinner, EmptyState, AppModal (+ModalBody/Footer), ConfirmDialog, SelectionModal, StatusBadge, PageHeader, PageToolbar, PaginationFooter, MetricCard, MetricStrip, SearchInput, ColumnFieldsMenu, KeyChip, Avatar, InlineEditableCell, BulkActionBar, SaveIndicator, Tooltip, `table/use-data-table`, `table/data-table-frame`, `table/use-row-rerank`.

### 6.3 `shared/ui` — harden / consolidate

| Action                                             | Detail                                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Delete `dialog.tsx`**                            | dead code; `AppModal` is canonical                                                                                                                                          |
| **Promote `DataTableFrame` to the only grid path** | migrate the 7 stragglers; forbid direct `DataTableHeader` import from pages via lint                                                                                        |
| **Merge select variants**                          | `NativeSelect`/`InlineSelect`/`InlineCellSelect` + `OverlaySelectField` + `OwnerSelectCell` → one `<Select>` family with a single overlay impl and one nullability contract |
| **Merge avatars**                                  | `Avatar` + `OwnerAvatar` → one `Avatar` (initials + optional image); one initials function                                                                                  |
| **Unify status systems**                           | one `StatusStyle {bg,text,border,icon?,label}`, one `<StatusBadge>`; feature maps feed it; retire `entities` `*_CONFIG` second convention or adapt it into StatusStyle      |
| **Tokenize typography**                            | add `--text-xs…2xl` to `@theme`; codemod 594 `text-[Npx]` → scale utilities                                                                                                 |
| **Fix dark-mode holes**                            | replace `bg-white`/`text-white` in `form-tokens.ts` + inputs with `bg-card`/`bg-input-background`                                                                           |

### 6.4 `shared/ui` — BUILD (missing primitives, in priority order)

1. **`Tabs`** (headless, keyboard-accessible) — kills 5 hand-rolled tab bars.
2. **`DropdownMenu` / `Popover`** (Radix, single outside-click+Escape impl) — kills ~6 re-codings.
3. **`IconButton`** — kills the repeated `rounded p-1` icon-button pattern (~30+ sites).
4. **`Card` / `Panel`** (section shell: border + optional header) — kills ~14 copies.
5. **`toast` wrapper** (`shared/lib/toast.ts` over `sonner`) — one config, typed `success/error/info`, kills 17 raw imports and unifies the `err instanceof Error ? …` pattern.
6. **`ProgressBar`** — one impl for metric-card / board / milestones.
7. **`FilterBar`** — declarative filter controls for grids.

### 6.5 `shared/lib` — extract shared hooks/utils

`useTableSort`, `useCursorPagination`, `useInlineFieldSave`, `useDisclosure` (replaces 13 hand-rolled `useState(false)` modal toggles), `useSyncedFormState`, `formatDate`/`formatDateTime`/`relativeTime` (one home), `useSystemRoles`.

---

## 7. Standards to codify (a short `FRONTEND_CONVENTIONS.md`)

1. **One component per file.** Pages are composition only — no page-level subcomponent, modal, schema, or domain helper defined inside a `*-page.tsx`. Extract to `pages/x/ui/` and `pages/x/model/`.
2. **File-size budget:** soft 300, hard 500 lines (lint warns → errors). No file over 500 lines survives review.
3. **Styling order:** Tailwind token utility → shared component → (last resort) inline `style` only for computed/data-driven values (widths, data colors, SVG paint). No static color/spacing inline styles.
4. **Never** `window.confirm`/`alert`; always `ConfirmDialog`.
5. **Never** raw `<button>`; always `Button`/`IconButton`.
6. **Never** raw `<table>` or bespoke grid; always `DataTableFrame` + `ColumnSpec`.
7. **All user-facing copy through `t()`.** No hardcoded strings in TSX.
8. Naming: `aria-label` (native), `onClose` for dismiss, `sm/md/lg` size scale everywhere, form controls `forwardRef`.
9. Column defs: exactly one `ColumnSpec[]` per grid — no parallel `Record` maps.

---

## 8. Governance — make regressions impossible (the part that actually holds the line)

Consistency that isn't enforced decays. Add, in order of ROI:

1. **Ratchet tests** (you already have the pattern for hex — extend it):
   - `raw-button.ratchet` — count `<button` in pages, `MAX` decreasing to 0.
   - `inline-style.ratchet` — count `style={{`, ratchet down.
   - `arbitrary-text-size.ratchet` — count `text-[`, ratchet to 0 after typography tokens land.
   - `file-size.ratchet` — no page file grows; largest allowed shrinks over time.
2. **Lint rules:**
   - `no-restricted-syntax` → ban `window.confirm`, `window.alert`.
   - `no-restricted-imports` → pages may not import `shared/ui/data-table-header` directly (must use frame); ban cross-`features` slice imports (horizontal boundary via `eslint-plugin-boundaries` element `mode: full` + slice patterns).
   - `max-lines` (warn 300 / error 500) on `pages/**`.
   - `no-restricted-syntax` → flag `<button` and static-color `style={{` in `pages/**`.
3. **Per-slice `index.ts` public API** + a barrel `@/shared/ui` so import surface is controlled and codemods are trivial.
4. **A `<StorybookOrGallery>` route** listing every `shared/ui` primitive with variants — makes "does this exist already?" a 5-second check instead of a 0-second `<div>`.

---

## 9. Remediation roadmap (phased, non-blocking)

Sequenced so each phase pays for the next. No big-bang rewrite.

### Phase 0 — Foundation (1 sprint) — _unblocks everything_

- Add typography tokens (`--text-*` in `@theme`).
- Build the 5 top missing primitives: `Tabs`, `DropdownMenu`, `IconButton`, `Card`, `toast` wrapper.
- Delete `dialog.tsx`. Add `useDisclosure`, `useTableSort`, `useCursorPagination`, `useInlineFieldSave`, one date util.
- Write `FRONTEND_CONVENTIONS.md`. Stand up ratchet tests at current counts (freeze the bleeding).

### Phase 1 — Kill the monoliths (2–3 sprints) — _highest pain relief_

- Decompose the top 5: `settings` → `pages/settings/ui/tabs/*` + `model/`; `iteration-status`, `work-item-detail`, `releases`, `iterations`. One component per file.
- While decomposing, swap in shared components (Button/IconButton, Tabs, EmptyState, Spinner, ConfirmDialog). Decompose-and-adopt in the same PR — don't move twice.
- Remove `AZ` palette fork, `Segoe UI`/`Consolas`, `window.confirm`.

### Phase 2 — Table unification (1–2 sprints)

- Migrate 7 pages from direct `DataTableHeader` to `DataTableFrame`.
- Convert `iterations` list, `IterationScope`, work-item History/Defects, and `artifact-table` to the engine.
- Collapse fragmented column defs to single `ColumnSpec[]`.
- Turn on the `no-restricted-imports` frame lint.

### Phase 3 — Styling migration (rolling, codemod-driven)

- Codemod `text-[Npx]` → typography utilities; enable `arbitrary-text-size.ratchet → 0`.
- Codemod static `style={{color:BRAND.x}}` → token utilities; drive `inline-style.ratchet` down.
- Fix `bg-white`/`text-white` dark-mode holes. Add `--sidebar-*`/overlay/shadow tokens for the 49 `rgba()`.

### Phase 4 — Consolidation & polish

- Merge select family, avatars, status systems.
- Unify naming (`aria-label`, `onClose`, size scales).
- Move domain helpers out of pages into features/entities; fix cross-slice coupling via public APIs.
- Wire i18n `t()` across pages (or formally drop i18next if single-locale is the decision).

### Effort/impact summary

| Phase           | Effort      | Pain relief  |
| --------------- | ----------- | ------------ |
| 0 Foundation    | S           | unblocks all |
| 1 Monoliths     | L           | ★★★★★        |
| 2 Tables        | M           | ★★★★         |
| 3 Styling       | M (rolling) | ★★★          |
| 4 Consolidation | M           | ★★           |

---

## 10. Definition of Done (per pattern — paste into PR template)

- [ ] No page file > 500 lines; no component defined inside a `*-page.tsx`.
- [ ] Zero raw `<button>` / `<table>` / `window.confirm` in the diff.
- [ ] All grids use `DataTableFrame` + one `ColumnSpec[]`.
- [ ] All modals via `AppModal`/`ConfirmDialog`/`SelectionModal`; all tabs via `Tabs`; all menus via `DropdownMenu`.
- [ ] No static-color inline `style`; colors via token utilities; no `text-[Npx]`.
- [ ] Status via the single `StatusBadge`; no inline pills.
- [ ] Shared logic via shared hooks (sort/pagination/inline-save/disclosure); no copy-paste.
- [ ] Cross-slice imports only through a slice `index.ts`.
- [ ] User-facing strings via `t()`.

---

_Reference implementations to copy: `team-status-page.tsx` (table), `milestones-page.tsx` (decomposition + modals)._

---

## Appendix A — Visual consistency findings (from the running app, localhost:5173)

Confirmed by inspecting every page live. This is the _felt_ inconsistency, mapped to concrete UI. It corroborates the code audit — the same primitive is rendered differently per page because each page re-implements it.

### A.1 Data-grid header — at least 5 visual variants for one concept

| Page             | Header case   | Sort carets | Row height           | Leading cols  | Row actions                               |
| ---------------- | ------------- | ----------- | -------------------- | ------------- | ----------------------------------------- |
| Backlog          | Title Case    | none        | compact              | ☐ + # + Type  | per-cell inline dropdown                  |
| Iteration-status | Title Case    | ↕ every col | compact              | ☐ + Rank + ID | inline edit + expand                      |
| Defects/Quality  | Title Case    | ↕ every col | compact              | ☐ + # + ID    | per-cell dropdown                         |
| Projects         | **UPPERCASE** | none        | tall (+desc subtext) | Key chip      | **kebab `…` menu**                        |
| Milestones       | **UPPERCASE** | none        | compact              | —             | **inline pencil + trash**                 |
| Team-status      | Title Case    | none        | grouped              | ID            | (truncated headers `Capac…` — width bug)  |
| Home tables      | **UPPERCASE** | none        | comfortable          | ID/Key        | none                                      |
| Releases         | Title Case    | none        | compact              | Name          | **native date input + native `<select>`** |

→ Header case, caret presence, row height, and row-action affordance must be **one** `DataTableFrame` decision, not eight.

### A.2 Row-action affordance — 4 idioms

Kebab `…` (projects) · inline pencil+trash icons (milestones) · per-cell edit dropdown (backlog/defects/iteration-status) · native inline inputs (releases). Pick one row-actions pattern (recommend kebab `DropdownMenu` for destructive/rare actions + inline edit for frequent fields) and apply everywhere.

### A.3 Status pills — 1 good primitive, 4+ ad-hoc renderings

- **Good & reused:** the Schedule-State stepper (`[▮▮A▮]`) is consistent across backlog/defects/iteration-status — keep it as the model.
- **Inconsistent:** Milestones `Planned`(blue)/`At Risk`(amber) outline pills · Projects `● Active` green-dot pill · Defects `State` plain text · Home `Accepted`(filled green)/`In Progress` · iteration-status `Closed`/`1 Open` pills. Four pill shapes for "status." → one `StatusBadge`.

### A.4 Metric strip — same concept, 6 layouts

Releases (number-over-label) · Quality (color-coded numbers) · Portfolio (plain) · Iteration-status (**+ progress bars + big status word "Done"**) · Reports (**underline accent + `pts` suffix**) · Home (6 KPI tiles). All are "a row of KPIs." → one `MetricStrip` + `MetricCard` with optional bar/accent props.

### A.5 Native form controls leaking

Releases renders raw `<input type="date">` (browser `mm/dd/yyyy` chrome) and a raw `<select>` ("Planning") inline in the grid — visually breaks from the custom styled selects used in work-item detail. → route all selects/date inputs through shared `NativeSelect`/a `DatePicker`.

### A.6 Iteration picker duplicated in 4 places

The `‹ Sprint 26.1 [date range] ›` stepper appears in iteration-status, team-status, team-board, and reports — each slightly different (team-board uses `→` in the range, others `-`). A shared `IterationPicker` exists in `shared/ui` but is not used by all four. → adopt it everywhere.

### A.7 Empty states differ

Portfolio centered gray text · team-board dashed "Drop cards here" · home `EmptyState` (icon + title + subtext). Only the last uses the shared component. → route all through `EmptyState`.

### A.8 Page header layouts differ

List pages (backlog/releases/milestones/defects) share "title + search + primary button" (mostly consistent ✅), but Projects/Portfolio add a subtitle line with different alignment, and iteration-status/team-status/reports each hand-roll a title + iteration-picker bar. → one `PageHeader` with slots (title, subtitle, meta/picker, actions).

**Visual verdict:** the design language is coherent (navy chrome, dense grids, the Schedule-State stepper) — but every _page_ re-derives the grid header, status pill, metric strip, and header bar locally, so they drift a few pixels/rules apart. The fix is the same as the code fix: **one component owns each pattern; pages compose, never re-derive.**
