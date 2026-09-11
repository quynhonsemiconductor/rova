# Shared chrome: layers, widths, and what a table is

Extracted from `CLAUDE.md` so the rule stays in the always-loaded notes and the
incidents behind it stay one click away.

Six reported UI defects on 2026-08-23 had four causes between them, and every one was a shared
component that had been copied rather than used. Recorded together because the SHAPE repeats: the
component existed, the call sites had each solved the problem locally, and the two that had not
copied the fix were the two that broke.

- **`AppPopoverContent` owns the z-index, and it is not cosmetic.** A portalled popover paints in
  document order, so with no layer of its own it loses to any later positioned sibling — and
  `DataTableHeader` is `sticky top-0 z-10`. Both Manage Filters menus (Backlog, Iteration Status)
  opened UNDER the grid header they hang over: mounted, focused and keyboard-operable, with their top
  rows painted behind it, which reads as a truncated menu rather than as a paint order. Every OTHER
  popover — `SearchableSelect`, `DateField`, `ColumnFieldsMenu`, the action menu, tooltips — had
  independently hardcoded `z-50` at its own call site, five copies of one decision. The floor now
  lives in the shared wrapper (a caller may still raise it), so a new popover cannot be born under
  the header.
- **A column's width must fit its HEADER, not just its content.** `Block` at 60px fitted its one
  status glyph and truncated its own five-letter label to `Bl...`; `Fixed In Build` did the same at
  100px. A sweep found 21 columns across 8 grids in that state, and the ones with a real margin were
  widened. Worth re-running when adding a column: the label is bold 12px plus a sort caret plus
  padding, so roughly `label.length * 6.9 + 32` px is the floor.
- **`grow: true` is NOT the fix for a cramped Name column, and would make it worse.** `styleFor`
  gives a grow column `minWidth: <current width>` as a floor it may expand PAST, and paired with the
  row's `min-w-max` that means the TABLE widens to fit a long title instead of the title wrapping
  inside its cell. Quality, Backlog, Iteration Status and the Portfolio children grid all opt out
  deliberately (`children-columns.ts` carries the reasoning); a fixed width is what lets `break-words`
  work. Quality's Name went 200 → 300 for that reason, not by adding `grow`.
- **`OwnerCell` centres, and clips only where asked.** It was `items-start`, chosen when a name fit
  one line — but a wrapped two-line name then hung below a top-pinned avatar, so the cell read as
  top-heavy beside every neighbouring cell. Wrapping is the ordinary case for a full name in a
  narrow column, not the exception. `truncate` is OPT-IN because the right answer is a property of
  the COLUMN: Home's 160px Owner column should wrap (the name is the whole value), while Quality
  renders two people per row and a wrapped name there doubled the height of every row in the grid.
- **A sorted column's LABEL is no longer coloured** — only its caret and its accessible name carry
  the state. `BRAND.primaryLight` on the active heading made it read as a different KIND of column
  rather than the same column in a state, and on a grid with a default sort (Timeboxes sorts Start
  Date) one blue heading sat among six grey ones before the reader had touched anything. Direction is
  still stated twice, so nothing was lost by not colouring the word: a colour never said WHICH WAY.
- **`PanelTable` is the small fixed-column table inside a dashboard CARD**, and it is deliberately
  NOT `DataTableFrame`. The frame owns a scroll region, resize, drag-reorder, Show-Fields, totals and
  pagination, and takes its widths from `useDataTable().colStyles`; a panel has none of that, so
  adopting it there means synthesising a `colStyles` map and an `onResize` for a table that can do
  neither. Home's two tables hand-rolled the same chrome twice instead. **Their shared defect was one
  missing `min-w-0`**: a flex item defaults to `min-width: auto`, so `flex-1` on the Project Name
  column could not shrink below its content, and a long name pushed the fixed columns until every
  remaining heading wrapped — `OPEN DEFECTS` breaking across two lines while the body rows kept their
  height. Widths are now declared once per column and applied to the header and the cells through one
  component, so the two cannot disagree.

  **What was deliberately NOT migrated.** The `<table>` grids in Settings (API tokens, archive,
  repositories), the iteration scope panel and the attachment block are real semantic tables with
  3–5 fixed columns, no sort, no resize and no pagination. Moving those onto either shared component
  would REMOVE accessible table semantics that div-grids cannot express — `DataTableFrame`'s own
  docblock records why its grids have no `role="columnheader"`. A `<table>` is the right answer for a
  small static table; the rule is not "everything through the frame".

- **The nav's active state is a property of the GROUP, not of the parent's path.** `isActive(item.path)`
  asked whether the reader was on the dropdown's DEFAULT destination — its first child — so `Track`
  went dark on `Team Status`, `Plan` on `Timeboxes`, and `Portfolio` on both Capacity Planning and
  Release Tracking. `Quality` looked fine only because it has one child. `isGroupActive` consults the
  children UNFILTERED: a child the caller cannot see is one they cannot be standing on, so filtering
  first would make the answer depend on a permission read the question does not need.
- **The workspace mark is a `Link` home.** It was an inert `div` — the most-clicked affordance in a
  web app, doing nothing. A real anchor, never a `div` with `onClick`, so it carries a focus ring,
  answers Enter and offers open-in-new-tab; the `fe-consistency` ratchet counts hand-rolled clickable
  non-buttons for that reason. Its accessible name is the static `Home` rather than the workspace's,
  because that string has a three-way fallback ending in `Select workspace` and "Select workspace
  home" would be wrong exactly when the reader needs it to be right.
- **A create modal's date pair PREFILLS today + `DEFAULT_TIMEBOX_DAYS`** when both fields are
  REQUIRED, which is the New Iteration case: an empty pair was never a legal submission, so the modal
  opened asking for two dates that are, for almost every sprint, today and today plus a sprint.
  `todayIsoDate()` is timezone-correct on purpose — `new Date().toISOString().slice(0,10)` converts to
  UTC first and hands a planner in UTC+7 yesterday's date before 07:00 local — and `addIsoDays`
  anchors at UTC NOON so a DST boundary cannot move the calendar day. **Release create is
  deliberately left empty**: its dates are OPTIONAL there, and prefilling an optional field
  fabricates a release date nobody chose. Edit modals seed from the record and are unaffected.
