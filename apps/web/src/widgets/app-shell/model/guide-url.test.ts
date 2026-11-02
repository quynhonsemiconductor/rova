import { describe, expect, it } from 'vitest'
import { GUIDE_URL_EN, GUIDE_URL_VI, guideUrlFor } from './guide-url'

describe('guideUrlFor', () => {
  it.each([[['vi']], [['vi-VN']], [['VI-vn', 'en-US']], [[' vi ']]])(
    'opens the Vietnamese guide for %j',
    (languages) => {
      expect(guideUrlFor(languages)).toBe(GUIDE_URL_VI)
    },
  )

  it.each([[['en-US']], [[]], [['fr', 'vi']], [['vietnamese']], [['']]])(
    'opens the English guide for %j',
    (languages) => {
      expect(guideUrlFor(languages)).toBe(GUIDE_URL_EN)
    },
  )

  it('points at pages that exist in the published guide', () => {
    expect(GUIDE_URL_VI).toBe('/guide/index.html')
    expect(GUIDE_URL_EN).toBe('/guide/en/index.html')
  })
})
