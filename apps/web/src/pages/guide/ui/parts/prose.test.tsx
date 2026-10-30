import { describe, expect, it } from 'vitest'
import { TIMEBOX_TYPE_CONFIG } from '@/entities/work-item/model/types'
import { PLANNING_MARKS } from './prose'

describe('PlanningIcon marks', () => {
  // The entity's timebox config is keyed by plain `string`, so a rename there would not fail to
  // compile in the guide — it would quietly draw the grey fallback chip. This is the guard instead.
  it.each(PLANNING_MARKS)('draws the entity’s own mark for %s', (type) => {
    expect(TIMEBOX_TYPE_CONFIG[type], type).toBeDefined()
  })
})
