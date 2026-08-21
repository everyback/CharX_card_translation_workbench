import type { UiAlertOptions } from '../../components/ui';

export type RunWorkbenchAction = (label: string, action: () => Promise<void>) => Promise<void>;

export type ShowUiConfirm = (options: UiAlertOptions) => Promise<boolean>;

export type ShowWorkbenchError = (error: unknown) => void;
