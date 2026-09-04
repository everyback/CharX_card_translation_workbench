import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiAlertOptions } from '@/shared/ui';
import type { RunWorkbenchAction, ShowUiConfirm, ShowWorkbenchError } from '@/shared/model/workbench-actions';

export function useWorkbenchFeedback() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uiAlert, setUiAlert] = useState<UiAlertOptions | null>(null);
  const uiAlertResolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const closeUiAlert = useCallback((confirmed: boolean) => {
    const resolve = uiAlertResolverRef.current;
    uiAlertResolverRef.current = null;
    setUiAlert(null);
    resolve?.(confirmed);
  }, []);

  const showUiConfirm = useCallback<ShowUiConfirm>((options) => new Promise((resolve) => {
    uiAlertResolverRef.current?.(false);
    uiAlertResolverRef.current = resolve;
    setUiAlert(options);
  }), []);

  const showError = useCallback<ShowWorkbenchError>((value) => {
    setError(value instanceof Error ? value.message : String(value));
  }, []);

  const runAction = useCallback<RunWorkbenchAction>(async (label, action) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (actionError) {
      showError(actionError);
    } finally {
      setBusy('');
    }
  }, [showError]);

  useEffect(() => () => {
    uiAlertResolverRef.current?.(false);
    uiAlertResolverRef.current = null;
  }, []);

  return {
    busy,
    error,
    notice,
    uiAlert,
    setError,
    setNotice,
    closeUiAlert,
    showUiConfirm,
    showError,
    runAction,
  };
}
