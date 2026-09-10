import { cacheWorkflowFromCloud, findWorkflowById, loadAllWorkflows } from '../storage/IndexedDBWorkflowService';
import { removeCloudWorkflowDelete } from '../sync/CloudWorkflowOutbox';
import { emitCloudWorkflowsUpdated } from '../sync/WorkflowSyncEvents';
import type { WorkspaceLibraryOperation } from '../../shared/types/agentWorkspace';

async function target(op: WorkspaceLibraryOperation) {
  const cached = (await findWorkflowById(op.target.workflowId)) ?? (await loadAllWorkflows()).find(item => item.cloud?.filename === op.target.filename);
  if (cached && (cached.cloud?.dirty || cached.id !== op.target.workflowId || (cached.cloud?.filename && cached.cloud.filename !== op.target.filename))) throw new Error('本机工作流有未同步修改或身份冲突，请先处理后再入库');
  return cached;
}
export async function beforeWorkspaceLibraryWrite(op: WorkspaceLibraryOperation) {
  await target(op);
  removeCloudWorkflowDelete(op.target.filename);
}
export async function cacheWorkspaceLibrarySave(op: WorkspaceLibraryOperation) {
  if (op.state !== 'succeeded' || !op.content || !op.result?.etag) return;
  const cached = await target(op); const at = new Date();
  const extra = op.content.extra ?? {};
  await cacheWorkflowFromCloud({ ...(cached ?? {}), id: op.target.workflowId, name: op.target.name, workflow_json: op.content,
    description: typeof extra.description === 'string' ? extra.description : undefined,
    nodeCount: op.content.nodes.length, createdAt: cached?.createdAt ?? at, modifiedAt: at, isValid: true, author: 'cloud',
    tags: [...new Set([...(Array.isArray(extra.tags) ? extra.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : []), 'cloud'])],
    cloud: { provider: 'comfyui', filename: op.target.filename, etag: op.result.etag, lastSyncedAt: at.toISOString(), dirty: false, saveOpId: op.id } });
  emitCloudWorkflowsUpdated();
}
