export function segmentSummary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '空文本';
  return compact.length > 42 ? `${compact.slice(0, 42)}...` : compact;
}

export interface RegexRepairExample {
  current: string;
  suggested: string;
}

export function findRegexRepairExamples(source: string, draft: string, pattern: string): RegexRepairExample[] {
  if (!source || !draft || !pattern) return [];
  const sourceMatches = collectRegexMatches(source, pattern);
  const draftMatches = collectRegexMatches(draft, pattern);
  if (sourceMatches.length <= draftMatches.length || !sourceMatches.some((match) => /^["”」][ \t]/.test(match))) return [];

  const examples: RegexRepairExample[] = [];
  const missingSpace = /(["”」])(?=[A-Za-z0-9\u3400-\u9fff\u3040-\u30ff])/g;
  let match: RegExpExecArray | null;
  while (examples.length < 3 && (match = missingSpace.exec(draft))) {
    const start = Math.max(0, match.index - 24);
    const end = Math.min(draft.length, match.index + 26);
    const current = compactExample(draft.slice(start, end), start > 0, end < draft.length);
    const suggested = compactExample(`${draft.slice(start, match.index + 1)} ${draft.slice(match.index + 1, end)}`, start > 0, end < draft.length);
    examples.push({ current, suggested });
  }
  return examples;
}

function collectRegexMatches(value: string, pattern: string): string[] {
  try {
    const regex = new RegExp(pattern, 'g');
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while (matches.length < 100_000 && (match = regex.exec(value))) {
      matches.push(match[0]);
      if (!match[0].length) regex.lastIndex += 1;
    }
    return matches;
  } catch {
    return [];
  }
}

function compactExample(value: string, hasPrefix: boolean, hasSuffix: boolean): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return `${hasPrefix ? '…' : ''}${compact}${hasSuffix ? '…' : ''}`;
}
