import type { ProjectEstimationSettings } from './api'

/**
 * The Estimation Settings inputs hold the TEXT the user typed, not a number.
 *
 * Both forms used to store a number and drop any keystroke that did not parse to `> 0`. With a
 * controlled input that means clearing the field is impossible: `Number('')` is 0, the change is
 * ignored, and React writes the old value straight back — so "8" could not be deleted and replaced,
 * only edited around (BA report, 2026-11-04). The draft now keeps whatever is in the box, and the
 * rule is applied where the value LEAVES the form: an invalid field shows its error and the
 * submit stays disabled.
 *
 * The rules mirror `ProjectEstimationSettingsSchema` server-side: points are whole numbers >= 1,
 * hours per point is any number > 0.
 */
export type EstimationField = keyof ProjectEstimationSettings
export type EstimationDraft = Record<EstimationField, string>

export const DEFAULT_ESTIMATION: ProjectEstimationSettings = {
  xsPoints: 1,
  sPoints: 3,
  mPoints: 5,
  lPoints: 8,
  xlPoints: 13,
  hoursPerPoint: 8,
}

const FIELDS: EstimationField[] = [
  'xsPoints',
  'sPoints',
  'mPoints',
  'lPoints',
  'xlPoints',
  'hoursPerPoint',
]

export type EstimationFieldError = 'pointsInvalid' | 'hoursInvalid'

export function toEstimationDraft(s: ProjectEstimationSettings): EstimationDraft {
  return Object.fromEntries(FIELDS.map((f) => [f, String(s[f])])) as EstimationDraft
}

function parse(field: EstimationField, text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const v = Number(trimmed)
  if (!Number.isFinite(v)) return null
  if (field === 'hoursPerPoint') return v > 0 ? v : null
  return Number.isInteger(v) && v >= 1 ? v : null
}

export function estimationFieldError(
  field: EstimationField,
  text: string,
): EstimationFieldError | undefined {
  if (parse(field, text) !== null) return undefined
  return field === 'hoursPerPoint' ? 'hoursInvalid' : 'pointsInvalid'
}

/** The settings to send, or null while any field is invalid. */
export function parseEstimationDraft(d: EstimationDraft): ProjectEstimationSettings | null {
  const out: Partial<ProjectEstimationSettings> = {}
  for (const f of FIELDS) {
    const v = parse(f, d[f])
    if (v === null) return null
    out[f] = v
  }
  return out as ProjectEstimationSettings
}
