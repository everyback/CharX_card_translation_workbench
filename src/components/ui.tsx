import { Check, CircleAlert, Copy, LoaderCircle, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Segment } from '../types';

export interface UiAlertOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'warning' | 'danger';
}

export function UiAlert({ options, onResolve }: { options: UiAlertOptions; onResolve: (confirmed: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const tone = options.tone ?? 'default';

  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onResolve(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onResolve]);

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(options.message);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = options.message;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="modal-backdrop ui-alert-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onResolve(false); }}>
      <section className={`ui-alert-dialog tone-${tone}`} role="alertdialog" aria-modal="true" aria-labelledby="ui-alert-title" aria-describedby="ui-alert-message">
        <header className="ui-alert-header">
          <span className="ui-alert-icon"><CircleAlert size={19} /></span>
          <h2 id="ui-alert-title">{options.title}</h2>
          <button className="icon-button" title="关闭" aria-label="关闭提示" onClick={() => onResolve(false)}><X size={17} /></button>
        </header>
        <div id="ui-alert-message" className="ui-alert-message" tabIndex={0}>{options.message}</div>
        <footer className="ui-alert-actions">
          <button className="secondary-button" onClick={() => void copyMessage()} title="复制完整提示文字">
            {copied ? <Check size={16} /> : <Copy size={16} />}{copied ? '已复制' : '复制内容'}
          </button>
          <span />
          <button className="secondary-button" onClick={() => onResolve(false)}><X size={16} />{options.cancelLabel ?? '取消'}</button>
          <button ref={confirmRef} className={tone === 'danger' ? 'danger-button' : 'primary-button'} onClick={() => onResolve(true)}>
            {tone === 'danger' ? <Trash2 size={16} /> : <Check size={16} />}{options.confirmLabel ?? '确认'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: number | string }) {
  return <div className="stat-item"><span className="stat-icon">{icon}</span><span>{label}</span><strong>{value}</strong></div>;
}

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

export function RiskBadge({ risk }: { risk: Segment['riskLevel'] }) {
  const labels = { low: '低', medium: '中', high: '高' };
  return <span className={`risk-badge risk-${risk}`}>{labels[risk]}</span>;
}
