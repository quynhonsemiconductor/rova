import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'

import { cn } from '@/shared/lib/utils'

/**
 * Tabs — Rova's single source of truth for tabbed navigation.
 *
 * Built on Radix Tabs (roving focus, arrow-key nav, aria wiring) and styled as
 * the app's standard underline tab bar. Replaces the 5+ hand-rolled tab bars in
 * work-item-detail, releases-detail, milestones-detail, iteration-status and
 * settings (each of which re-implemented active-underline state with raw
 * `<button>` + a positioned `<span>`).
 *
 * Usage:
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <TabsList>
 *       <TabsTrigger value="details" icon={<FileText size={13} />}>Details</TabsTrigger>
 *       <TabsTrigger value="tasks" count={tasks.length}>Tasks</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="details">…</TabsContent>
 *     <TabsContent value="tasks">…</TabsContent>
 *   </Tabs>
 */

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('flex items-center gap-1 border-b border-border-subtle', className)}
      {...props}
    />
  )
}

interface TabsTriggerProps extends React.ComponentProps<typeof TabsPrimitive.Trigger> {
  /** Optional leading icon. */
  icon?: React.ReactNode
  /** Optional trailing count pill (e.g. number of tasks). */
  count?: number
}

export function TabsTrigger({ className, icon, count, children, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // layout
        'relative inline-flex items-center gap-1.5 px-3 py-2 text-ui-sm font-medium whitespace-nowrap',
        // resting
        'text-muted-foreground transition-colors hover:text-foreground',
        // active — navy label + underline via bottom-border on the -1px offset bar
        'data-[state=active]:text-primary',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-transparent',
        'data-[state=active]:after:bg-primary',
        // focus
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {count !== undefined && (
        <span className="rounded-sm bg-muted px-1 text-ui-xs font-semibold text-muted-foreground">
          {count}
        </span>
      )}
    </TabsPrimitive.Trigger>
  )
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('outline-none focus-visible:ring-2 focus-visible:ring-ring/40', className)}
      {...props}
    />
  )
}
