import type { CloudWorkflowMetadata } from '@/shared/types/app/IComfyWorkflow';

const DELETE_OUTBOX_KEY = 'comfy_mobile_cloud_workflow_delete_outbox_v1';

export interface CloudWorkflowDeleteTombstone {
  filename: string;
  expectedEtag?: string;
  queuedAt: string;
}

const read = (): CloudWorkflowDeleteTombstone[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(DELETE_OUTBOX_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item?.filename === 'string') : [];
  } catch {
    return [];
  }
};

const write = (entries: CloudWorkflowDeleteTombstone[]) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DELETE_OUTBOX_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn('Could not persist cloud workflow delete outbox:', error);
  }
};

export const listCloudWorkflowDeletes = (): CloudWorkflowDeleteTombstone[] => read();

export const queueCloudWorkflowDelete = (cloud?: CloudWorkflowMetadata) => {
  if (!cloud?.filename) return;
  const entries = read().filter((entry) => entry.filename !== cloud.filename);
  entries.push({
    filename: cloud.filename,
    expectedEtag: cloud.etag,
    queuedAt: new Date().toISOString(),
  });
  write(entries);
};

export const removeCloudWorkflowDelete = (filename: string) => {
  write(read().filter((entry) => entry.filename !== filename));
};

