import { describe, expect, it } from 'vitest'
import { declaredMimeType } from './api'

describe('declaredMimeType', () => {
  it('keeps the type the browser reported', () => {
    expect(declaredMimeType({ name: 'a.png', type: 'image/png' })).toBe('image/png')
    expect(declaredMimeType({ name: 'IMG_1.HEIC', type: 'image/heic' })).toBe('image/heic')
  })

  it('maps an empty type to HEIC/HEIF by extension, case-insensitively', () => {
    expect(declaredMimeType({ name: 'IMG_0001.HEIC', type: '' })).toBe('image/heic')
    expect(declaredMimeType({ name: 'photo.heif', type: '' })).toBe('image/heif')
  })

  it('does not guess for any other empty type', () => {
    expect(declaredMimeType({ name: 'notes.txt', type: '' })).toBe('')
    expect(declaredMimeType({ name: 'heic', type: '' })).toBe('')
  })
})
