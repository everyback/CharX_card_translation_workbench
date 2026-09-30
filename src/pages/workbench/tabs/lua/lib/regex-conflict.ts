/** Rebase only the saved baseline. The user's candidate stays in its editor. */
export function regexConflictBaseline<T extends { currentPattern: string; currentOutput: string }>(
  baseline: T, payload: Record<string, unknown>,
): T {
  return {
    ...baseline,
    ...(typeof payload.currentPattern === 'string' ? { currentPattern: payload.currentPattern } : {}),
    ...(typeof payload.currentOutput === 'string' ? { currentOutput: payload.currentOutput } : {}),
  };
}
