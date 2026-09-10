/**
 * Every enum member has a style, including `not_run` — the text carries meaning, not colour alone.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VerdictBadge } from './verdict-badge'

describe('VerdictBadge', () => {
  it.each([
    ['pass', 'Pass'],
    ['fail', 'Fail'],
    ['blocked', 'Blocked'],
    ['error', 'Error'],
    ['inconclusive', 'Inconclusive'],
  ] as const)('renders %s as "%s"', (verdict, label) => {
    render(<VerdictBadge verdict={verdict} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders null (no Results) as "Not Run" (BR10) — never a dash', () => {
    render(<VerdictBadge verdict={null} />)
    expect(screen.getByText('Not Run')).toBeInTheDocument()
    expect(screen.queryByText('--')).not.toBeInTheDocument()
  })
})
