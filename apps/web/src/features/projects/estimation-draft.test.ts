import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ESTIMATION,
  estimationFieldError,
  parseEstimationDraft,
  toEstimationDraft,
} from './estimation-draft'

describe('estimation draft', () => {
  it('round-trips the defaults', () => {
    expect(parseEstimationDraft(toEstimationDraft(DEFAULT_ESTIMATION))).toEqual(DEFAULT_ESTIMATION)
  })

  it('holds an EMPTY field as text rather than snapping back, and refuses to parse it', () => {
    const draft = { ...toEstimationDraft(DEFAULT_ESTIMATION), hoursPerPoint: '' }
    expect(draft.hoursPerPoint).toBe('')
    expect(estimationFieldError('hoursPerPoint', '')).toBe('hoursInvalid')
    expect(parseEstimationDraft(draft)).toBeNull()
  })

  it('accepts any positive hours value, decimals included', () => {
    expect(estimationFieldError('hoursPerPoint', '6')).toBeUndefined()
    expect(estimationFieldError('hoursPerPoint', '7.5')).toBeUndefined()
    expect(estimationFieldError('hoursPerPoint', '0')).toBe('hoursInvalid')
    expect(estimationFieldError('hoursPerPoint', '-1')).toBe('hoursInvalid')
  })

  it('points must be whole numbers >= 1, matching the server schema', () => {
    expect(estimationFieldError('xsPoints', '2')).toBeUndefined()
    expect(estimationFieldError('xsPoints', '0')).toBe('pointsInvalid')
    expect(estimationFieldError('xsPoints', '1.5')).toBe('pointsInvalid')
    expect(estimationFieldError('xsPoints', '')).toBe('pointsInvalid')
  })
})
