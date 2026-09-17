/**
 * SplitStoryPanel — one side's FIELD BLOCK (SU-02, tasks 2.2/2.3/2.4/2.6).
 *
 * Its own file, not a section of `split-story-modal.tsx`: the file-length ratchet is 929 with a
 * 500-line soft cap, and the modal still has three collections (SU-03/04/05) to gain. One component
 * serves both sides because the two are the same form with different authority over each field —
 * writing them twice is how the two drift apart.
 *
 * READ-ONLY IS RENDERED AS A VALUE, NOT AS A DISABLED CONTROL.
 * The mockup draws `[Unfinished]`'s Release / Iteration / Schedule State as disabled `<select>`s.
 * A disabled select is an affordance that lies: it says "there is a choice here, just not for you",
 * when in fact BR-09/BR-10 fix these three by rule — the placeholder always stays in the source
 * Iteration, always lands `Unscheduled`, always lands `Accepted`. `DetailReadonlyValue` is the shared
 * primitive for "a fact, in a field's clothing", and it carries `aria-readonly` rather than
 * `disabled`, so a screen reader hears the VALUE instead of skipping an unusable control.
 *
 * THE INVALID STATE HAS NO WORDS (AC6, SRS §12).
 * `aria-invalid` on the offending field only, which `Input` already maps to an error-token border
 * (`aria-invalid:border-destructive`). No message, no hint, no toast, and never `FormField`'s `error`
 * prop — it renders red text with `role="alert"`, which is precisely what these ACs forbid. The
 * attribute is `undefined` rather than `false` when valid, so "no invalid field" is the absence of an
 * attribute and a test cannot pass by finding `aria-invalid="false"`.
 *
 * `Split story` is DISABLED throughout SU-02 (§8 Q14) — this panel never enables it. `canConfirm`
 * exists on the derived draft for SU-06 to plug in.
 */
import { useTranslation } from 'react-i18next'
import type { Dispatch } from 'react'

import {
  ScheduleState,
  SCHEDULE_STATE_LABEL,
  SCHEDULE_STATE_VALUES,
} from '@/entities/work-item/model/types'
import { useReleaseOptions } from '@/features/releases/api'
import type { SplitPreview, SplitSide } from '@/features/work-items/api'
import type {
  SplitDerived,
  SplitDraft,
  SplitDraftAction,
} from '@/features/work-items/model/split-draft'
import { listResource } from '@/shared/lib/query/resource'
import { DetailReadonlyValue } from '@/shared/ui/detail'
import { FormField } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'
import { NativeSelect } from '@/shared/ui/native-select'

interface PanelProps {
  preview: SplitPreview
  draft: SplitDraft
  derived: SplitDerived
  dispatch: Dispatch<SplitDraftAction>
}

/**
 * `[Unfinished]` (left) or `[Continued]` (right).
 *
 * The two sides are separate components behind one export because only the `[Continued]` side reads
 * the release feed, and a hook cannot be called conditionally — putting `useReleaseOptions` in a
 * single component would subscribe the read-only side to a feed it never renders.
 *
 * `side` is typed `SplitSide`, which `split-api.ts` DERIVES from the generated schema
 * (`SplitPreviewTask['defaultSide']`), so it traces back to the OpenAPI response and cannot drift
 * from the server. Spelling `'unfinished' | 'continued'` here again would be a THIRD copy of that
 * member list — after the domain's `SPLIT_SIDES` and the DTO's `z.enum` — which is the same fault
 * the SU-01 review closed by deriving both unions from one `as const` array.
 */
export function SplitStoryPanel({ side, ...props }: PanelProps & { side: SplitSide }) {
  return side === 'unfinished' ? <UnfinishedFields {...props} /> : <ContinuedFields {...props} />
}

function UnfinishedFields({ preview, draft, derived, dispatch }: PanelProps) {
  const { t } = useTranslation('split-story')

  return (
    <div className="space-y-3">
      <FormField label={t('fields.title')} htmlFor="split-unfinished-title">
        <Input
          id="split-unfinished-title"
          value={draft.unfinished.title}
          aria-invalid={derived.unfinished.titleInvalid || undefined}
          onChange={(e) => dispatch({ type: 'title', side: 'unfinished', value: e.target.value })}
        />
      </FormField>

      {/* BR-10 — the placeholder always lands Unscheduled. Not a choice, so not a control. */}
      <FormField label={t('fields.release')}>
        <DetailReadonlyValue>{t('readonly.unscheduled')}</DetailReadonlyValue>
      </FormField>

      {/* BR-09 — it stays in the SOURCE iteration, which is the one the Story is in now. */}
      <FormField label={t('fields.iteration')}>
        <DetailReadonlyValue>
          {preview.story.iterationName ?? t('readonly.noIteration')}
        </DetailReadonlyValue>
      </FormField>

      {/* BR-09 — always Accepted. The LABEL comes from the shared map, so this side and the
          `[Continued]` picker beside it speak one schedule-state vocabulary. */}
      <FormField label={t('fields.scheduleState')}>
        <DetailReadonlyValue>{SCHEDULE_STATE_LABEL[ScheduleState.Accepted]}</DetailReadonlyValue>
      </FormField>

      <FormField label={t('fields.planEstimate')} htmlFor="split-unfinished-estimate">
        <Input
          id="split-unfinished-estimate"
          // TEXT, not `type="number"`: a number input hands back `''` for anything it cannot parse,
          // so a half-typed `-` would arrive as "empty" — and empty is a LEGAL value here (an
          // unpointed Story), which would make the two indistinguishable.
          inputMode="decimal"
          value={draft.unfinished.planEstimateText}
          aria-invalid={derived.unfinished.estimateInvalid || undefined}
          onChange={(e) =>
            dispatch({ type: 'planEstimate', side: 'unfinished', value: e.target.value })
          }
        />
      </FormField>

      {/*
        AC2 — the Feature / parent Portfolio relationship is identified as REMOVED by the split
        (BR-10 clears `feature_id` and `parent_id` on the placeholder).

        Rendered WITHOUT the feature's name: the preview carries no feature name, and neither entry
        point can pass one — the detail header's kebab does not hold it either (the Feature NAME on
        that page is resolved by the sidebar's own portfolio feed, from `featureId`). Adding a backend
        field for a one-line label is out of scope for a pure front-end PR, so the line states the
        resulting STATE, which is true whether or not the Story had a Feature. No warning styling and
        no message (SRS §11) — this is a fact about the placeholder, not a caution.
      */}
      <FormField label={t('fields.feature')}>
        <DetailReadonlyValue>{t('readonly.featureCleared')}</DetailReadonlyValue>
      </FormField>
    </div>
  )
}

