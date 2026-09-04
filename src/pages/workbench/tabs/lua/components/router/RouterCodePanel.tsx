interface CompactCodeLine {
  number: number;
  text: string;
  changed: boolean;
}

interface CompactCode {
  lines: CompactCodeLine[];
  hiddenBefore: boolean;
  hiddenAfter: boolean;
  changedCount: number;
}

function codeLines(source: string): string[] {
  return source.replace(/\r\n/gu, '\n').split('\n');
}

function diffBounds(source: string, peer: string): { lines: string[]; prefix: number; suffix: number } {
  const lines = codeLines(source);
  const peerLines = codeLines(peer);
  let prefix = 0;
  while (prefix < lines.length && prefix < peerLines.length && lines[prefix] === peerLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < lines.length - prefix
    && suffix < peerLines.length - prefix
    && lines[lines.length - suffix - 1] === peerLines[peerLines.length - suffix - 1]
  ) suffix += 1;
  return { lines, prefix, suffix };
}

export function changedSection(source: string, peer: string): string {
  const { lines, prefix, suffix } = diffBounds(source, peer);
  return lines.slice(prefix, Math.max(prefix, lines.length - suffix)).join('\n');
}

export function replaceChangedSection(source: string, peer: string, replacement: string): string {
  const { lines, prefix, suffix } = diffBounds(source, peer);
  const replacementLines = replacement === '' ? [] : replacement.replace(/\r\n/gu, '\n').split('\n');
  return [...lines.slice(0, prefix), ...replacementLines, ...lines.slice(Math.max(prefix, lines.length - suffix))].join('\n');
}

export function compactCode(source: string, peer: string): CompactCode {
  const { lines, prefix, suffix } = diffBounds(source, peer);
  const changedEnd = Math.max(prefix, lines.length - suffix);
  const start = Math.max(0, prefix - 3);
  const end = Math.min(lines.length, changedEnd + 3);
  return {
    lines: lines.slice(start, end).map((text, index) => ({ number: start + index + 1, text, changed: start + index >= prefix && start + index < changedEnd })),
    hiddenBefore: start > 0,
    hiddenAfter: end < lines.length,
    changedCount: Math.max(0, changedEnd - prefix),
  };
}

export function RouterCodePanel({
  source,
  peer,
  tone,
  editable,
  onDoubleClick,
}: {
  source: string;
  peer: string;
  tone: 'before' | 'after';
  editable?: boolean;
  onDoubleClick?: () => void;
}) {
  const compact = compactCode(source, peer);
  return (
    <div
      className={`router-code-panel router-code-panel-${tone}${editable ? ' editable' : ''}`}
      title={editable ? '双击修改建议代码' : undefined}
      onDoubleClick={editable ? onDoubleClick : undefined}
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
    >
      {compact.hiddenBefore && <div className="router-code-ellipsis">…</div>}
      {compact.lines.map((line) => (
        <div className={`router-code-line${line.changed ? ' changed' : ''}`} key={`${line.number}:${line.text}`}>
          <span>{line.number}</span><code>{line.text || ' '}</code>
        </div>
      ))}
      {compact.hiddenAfter && <div className="router-code-ellipsis">…</div>}
    </div>
  );
}
