import { useRef, type Dispatch, type SetStateAction } from 'react';
import { api, jsonBody } from '@/shared/api/http';
import type { GlossaryTerm, ProjectDetail } from '@/shared/types';
import type { RunWorkbenchAction } from '@/shared/model/workbench-actions';

interface UseGlossaryActionsOptions {
  project: ProjectDetail | null;
  setGlossary: Dispatch<SetStateAction<GlossaryTerm[]>>;
  runAction: RunWorkbenchAction;
}

export function useGlossaryActions({ project, setGlossary, runAction }: UseGlossaryActionsOptions) {
  const projectIdRef = useRef(project?.id);
  projectIdRef.current = project?.id;
  async function addGlossaryTerm(input: Omit<GlossaryTerm, 'id' | 'createdAt' | 'updatedAt'>) {
    if (!project) return;
    await runAction('glossary', async () => {
      await api(`/api/projects/${project.id}/glossary`, { method: 'POST', ...jsonBody(input) });
      const terms = await api<GlossaryTerm[]>(`/api/projects/${project.id}/glossary`);
      if (projectIdRef.current === project.id) setGlossary(terms);
    });
  }

  async function deleteGlossaryTerm(termId: string) {
    if (!project) return;
    await runAction('glossary-delete', async () => {
      await api(`/api/glossary/${termId}`, { method: 'DELETE' });
      if (projectIdRef.current === project.id) setGlossary((current) => current.filter((term) => term.id !== termId));
    });
  }

  return { addGlossaryTerm, deleteGlossaryTerm };
}
