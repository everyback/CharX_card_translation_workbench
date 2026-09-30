import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiAlertOptions } from '@/shared/ui';
import type { RunWorkbenchAction, ShowUiConfirm } from '@/shared/model/workbench-actions';
import { feedbackMatches } from './feedback-context';

type Feedback = { owner: string | null; value: string };
export function useWorkbenchFeedback() {
  const [busy, setBusy] = useState('');
  const [error, setErrorValue] = useState<Feedback | null>(null);
  const [notice, setNoticeValue] = useState<Feedback | null>(null);
  const [uiAlert, setUiAlert] = useState<UiAlertOptions | null>(null);
  const currentContext = useRef('');
  const actionVersion = useRef(0);
  const alertOwner = useRef<string | null>(null);
  const uiAlertResolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const closeUiAlert = useCallback((confirmed: boolean) => {
    const resolve = uiAlertResolverRef.current;
    uiAlertResolverRef.current = null;
    setUiAlert(null);
    resolve?.(confirmed);
  }, []);

  const bindContext = useCallback((owner: string | null) => {
    const current = () => feedbackMatches(owner, currentContext.current);
    const setError = (value: string) => { if (current()) setErrorValue({ owner, value }); };
    const setNotice = (value: string) => { if (current()) setNoticeValue({ owner, value }); };
    const showError = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
    const showUiConfirm: ShowUiConfirm = options => {
      if (!current()) return Promise.resolve(false);
      return new Promise(resolve => {
        uiAlertResolverRef.current?.(false);
        uiAlertResolverRef.current = resolve;
        alertOwner.current = owner;
        setUiAlert(options);
      });
    };
    const runAction: RunWorkbenchAction = async (label, action) => {
      if (!current()) return;
      const version = ++actionVersion.current;
      setBusy(label); setError(''); setNotice('');
      try { await action(); } catch (error) { showError(error); }
      finally { if (actionVersion.current === version) setBusy(''); }
    };
    return { setError, setNotice, showError, showUiConfirm, runAction };
  }, []);

  const selectContext = (context: string) => {
    currentContext.current = context;
    return {
      error: error && feedbackMatches(error.owner, context) ? error.value : '',
      notice: notice && feedbackMatches(notice.owner, context) ? notice.value : '',
      uiAlert: feedbackMatches(alertOwner.current, context) ? uiAlert : null,
    };
  };
  useEffect(() => {
    if (uiAlertResolverRef.current && !feedbackMatches(alertOwner.current, currentContext.current)) closeUiAlert(false);
  });
  useEffect(() => () => { uiAlertResolverRef.current?.(false); uiAlertResolverRef.current = null; }, []);
  return { busy, bindContext, selectContext, closeUiAlert };
}
