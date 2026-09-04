import { Check, CircleAlert, Copy, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UiAlertOptions } from './types';

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
