import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cardloomDesktop', {
  selectPatchRoot: (): Promise<string | null> => ipcRenderer.invoke('cardloom:select-patch-root'),
});
