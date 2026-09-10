/**
 * `/test-case/$testCaseKey`'s three denied-state branches — same shape as
 * `work-item-unavailable.test.tsx`.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/shared/api/api-error'
import '@/shared/i18n/i18n'
import {
  testCaseUnavailableReason,
  type TestCaseUnavailableReason,
} from '../model/unavailable-reason'
import { TestCaseUnavailable } from './test-case-unavailable'

describe('testCaseUnavailableReason', () => {
  it('maps a 403 to `denied`', () => {
    expect(testCaseUnavailableReason(true, new ApiError({}, 403))).toBe('denied')
  })

  it('maps a resolved-but-absent record to `notFound`', () => {
    expect(testCaseUnavailableReason(false, undefined)).toBe('notFound')
  })

  it('maps a 500 to `loadFailed`, never to `denied`', () => {
    expect(testCaseUnavailableReason(true, new ApiError({}, 500))).toBe('loadFailed')
  })

  it('maps a statusless failure to `loadFailed`', () => {
    expect(testCaseUnavailableReason(true, new Error('Failed to fetch'))).toBe('loadFailed')
  })
})

describe('TestCaseUnavailable', () => {
  const renderReason = (reason: TestCaseUnavailableReason, onBack = vi.fn()) => {
    render(
      <TestCaseUnavailable reason={reason} testCaseKey="TC-17" error={undefined} onBack={onBack} />,
    )
    return onBack
  }

  it('states the refusal for `denied`, and offers a way out', () => {
    renderReason('denied')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('states the load failure for `loadFailed`, and offers a way out', () => {
    renderReason('loadFailed')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('names the key back for `notFound`, and offers a way out', () => {
    renderReason('notFound')
    expect(screen.getByText(/TC-17/)).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('renders SOMETHING in every state', () => {
    for (const reason of ['denied', 'notFound', 'loadFailed'] as TestCaseUnavailableReason[]) {
      const { container, unmount } = render(
        <TestCaseUnavailable reason={reason} testCaseKey="TC-17" onBack={vi.fn()} />,
      )
      expect(container.textContent?.trim()).not.toBe('')
      unmount()
    }
  })

  it('discloses nothing about the record it refused', () => {
    const { container } = render(
      <TestCaseUnavailable reason="denied" testCaseKey="TC-17" onBack={vi.fn()} />,
    )
    expect(container.textContent).not.toContain('TC-17')
  })
})
