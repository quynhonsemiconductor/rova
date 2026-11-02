/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IterationStateCard, IterationStateFlow, NavigationLegend } from './steps'

const CONTENT = join(import.meta.dirname, '../../content')
const css = readFileSync(join(import.meta.dirname, '../../../../app/styles/globals.css'), 'utf8')
const source = readFileSync(join(import.meta.dirname, 'steps.tsx'), 'utf8')

describe('NavigationLegend', () => {
  // Its badges are coloured by position, one rule per pin on the screenshot, so a legend with more
  // items than there are marker colours renders a badge with no background.
  const markers = [...css.matchAll(/^\s*--guide-marker-(\d+):/gm)].map(([, n]) => Number(n))
  const legends = readdirSync(CONTENT, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.tsx'))
    .flatMap((file) =>
      [
        ...readFileSync(join(CONTENT, file), 'utf8').matchAll(
          /<NavigationLegend>([\s\S]*?)<\/NavigationLegend>/g,
        ),
      ].map(([, body]) => [file, body!.match(/<article>/g)?.length ?? 0] as const),
    )

  it('colours one badge per marker token', () => {
    expect(markers).toEqual([1, 2, 3, 4])
    for (const n of markers) {
      expect(source).toContain(`[&>article:nth-child(${n})>span]:bg-guide-marker-${n}`)
    }
  })

  it('is used, in every edition, with exactly that many items', () => {
    expect(legends.length).toBeGreaterThan(0)
    for (const [file, items] of legends) expect(items, file).toBe(markers.length)
  })

  it('renders the items it is given', () => {
    render(
      <NavigationLegend>
        <article>
          <span>1</span>
          <strong>Project</strong>
        </article>
      </NavigationLegend>,
    )
    expect(screen.getByText('Project')).toBeInTheDocument()
  })
})

describe('IterationStateFlow', () => {
  it('is announced as one group, by the name the chapter gives it', () => {
    render(
      <IterationStateFlow aria-label="Three states of Iteration">
        <IterationStateCard state="planning">
          <span>P</span>
          <h3>Planning</h3>
        </IterationStateCard>
      </IterationStateFlow>,
    )
    expect(screen.getByRole('group', { name: 'Three states of Iteration' })).toContainElement(
      screen.getByRole('heading', { name: 'Planning' }),
    )
  })
})
