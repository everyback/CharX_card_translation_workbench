export function encodeWindowsPowerShell(source: string): Uint8Array {
  const normalized = source.replace(/^\uFEFF/, '');
  return new TextEncoder().encode(`\uFEFF${normalized}`);
}
