import { Braces, CircleAlert, Gauge, Link2, ListChecks, ShieldCheck } from 'lucide-react';
import { Stat } from '@/shared/ui';
import type { ProjectDetail } from '@/shared/types';

export function ProjectStats({ project }: { project: ProjectDetail }) {
  return (
    <section className="stats-band">
      <Stat icon={<ListChecks size={17} />} label="扫描段落" value={project.scanSummary?.totalSegments ?? project.segments.length} />
      <Stat icon={<Gauge size={17} />} label="待人工审核" value={project.scanSummary?.pendingSegments ?? project.segments.filter((item) => item.reviewStatus === 'pending').length} />
      <Stat icon={<ShieldCheck size={17} />} label="已通过" value={project.scanSummary?.approvedSegments ?? project.segments.filter((item) => item.reviewStatus === 'approved').length} />
      <Stat icon={<CircleAlert size={17} />} label="高疑点" value={project.scanSummary?.highRiskSegments ?? project.segments.filter((item) => item.riskLevel === 'high').length} />
      <Stat icon={<Link2 size={17} />} label="脚本引用" value={project.controlReferences.length} />
      <Stat icon={<Braces size={17} />} label="Lua / 协议" value={`${project.scanSummary?.luaSegments ?? 0} / ${project.scanSummary?.protocolSegments ?? 0}`} />
    </section>
  );
}
