export function summarizeMatchSamples(samples?: string[]): string {
  const values = (samples ?? []).map((sample) => sample.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (!values.length) return '无';
  const shown = values.slice(0, 2).map((sample) => sample.length > 72 ? `${sample.slice(0, 72)}…` : sample);
  return `${shown.join(' / ')}${values.length > shown.length ? `（共 ${values.length} 条）` : ''}`;
}
