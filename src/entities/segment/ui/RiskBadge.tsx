import type { Segment } from '@/shared/types';

export function RiskBadge({ risk }: { risk: Segment['riskLevel'] }) {
  const labels = { low: '低', medium: '中', high: '高' };
  return <span className={`risk-badge risk-${risk}`}>{labels[risk]}</span>;
}
