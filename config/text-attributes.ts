/** Visible copy only. Never add resource keys, event handlers or script attributes. */
export const TEXT_ATTRIBUTE_POLICY = {
  common: ['description', 'alt', 'title', 'aria-label', 'placeholder', 'data-tooltip', 'data-label'],
  byTag: { input: ['value'], button: ['value'] } as Record<string, string[]>,
};
