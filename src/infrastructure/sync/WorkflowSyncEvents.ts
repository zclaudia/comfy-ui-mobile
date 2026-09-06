import type { Workflow } from '@/shared/types/app/IComfyWorkflow';

export const WORKFLOW_LOCAL_CHANGE_EVENT = 'comfy-workflow-local-change';
export const WORKFLOW_CLOUD_UPDATED_EVENT = 'comfy-cloud-workflows-updated';
export const WORKFLOW_SYNC_STATUS_EVENT = 'comfy-workflow-sync-status';

export type WorkflowLocalChangeDetail =
  | { type: 'upsert'; workflowId: string }
  | { type: 'delete'; workflow: Workflow };

export type WorkflowSyncStatus = {
  state: 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'conflict';
  message?: string;
  syncedAt?: string;
};

let latestWorkflowSyncStatus: WorkflowSyncStatus = { state: 'idle' };

const dispatch = (name: string, detail?: unknown) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
};

export const emitWorkflowLocalChange = (detail: WorkflowLocalChangeDetail) => {
  dispatch(WORKFLOW_LOCAL_CHANGE_EVENT, detail);
};

export const emitCloudWorkflowsUpdated = () => {
  dispatch(WORKFLOW_CLOUD_UPDATED_EVENT);
};

export const emitWorkflowSyncStatus = (status: WorkflowSyncStatus) => {
  latestWorkflowSyncStatus = status;
  dispatch(WORKFLOW_SYNC_STATUS_EVENT, status);
};

export const getWorkflowSyncStatus = (): WorkflowSyncStatus => latestWorkflowSyncStatus;
