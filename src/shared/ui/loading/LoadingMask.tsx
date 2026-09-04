import { LoaderCircle } from 'lucide-react';

export function LoadingMask({ label, className = '', progress }: {
  label: string;
  className?: string;
  progress?: { current: number; total: number };
}) {
  const percent = progress ? progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 100 : null;
  return (
    <div className={`block-loading-mask ${className}`.trim()} role="status" aria-live="polite">
      <div className="block-loading-status">
        <div className="block-loading-heading"><LoaderCircle className="spin" size={24} /><strong>{label}</strong></div>
        {progress && percent != null && <>
          <div className="block-loading-copy"><span>{progress.current.toLocaleString()} / {progress.total.toLocaleString()} 段</span><b>{percent}%</b></div>
          <div className="block-loading-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.current}><span style={{ width: `${percent}%` }} /></div>
        </>}
      </div>
    </div>
  );
}
