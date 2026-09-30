/** Refresh clean editors while preserving text the user has actually changed. */
export function reconcileTextDraft(draft: string | undefined, previous: string | undefined, incoming: string): string {
  return draft === undefined || draft === previous ? incoming : draft;
}
