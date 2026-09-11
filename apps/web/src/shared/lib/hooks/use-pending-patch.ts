import { useCallback, useState } from 'react'
import { useResetOnIdChange } from './use-reset-on-id-change'

/**
 * usePendingPatch — accumulates field edits locally instead of saving each one
 * immediately, so a detail page can offer a single Save/Cancel action over the
 * whole form (matching Broadcom Rally's UX) instead of auto-saving every field
 * on blur/change.
 *
 * Takes two type params on purpose: `TEntity` (the read shape rendered on
 * screen) and `TPatch` (the write shape the API accepts) are frequently NOT
 * the same generated type in this codebase — e.g. WorkItemResponseDto widens
 * enum fields like scheduleState to plain `string`, while UpdateWorkItemDto
 * keeps the strict literal union. Collapsing both onto one `T` either loses
 * that type safety or produces a real type error at the mutateAsync call;
 * keeping them separate lets `value` merge cleanly while `setField`/`persist`
 * stay held to the API's actual (stricter) contract.
 *
 * `entityId` resets pending edits whenever the user navigates to a different
 * entity (so leftover edits from item A never leak onto item B).
 *
 * Usage:
 *   const { value, isDirty, setField, save, cancel } = usePendingPatch(item, item.id, patch =>
 *     updateMutation.mutateAsync(patch),
 *   )
 *   <input value={value.title} onChange={e => setField({ title: e.target.value })} />
 *   {isDirty && <SaveCancelBar onSave={save} onCancel={cancel} saving={saving} />}
 *
 * N1: `entity` accepts `null` for the "still loading" case — the caller's own query result is
 * `TEntity | undefined` before it resolves, so a caller no longer needs `data ?? ({} as TEntity)`
 * just to satisfy this hook's signature. `value` is `TEntity | null` in that state; a caller that
 * reaches the loading branch already returns before rendering fields off it (every current caller
 * does), so this never has to be defended against in practice.
 */
export function usePendingPatch<TEntity extends object, TPatch extends object = Partial<TEntity>>(
  entity: TEntity | null,
  entityId: string | undefined,
  persist: (patch: TPatch) => Promise<unknown>,
) {
  const [pending, setPending] = useState<TPatch>({} as TPatch)
  const [saving, setSaving] = useState(false)

  useResetOnIdChange(entityId, () => setPending({} as TPatch))

  const setField = useCallback((patch: Partial<TPatch>) => {
    setPending((prev) => ({ ...prev, ...patch }))
  }, [])

  const cancel = useCallback(() => setPending({} as TPatch), [])

  const save = useCallback(async () => {
    if (Object.keys(pending).length === 0) return
    setSaving(true)
    try {
      await persist(pending)
      setPending({} as TPatch)
    } finally {
      setSaving(false)
    }
  }, [pending, persist])

  return {
    /** Entity merged with any pending edits — render this, not the raw entity. `null` while the
     *  entity itself hasn't loaded yet. */
    value: entity ? { ...entity, ...pending } : null,
    /** The raw accumulated patch, in case a caller needs it directly (e.g. image upload on save). */
    pending,
    isDirty: Object.keys(pending).length > 0,
    saving,
    setField,
    save,
    cancel,
  }
}
