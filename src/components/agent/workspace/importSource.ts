import type { SourceRef } from '../../../infrastructure/api/AgentApi';
import type { Workflow } from '../../../shared/types/app/IComfyWorkflow';
import { readCloudWorkflowId } from '../../../infrastructure/sync/cloudIdentity';

/** The library cache is shared between connections. A filename alone cannot establish an update target on this server. */
export function verifiedImportSource(workflow: Workflow, serverId: string | undefined, remote: { success: boolean; content?: unknown; etag?: string }): SourceRef | undefined {
  if (!serverId || !workflow.cloud?.filename || !workflow.cloud.etag || !remote.success || remote.etag !== workflow.cloud.etag || readCloudWorkflowId(remote.content) !== workflow.id) return undefined;
  return { serverId, workflowId: workflow.id, filename: workflow.cloud.filename, name: workflow.name, etag: remote.etag };
}
