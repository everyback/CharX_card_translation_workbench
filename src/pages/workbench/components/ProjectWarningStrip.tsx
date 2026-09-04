import { CircleAlert } from 'lucide-react';
import type { ProjectDetail } from '@/shared/types';

export function ProjectWarningStrip({ project }: { project: ProjectDetail }) {
  if (!project.scanSummary?.runtimeRiskCount) return null;
  return (
    <div className="warning-strip">
      <CircleAlert size={16} />
      <span>
        发现 {project.scanSummary.runtimeRiskCount} 个运行时状态风险：
        {project.scanSummary.runtimeRiskMessages.slice(0, 2).join('；')}
      </span>
    </div>
  );
}