function ContinuedFields({ preview, draft, derived, dispatch }: PanelProps) {
  const { t } = useTranslation('split-story')

  /**
   * The REFERENCE feed, never `useReleaseRecords`: `GET /releases` needs `release:view`, which a
   * project Editor — the very role that owns this Story — does not hold, and `MAX_ADMIN_FEED_CALL_SITES`
   * counts admin-feed reads for exactly this reason. Bound to its own const before `listResource`,
   * as `resource.ts` requires (the React Compiler cannot see through a hook used as an argument, and
   * `pnpm lint` fails on the one-line form).
   */
  const releasesQuery = useReleaseOptions(preview.story.projectId)
  const releases = listResource(releasesQuery)

  const currentReleaseId = draft.continued.releaseId
  /**
   * The Story's current Release, offered from the PREVIEW's own `releaseName` when the feed does not
   * (or does not yet) contain it. Without this the select would fall back to its first option and
   * render a scheduled Story as `Unscheduled` while the draft still held the id — the exact defect
   * SU-01's `findReleaseName` exists to prevent, one layer up.
   */
  const showPreviewRelease =
    currentReleaseId !== null && !releases.rows.some((release) => release.id === currentReleaseId)

  return (
    <div className="space-y-3">
      <FormField label={t('fields.title')} htmlFor="split-continued-title">
        <Input
          id="split-continued-title"
          value={draft.continued.title}
          aria-invalid={derived.continued.titleInvalid || undefined}
          onChange={(e) => dispatch({ type: 'title', side: 'continued', value: e.target.value })}
        />
      </FormField>

      <FormField label={t('fields.release')} htmlFor="split-continued-release">
        <NativeSelect
          id="split-continued-release"
          value={currentReleaseId ?? ''}
          onChange={(e) => dispatch({ type: 'releaseId', value: e.target.value || null })}
        >
          {/* Unscheduled is a real choice on this side (BR-11 keeps the Release unless edited). */}
          <option value="">{t('fields.unscheduledOption')}</option>
          {showPreviewRelease && (
            <option value={currentReleaseId}>
              {preview.story.releaseName ?? preview.story.releaseId}
            </option>
          )}
          {releases.rows.map((release) => (
            <option key={release.id} value={release.id}>
              {release.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      {/*
        THE PREVIEW'S `targets`, IN THE ORDER GIVEN (earliest first — BR-06/AC5). Not filtered, not
        re-sorted, not widened: this is exactly the set SU-06's write path will accept, and a picker
        wider or narrower than the write is the fault class the plan's risk register names.
      */}
      <FormField label={t('fields.iteration')} htmlFor="split-continued-iteration">
        <NativeSelect
          id="split-continued-iteration"
          value={draft.targetIterationId ?? ''}
          onChange={(e) => dispatch({ type: 'targetIteration', value: e.target.value })}
        >
          {/* Only while nothing is selected — which the server already reported as `no_target`.
              Once a target is chosen there is nothing to un-choose: the write requires one. */}
          {draft.targetIterationId === null && (
            <option value="">{t('fields.iterationPlaceholder')}</option>
          )}
          {(preview.targets ?? []).map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      {/* The six states from the shared constants — never hand-listed here (§8 Q17). */}
      <FormField label={t('fields.scheduleState')} htmlFor="split-continued-schedule-state">
        <NativeSelect
          id="split-continued-schedule-state"
          value={draft.continued.scheduleState}
          onChange={(e) =>
            dispatch({ type: 'scheduleState', value: e.target.value as ScheduleState })
          }
        >
          {SCHEDULE_STATE_VALUES.map((state) => (
            <option key={state} value={state}>
              {SCHEDULE_STATE_LABEL[state]}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <FormField label={t('fields.planEstimate')} htmlFor="split-continued-estimate">
        <Input
          id="split-continued-estimate"
          inputMode="decimal"
          value={draft.continued.planEstimateText}
          aria-invalid={derived.continued.estimateInvalid || undefined}
          onChange={(e) =>
            dispatch({ type: 'planEstimate', side: 'continued', value: e.target.value })
          }
        />
      </FormField>
    </div>
  )
}
