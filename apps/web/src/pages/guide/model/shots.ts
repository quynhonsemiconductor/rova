/**
 * Every screenshot the guide can show, with its pixel size.
 *
 * The size lets `GuideShot` reserve the image's space before the (lazy, gated) file arrives, so the
 * page does not shift under the reader — and a link to a section below a screenshot still lands on
 * that section, since `useScrollToHash` scrolls before the images have loaded. Keyed by file name in
 * `public/guide-assets/` (without `.png`), so an unknown name is a compile error rather than a broken
 * image. `user-guide.integrity` tests pin each size to the file's own header.
 */
export const GUIDE_SHOTS = {
  '02-context-selector-production': { width: 305, height: 198 },
  '02-top-navigation-annotated': { width: 1152, height: 78 },
  '03-backlog-production': { width: 940, height: 340 },
  '03-create-work-item-production': { width: 522, height: 470 },
  '03-quality-defects-production': { width: 1100, height: 760 },
  '04-create-iteration-production': { width: 1100, height: 720 },
  '04-timeboxes-production': { width: 1188, height: 420 },
  '05-add-task-production': { width: 1536, height: 635 },
  '05-task-detail-production': { width: 1536, height: 809 },
  '05-tasks-tab-production': { width: 1536, height: 390 },
} as const satisfies Record<string, { width: number; height: number }>

export type GuideShotName = keyof typeof GUIDE_SHOTS
