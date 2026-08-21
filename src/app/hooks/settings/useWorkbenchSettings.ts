import { useCallback, useState } from 'react';
import { api, jsonBody } from '../../../api';
import type { Settings } from '../../../types';
import type { RunWorkbenchAction } from '../contracts';

export function useWorkbenchSettings(runAction: RunWorkbenchAction) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const saveSettings = useCallback(async (value: Settings) => {
    await runAction('settings', async () => {
      const updated = await api<Settings>('/api/settings', { method: 'PUT', ...jsonBody(value) });
      setSettings(updated);
      setSettingsOpen(false);
    });
  }, [runAction]);

  return {
    settings,
    settingsOpen,
    applyLoadedSettings: setSettings,
    openSettings,
    closeSettings,
    saveSettings,
  };
}
