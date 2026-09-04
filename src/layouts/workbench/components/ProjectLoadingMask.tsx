import { LoadingMask } from '@/shared/ui';

export function ProjectLoadingMask({
  loading,
  progress,
}: {
  loading: boolean;
  progress: { current: number; total: number; known: boolean };
}) {
  if (!loading) return null;
  return (
    <LoadingMask
      label={progress.known ? '正在读取卡片段落' : '正在读取卡片概要'}
      className="project-loading-mask"
      progress={progress.known ? progress : undefined}
    />
  );
}
