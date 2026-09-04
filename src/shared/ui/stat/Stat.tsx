import type { ReactNode } from 'react';

export function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: number | string }) {
  return <div className="stat-item"><span className="stat-icon">{icon}</span><span>{label}</span><strong>{value}</strong></div>;
}
