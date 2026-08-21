import type { Dispatch, SetStateAction } from 'react';
import { api, jsonBody } from '../../../api';
import type { GlossaryTerm, ProjectDetail } from '../../../types';
import type { RunWorkbenchAction } from '../contracts';

interface UseGlossaryActionsOptions {
  project: ProjectDetail | null;
  setGlossary: Dispatch<SetStateAction<GlossaryTerm[]>>;
  runAction: RunWorkbenchAction;
}

export function useGlossaryActions({ project, setGlossary, runAction }: UseGlossaryActionsOptions) {
  async function addGlossaryTerm(input: Omit<GlossaryTerm, 'id' | 'createdAt' | 'updatedAt'>) {
    if (!project) return;
    await runAction('glossary', async () => {
      await api(`/api/projects/${project.id}/glossary`, { method: 'POST', ...jsonBody(input) });
      setGlossary(await api<GlossaryTerm[]>(`/api/projects/${project.id}/glossary`));
    });
  }

  async function deleteGlossaryTerm(termId: string) {
    if (!project) return;
    await runAction('glossary-delete', async () => {
      await api(`/api/glossary/${termId}`, { method: 'DELETE' });
      setGlossary((current) => current.filter((term) => term.id !== termId));
    });
  }

  return { addGlossaryTerm, deleteGlossaryTerm };
}
