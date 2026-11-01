import { describe, expect, it } from 'vitest'
import { guideLangFor, isGuideLang } from './guide-url'

describe('guideLangFor', () => {
  it.each([[['vi']], [['vi-VN']], [['VI-vn', 'en-US']], [[' vi ']]])(
    'opens the Vietnamese edition for %j',
    (languages) => {
      expect(guideLangFor(languages)).toBe('vi')
    },
  )

  it.each([[['en-US']], [[]], [['fr', 'vi']], [['vietnamese']], [['']]])(
    'opens the English edition for %j',
    (languages) => {
      expect(guideLangFor(languages)).toBe('en')
    },
  )
})

describe('isGuideLang', () => {
  it('accepts only the two editions', () => {
    expect(isGuideLang('vi')).toBe(true)
    expect(isGuideLang('en')).toBe(true)
    expect(isGuideLang('EN')).toBe(false)
    expect(isGuideLang('fr')).toBe(false)
    expect(isGuideLang(undefined)).toBe(false)
  })
})
