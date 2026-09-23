/** Compile only literal, unconditional, request-local assignments with prior reads. */
export function compileLiteralPresetVariables(
  prompts: ReadonlyArray<{ identifier: string; content: string; enabled: boolean }>,
): Map<string, string> | null {
  const variables = new Map<string, string>();
  const result = new Map<string, string>();
  for (const prompt of prompts) {
    if (!/\{\{\s*(?:set|get)var(?:::|\s)/iu.test(prompt.content)) continue;
    // No nesting, optional branches, repeated evaluation, global state or dynamic names.
    if (!prompt.enabled) return null;
    const pattern = /\{\{(setvar|getvar)::([^:{}\s]+)(?:::([^{}]*))?\}\}/gu;
    const remainder = prompt.content.replace(pattern, '');
    if (/\{\{|\}\}/u.test(remainder)) return null;
    let valid = true;
    const content = prompt.content.replace(pattern, (_match, operation: string, name: string, value: string | undefined) => {
      if (operation === 'setvar') {
        if (value === undefined) { valid = false; return ''; }
        variables.set(name, value);
        return '';
      }
      if (value !== undefined || !variables.has(name)) { valid = false; return ''; }
      return variables.get(name) ?? '';
    });
    if (!valid) return null;
    result.set(prompt.identifier, content);
  }
  return result;
}
