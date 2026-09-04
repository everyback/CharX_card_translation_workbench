import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/shared/api/http';
import type { ProjectDetail } from '@/shared/types';
import { SUPPORTED_CARD_EXTENSIONS } from './card-file';
import type { RunWorkbenchAction, ShowWorkbenchError } from '@/shared/model/workbench-actions';

interface UseCardImportOptions {
  busy: string;
  runAction: RunWorkbenchAction;
  refreshProjects: (syncSettings?: boolean) => Promise<void>;
  selectProject: (projectId: string) => void;
  onError: ShowWorkbenchError;
  onNotice: (notice: string) => void;
  onShowOverview: () => void;
  onImportedProject?: (projectId: string) => void;
}

export function useCardImport({
  busy,
  runAction,
  refreshProjects,
  selectProject,
  onError,
  onNotice,
  onShowOverview,
  onImportedProject,
}: UseCardImportOptions) {
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const importCards = useCallback(async (files: File[]) => {
    if (busy) return;
    const supported = files.filter((file) => SUPPORTED_CARD_EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase() ?? ''));
    if (!supported.length) {
      onError('不支持这些文件。请拖入 JSON、PNG、CHARX 或 RISUM 文件。');
      return;
    }
    await runAction('import', async () => {
      let created: ProjectDetail | null = null;
      for (const file of supported) {
        const formData = new FormData();
        formData.append('file', file);
        created = await api<ProjectDetail>('/api/projects/import', {
          method: 'POST',
          body: formData,
        });
      }
      await refreshProjects();
      if (created) {
        selectProject(created.id);
        onImportedProject?.(created.id);
      }
      onShowOverview();
      const ignored = files.length - supported.length;
      onNotice(`已导入 ${supported.length} 个文件${ignored ? `，忽略 ${ignored} 个不支持的文件` : ''}。`);
    });
  }, [busy, onError, onImportedProject, onNotice, onShowOverview, refreshProjects, runAction, selectProject]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const resetDrag = () => {
      dragDepthRef.current = 0;
      setDraggingFiles(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDraggingFiles(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) setDraggingFiles(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (isImageOrDownloadTarget(event.target)) {
        resetDrag();
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      resetDrag();
      if (files.length) void importCards(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('blur', resetDrag);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('blur', resetDrag);
    };
  }, [importCards]);

  return { draggingFiles, fileInputRef, importCards };
}

function isImageOrDownloadTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('img, a[download]'));
}
