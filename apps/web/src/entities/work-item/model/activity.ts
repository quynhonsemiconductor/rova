/**
 * Activity-log presentation helpers — shared by every place that renders the
 * work-item revision history / activity feed (detail Revision History tab,
 * dashboards, timelines). Pure functions kept in the entity model so the
 * humanisation logic has a single source of truth. Accepts a minimal structural
 * shape so it stays decoupled from any feature-layer response type.
 */

export interface ActivityChange {
  field: string
  old: unknown
  new: unknown
}

export interface ActivityLike {
  action: string
  changes: ActivityChange | null
}

/** Convert a camelCase / snake_case / dotted token into a Title-Cased phrase. */
export function humanizeToken(token: string): string {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Did this side of the change carry no value at all?
 *
 * ONE definition of blank, used by `formatActivityValue` below — and through it by
 * `describeActivity`'s nothing-to-show branch, which compares the two RENDERED sides rather than
 * re-testing blankness itself (review finding, #640). The two predicates used to test the same three
 * conditions separately, and the sentence's correctness depends on them agreeing: a side counts as
 * "nothing" exactly when it would render "(empty)".
 */
function isBlankValue(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/** Render an activity-log field value for display in a revision Description. */
export function formatActivityValue(value: unknown): string {
  if (isBlankValue(value)) return '(empty)'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Actions whose `changes.field` does not name the thing that changed in the entity's OWN terms.
 *
 * `scheduleState` is the DTO/wire field on BOTH a work item and a task — it is mirrored onto
 * `work.tasks.state` — so `humanizeToken` renders a task's state change as "Schedule State", a
 * dimension a Task does not have (GAP-P1-HIST-002). The writer is already correct and must stay
 * that way: `activity-diff.ts` emits `task.state_changed` for a task and
 * `work_item.schedule_state_changed` for an item, while keeping one field NAME for both.
 *
 * Keyed on the ACTION, deliberately, for two reasons. It is the only discriminant that is true of
 * the row rather than of the request that produced it (`changes.field` is shared by both entities,
 * so a per-field rename would relabel a work item's own Schedule State too), and it repairs every
 * row already written — a writer-side fix would relabel future rows only and leave the history the
 * BA was reading untouched.
 *
 * The copy is the app's existing label for the field: `sidebar.taskState` in
 * `shared/i18n/locales/en/work-items.json`. It is a literal here rather than a `t()` lookup because
 * the whole Description is an un-internationalised English sentence ("changed from", "(empty)");
 * translating one noun inside it would read worse than leaving it, and threading a translator into
 * a pure model function for one word buys nothing. When the sentence is internationalised, this map
 * becomes a key map and moves with it.
 */
const FIELD_LABEL_BY_ACTION: Record<string, string> = {
  'task.state_changed': 'Task State',
  /**
   * Phase 7 SU-07 7.4 — the four relationship changes a Split writes.
   *
   * All four carry a `changes` diff, so they render through the "X changed from A to B" sentence
   * below; without an entry they would say "Parent Id" and "Work Item Id", which are COLUMN names
   * rather than things this product has. The reader's vocabulary is `Parent Story` (the field the
   * Details sidebar labels) and `Work Product` (the Test Case field, and the word SU-05's own AC
   * uses).
   *
   * `work_item.parent_changed` and `task.parent_changed` are separate keys for one label on purpose:
   * this map is keyed on the ACTION because that is the only discriminant true of the ROW, and the two
   * actions are written by two different entity types (a re-parented Defect vs a re-parented Task).
   * Collapsing them would need a per-field rule, which is the shape the docblock above rejects.
   *
   * The VALUES stay as the ids the writer recorded. Resolving them to item keys would need a lookup
   * per row from a pure function that has no client — the trace itself is the Split banner's job, and
   * these rows exist to say WHEN and BY WHOM.
   */
  'work_item.parent_changed': 'Parent Story',
  'task.parent_changed': 'Parent Story',
  'test_case.work_product_changed': 'Work Product',
}

/**
 * Actions with NO `changes` diff, whose humanised token would read as a column dump.
 *
 * `work_item.split_out` / `work_item.split_in` are entries ON the two resulting Stories, written with
 * `changes: null` because nothing about the row itself changed — the Story's PLACE in a Split is the
 * fact being recorded. `humanizeToken` would render them "Work Item Split Out" and "Work Item Split
 * In", which name the writer's namespace rather than what happened.
 *
 * The wording is directional and says which side the row is: the placeholder was split OUT of its
 * Iteration, the original was carried forward. The `[Unfinished]`/`[Continued]` keys are deliberately
 * NOT interpolated — the entry names an event, and the counterpart is one line above in the Split
 * banner, which is the surface SU-07 gives that job to.
 */
const ACTION_LABEL: Record<string, string> = {
  'work_item.split_out': 'Split out as the unfinished placeholder',
  'work_item.split_in': 'Split forward into the target iteration',
}

/**
 * The label for the field an activity row changed — the action's override where one exists,
 * otherwise the humanised field name. Exported for its own spec.
 */
export function activityFieldLabel(log: ActivityLike): string {
  return FIELD_LABEL_BY_ACTION[log.action] ?? humanizeToken(log.changes?.field ?? log.action)
}

/** Build a Rally-style revision Description from an activity-log entry. */
export function describeActivity(log: ActivityLike): string {
  if (log.changes) {
    /**
     * DE-18: when the two sides would READ THE SAME, state the change and stop.
     *
     * Three different rows land here, and one sentence is right for all of them, because what they
     * have in common is exactly what can be said — the field changed, and this feed cannot show the
     * difference:
     *
     *   • the rows written BEFORE the preview existed, which carry `old: null, new: null` (rich-text
     *     changes were logged as the field name only). Their bodies are not recoverable by any
     *     migration, so the writer-side fix cannot repair them and this branch is the only thing
     *     that can — it is why the fix is on both sides.
     *   • a FORMATTING-ONLY edit: `changed()` compares the raw markup while the value recorded is the
     *     flattened preview, so bolding a word (`<p>hello</p>` → `<p><b>hello</b></p>`) is a real
     *     change with two identical previews. "Notes changed from hello to hello" is not false, but
     *     it reads as a glitch — which is the class of defect DE-18 itself was.
     *   • an edit BEYOND the preview window: change character 400 of a Description and the first 120
     *     are identical on both sides.
     *
     * Raised as a review finding on #640, which offered the alternative of gating rich-text entries
     * on `changed(richTextPreview(old), richTextPreview(new))` in the WRITER instead. Rejected, and
     * for a reason the finding could not see from one file: that gate cannot tell the second case
     * from the third, so it would silently drop real edits to any document longer than the preview —
     * trading a sentence that reads oddly for a revision feed that omits changes. The row is kept;
     * only the claim about the values is dropped, since there is none to make.
     */
    const { old, new: next } = log.changes
    // One comparison covers all three: two blanks both render "(empty)", so they are equal here too.
    if (formatActivityValue(old) === formatActivityValue(next)) {
      return `${activityFieldLabel(log)} changed`
    }
    return `${activityFieldLabel(log)} changed from ${formatActivityValue(
      old,
    )} to ${formatActivityValue(next)}`
  }
  // A diff-less action's own sentence where it has one, otherwise the humanised token. The lookup is
  // here rather than inside `activityFieldLabel` because these rows are NOT field changes: there is no
  // "changed from … to …" to hang a field name on.
  return ACTION_LABEL[log.action] ?? humanizeToken(log.action)
}
