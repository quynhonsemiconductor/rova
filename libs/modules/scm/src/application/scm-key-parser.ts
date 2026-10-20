/**
 * Work-item key extraction — the link convention. A work-item's formatted key
 * embedded in a PR title, branch name, or commit message associates the SCM
 * artifact to the item (same model as Jira/GitHub/Rally).
 *
 * Keys are type-prefixed + hyphen + sequence (see ProjectsService.TYPE_PREFIX):
 *   IN- (initiative), FE- (feature), US- (story), TA- (task), DE- (defect).
 */

/** Ordered by prefix length is irrelevant here (all 2 chars); alternation is fine. */
const WORK_ITEM_KEY_RE = /\b(?:IN|FE|US|TA|DE)-\d+\b/gi;

/**
 * Extract the de-duplicated, upper-cased set of work-item keys mentioned across
 * any number of free-text fields (PR title, branch ref, commit message …).
 */
export function extractWorkItemKeys(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(WORK_ITEM_KEY_RE)) {
      found.add(match[0].toUpperCase());
    }
  }
  return [...found];
}

/** The repo's short name (last path segment of `owner/name`), used in changeset display names. */
export function repoShortName(fullName: string): string {
  const parts = fullName.split('/');
  return parts[parts.length - 1] || fullName;
}
