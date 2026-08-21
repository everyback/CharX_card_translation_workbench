import type { Segment } from '../types';

export function locateLuaSyntaxSegment(segments: Segment[], message: string): Segment | null {
  const issue = message.match(/Risu Lua 语法校验失败：(模块\.[^\s]+)\s+\[(\d+):(\d+)\]/);
  if (!issue) return null;
  const path = issue[1];
  const errorLine = Number(issue[2]);
  const candidates = segments.filter((segment) => (
    segment.reviewStatus === 'approved' && segment.pathLabel.startsWith(path)
  ));
  const located = candidates.flatMap((segment) => {
    const line = segment.pathLabel.match(/行\s*(\d+)/);
    return line ? [{ segment, distance: Math.abs(Number(line[1]) - errorLine) }] : [];
  }).sort((left, right) => left.distance - right.distance || left.segment.sortOrder - right.segment.sortOrder);
  return located[0]?.segment ?? null;
}
