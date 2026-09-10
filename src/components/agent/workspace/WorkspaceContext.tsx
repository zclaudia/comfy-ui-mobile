import { createContext, useContext } from 'react';
import type { WorkspaceApi } from '../../../infrastructure/api/WorkspaceApi';
import type { useWorkspaceSnapshot } from './useWorkspaceSnapshot';

export interface WorkspaceController { api: WorkspaceApi; sessionId: string; view: ReturnType<typeof useWorkspaceSnapshot> }
export const WorkspaceContext = createContext<WorkspaceController | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace UI requires a session');
  return value;
}
