import { CircleAlert, ShieldCheck, X } from 'lucide-react';

export function GlobalNoticeBanners({
  error,
  notice,
  onClearError,
  onClearNotice,
}: {
  error: string;
  notice: string;
  onClearError: () => void;
  onClearNotice: () => void;
}) {
  return (
    <>
      {error && <div className="error-banner"><CircleAlert size={17} /><span>{error}</span><button onClick={onClearError}><X size={16} /></button></div>}
      {notice && <div className="notice-banner"><ShieldCheck size={17} /><span>{notice}</span><button onClick={onClearNotice}><X size={16} /></button></div>}
    </>
  );
}
