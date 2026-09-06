export function chatCompletionsEndpoint(value: string): string {
  const normalized = normalizeBaseUrl(value);
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`;
}

export function modelsEndpoint(value: string): string {
  const normalized = normalizeBaseUrl(value);
  if (/\/models$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return `${normalized.slice(0, -'/chat/completions'.length)}/models`;
  return `${normalized}/models`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
