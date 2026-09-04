export function MatchExampleList({ samples }: { samples?: string[] }) {
  const values = (samples ?? []).filter(Boolean).slice(0, 8);
  if (!values.length) return <span className="regex-editor-no-examples">无命中示例</span>;
  return <ul className="regex-editor-example-list">{values.map((sample, index) => <li key={`${index}:${sample}`}><code>{sample}</code></li>)}</ul>;
}
