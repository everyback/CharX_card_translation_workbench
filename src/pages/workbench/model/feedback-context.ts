/** A late response must not publish feedback into a different workspace. */
export function feedbackMatches(owner: string | null, current: string): boolean {
  return owner === null || owner === current;
}
