import type { WorkspaceApi } from '../api/WorkspaceApi';
import type { ComfyFileService } from '../api/ComfyFileService';
import type { WorkspaceLibraryOperation } from '../../shared/types/agentWorkspace';

export interface WorkspaceLibraryPorts {
  serverId: string;
  api: Pick<WorkspaceApi, 'librarySave' | 'librarySaveAction'>;
  files: Pick<ComfyFileService, 'saveWorkflow'>;
  beforeWrite?: (operation: WorkspaceLibraryOperation) => Promise<void>;
}

/** An interrupted attempt always resumes the stored content and original precondition. */
export class WorkspaceLibrarySaveService {
  constructor(readonly ports: WorkspaceLibraryPorts) {}
  async resume(sessionId: string, operationId: string, allowWrite: boolean): Promise<WorkspaceLibraryOperation> {
    const { api, files } = this.ports;
    let op = (await api.librarySave(sessionId, operationId)).operation;
    if (op.target.serverId !== this.ports.serverId) throw new Error('入库目标不属于当前服务器');
    const step = async (action: 'prepare' | 'applying' | 'reconcile') => { op = (await api.librarySaveAction(sessionId, operationId, action)).operation; };
    if (op.state === 'pending' && allowWrite) {
      await step('prepare');
      if (op.state === 'pending') {
        await this.ports.beforeWrite?.(op);
        await step('applying');
      }
    }
    if (op.state === 'applying' || op.state === 'reconciling') await step('reconcile');
    if (op.state === 'reconciling' && allowWrite) {
      if (!op.content || !op.contentDigest || (op.mode === 'update' && !op.target.expectedEtag)) throw new Error('入库记录缺少固定内容或版本条件');
      await this.ports.beforeWrite?.(op);
      // A thrown transport error or 409 can follow another device completing this exact write. Read back either way.
      try { await files.saveWorkflow(op.target.filename, op.content, op.mode === 'create' ? { overwrite: false } : { expectedEtag: op.target.expectedEtag }); }
      catch { /* The authoritative outcome is the Gateway's read-back below. */ }
      await step('reconcile');
    }
    return op;
  }
}
