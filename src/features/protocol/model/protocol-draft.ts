import type { ProtocolFieldRule } from '@/shared/types';

export function reconcileProtocolDraft(
  draft: ProtocolFieldRule[], previous: ProtocolFieldRule[], incoming: ProtocolFieldRule[],
): ProtocolFieldRule[] {
  return JSON.stringify(draft) === JSON.stringify(previous) ? incoming.map((field) => ({ ...field })) : draft;
}
