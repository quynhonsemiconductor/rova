/**
 * US-120 — the Projects grid's Key cell is a real link to the project's detail page; dropping `href`
 * would silently fall back to an in-place-only button (no Ctrl/Cmd+click, no "Open in new tab").
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { PROJECT_COLUMNS } from './project-parts'
import type { ProjectCtx } from '../model/columns'

type Row = Parameters<NonNullable<(typeof PROJECT_COLUMNS)[number]['cell']>>[0]

describe('PROJECT_COLUMNS key cell', () => {
  it('links the key to the project detail URL', () => {
    const keyCol = PROJECT_COLUMNS.find((c) => c.key === 'key')
    const ctx: ProjectCtx = { members: [], canEdit: false, onOpen: vi.fn() }
    render(<>{keyCol?.cell?.({ id: 'p-1', key: 'NXP', name: 'NextGen' } as Row, ctx)}</>)

    expect(screen.getByTitle('NXP').getAttribute('href')).toBe('/projects/NXP')
  })
})
