import { WorkflowFileService, extractWorkflowName } from '@/core/services/WorkflowFileService';
import {
  ComfyFileService,
  type ServerWorkflowInfo,
} from '@/infrastructure/api/ComfyFileService';
import {
  cacheWorkflowFromCloud,
  loadAllWorkflows,
  removeWorkflowFromCache,
} from '@/infrastructure/storage/IndexedDBWorkflowService';
import {
  listCloudWorkflowDeletes,
  removeCloudWorkflowDelete,
} from '@/infrastructure/sync/CloudWorkflowOutbox';
import { emitCloudWorkflowsUpdated } from '@/infrastructure/sync/WorkflowSyncEvents';
import { cloudFileContent, readCloudWorkflowId, resolveCloudWorkflowId, sanitizeCloudWorkflowFilename } from '@/infrastructure/sync/cloudIdentity';
export { sanitizeCloudWorkflowFilename };
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';

export interface CloudWorkflowSyncResult {
  downloaded: number;
  uploaded: number;
  deleted: number;
  conflicts: number;
  errors: string[];
}

const ensureJsonExtension = (filename: string) => (
  filename.toLowerCase().endsWith('.json') ? filename : `${filename}.json`
);

const workflowBasename = (filename: string) => filename.split('/').pop() || filename;

const uniqueFilename = (preferred: string, occupied: Set<string>, suffix = ''): string => {
  const normalized = ensureJsonExtension(preferred);
  const stem = normalized.slice(0, -5);
  let candidate = suffix ? `${stem} ${suffix}.json` : normalized;
  let counter = 2;
  while (occupied.has(candidate)) {
    candidate = `${stem} ${suffix || 'copy'} ${counter}.json`;
    counter += 1;
  }
  return candidate;
};

const remoteDisplayName = (remote: ServerWorkflowInfo): string => (
  extractWorkflowName(workflowBasename(remote.filename))
);

const workflowContentForCloud = (workflow: Workflow) => cloudFileContent(workflow.workflow_json, {
  name: workflow.name, description: workflow.description, tags: workflow.tags, workflowId: workflow.id, saveOpId: workflow.cloud?.saveOpId,
});

const cacheSyncError = async (workflow: Workflow, filename: string, error: string) => {
  await cacheWorkflowFromCloud({
    ...workflow,
    cloud: {
      provider: 'comfyui',
      filename,
      etag: workflow.cloud?.etag,
      remoteModified: workflow.cloud?.remoteModified,
      lastSyncedAt: workflow.cloud?.lastSyncedAt,
      conflictedFrom: workflow.cloud?.conflictedFrom,
      dirty: true,
      syncError: error,
    },
  });
};

const uploadWorkflow = async (
  service: ComfyFileService,
  workflow: Workflow,
  occupied: Set<string>,
): Promise<{ uploaded: boolean; conflict: boolean; error?: string }> => {
  const linked = !!workflow.cloud?.filename;
  let filename = linked
    ? ensureJsonExtension(workflow.cloud!.filename)
    : uniqueFilename(sanitizeCloudWorkflowFilename(workflow.name), occupied);
  let conflictedFrom = workflow.cloud?.conflictedFrom;

  let response = await service.saveWorkflow(filename, workflowContentForCloud(workflow), {
    expectedEtag: linked ? workflow.cloud?.etag : undefined,
    overwrite: false,
  });

  let conflict = false;
  if (response.conflict) {
    conflict = true;
    conflictedFrom = filename;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    filename = uniqueFilename(filename, occupied, `(conflict ${stamp})`);
    response = await service.saveWorkflow(filename, workflowContentForCloud(workflow), {
      overwrite: false,
    });
  }

  if (!response.success) {
    await cacheSyncError(workflow, filename, response.error || 'Cloud save failed');
    return { uploaded: false, conflict, error: response.error || 'Cloud save failed' };
  }

  occupied.add(filename);
  await cacheWorkflowFromCloud({
    ...workflow,
    workflow_json: workflowContentForCloud(workflow),
    modifiedAt: new Date(response.modified_iso || Date.now()),
    author: 'cloud',
    tags: Array.from(new Set([...(workflow.tags || []), 'cloud'])),
    cloud: {
      provider: 'comfyui',
      filename: response.filename || filename,
      etag: response.etag,
      remoteModified: response.modified,
      lastSyncedAt: new Date().toISOString(),
      dirty: false,
      conflictedFrom,
    },
  });
  return { uploaded: true, conflict };
};

const parseRemoteWorkflow = async (
  service: ComfyFileService,
  remote: ServerWorkflowInfo,
  cached: Workflow | undefined,
  existing: Array<{ id: string; filename?: string }>,
): Promise<Workflow> => {
  const download = await service.downloadWorkflow(remote.filename);
  if (!download.success || !download.content) {
    throw new Error(download.error || `Could not download ${remote.filename}`);
  }

  const file = new File(
    [JSON.stringify(download.content)],
    workflowBasename(remote.filename),
    { type: 'application/json' },
  );
  const processed = await WorkflowFileService.processWorkflowFile(file);
  if (!processed.success || !processed.workflow) {
    throw new Error(processed.error || `Could not parse ${remote.filename}`);
  }

  const modified = download.modified || remote.modified;
  const modifiedDate = modified ? new Date(modified * 1000) : new Date();
  // The id inside the file wins so every device names this workflow the same way; see cloudIdentity.ts.
  const identity = resolveCloudWorkflowId({ cachedId: cached?.id, fileWorkflowId: readCloudWorkflowId(download.content), filename: remote.filename, existing });
  return {
    ...processed.workflow,
    id: identity.id,
    createdAt: cached?.createdAt || modifiedDate,
    modifiedAt: modifiedDate,
    sortOrder: cached?.sortOrder,
    agent: cached?.agent,
    author: 'cloud',
    tags: Array.from(new Set([...(processed.workflow.tags || []), 'cloud'])),
    cloud: {
      provider: 'comfyui',
      filename: remote.filename,
      etag: download.etag || remote.etag,
      remoteModified: modified,
      lastSyncedAt: new Date().toISOString(),
      dirty: false,
      ...(identity.identityConflict ? { identityConflict: true } : {}),
    },
  };
};

const syncImpl = async (serverUrl: string): Promise<CloudWorkflowSyncResult> => {
  const result: CloudWorkflowSyncResult = {
    downloaded: 0,
    uploaded: 0,
    deleted: 0,
    conflicts: 0,
    errors: [],
  };
  const service = new ComfyFileService(serverUrl);
  const initialListing = await service.listWorkflows();
  if (!initialListing.success) throw new Error(initialListing.error || 'Could not list cloud workflows');

  let remoteByFilename = new Map(
    initialListing.workflows.map((workflow) => [workflow.filename, workflow]),
  );

  // Deletes are durable. A conflict means another client changed the file
  // after this client last saw it, so keep the newer server copy.
  for (const tombstone of listCloudWorkflowDeletes()) {
    const remote = remoteByFilename.get(tombstone.filename);
    if (!remote) {
      removeCloudWorkflowDelete(tombstone.filename);
      continue;
    }
    const deletion = await service.deleteWorkflow(tombstone.filename, tombstone.expectedEtag);
    if (deletion.success) {
      removeCloudWorkflowDelete(tombstone.filename);
      remoteByFilename.delete(tombstone.filename);
      result.deleted += 1;
    } else if (deletion.conflict) {
      removeCloudWorkflowDelete(tombstone.filename);
      result.conflicts += 1;
    } else {
      result.errors.push(`${tombstone.filename}: ${deletion.error || 'delete failed'}`);
    }
  }

  let localWorkflows = await loadAllWorkflows();

  // Adopt copies created by the old explicit Import screen. This migration
  // avoids uploading a second file for every previously imported workflow.
  for (const local of localWorkflows) {
    if (local.cloud || local.author?.toLowerCase() !== 'server') continue;
    const matches = [...remoteByFilename.values()].filter(
      (remote) => remoteDisplayName(remote) === local.name,
    );
    if (matches.length !== 1) continue;
    await cacheWorkflowFromCloud({
      ...local,
      cloud: {
        provider: 'comfyui',
        filename: matches[0].filename,
        remoteModified: matches[0].modified,
        dirty: false,
      },
    });
  }

  localWorkflows = await loadAllWorkflows();
  const occupied = new Set(remoteByFilename.keys());

  // Push local work first. Clean entries whose server file disappeared are
  // removed later; dirty ones become conflict copies so no local work is lost.
  for (const local of localWorkflows) {
    if (local.cloud && !local.cloud.dirty) continue;
    const upload = await uploadWorkflow(service, local, occupied);
    if (upload.uploaded) result.uploaded += 1;
    if (upload.conflict) result.conflicts += 1;
    if (upload.error) result.errors.push(`${local.name}: ${upload.error}`);
  }

  // Refresh because uploads and deletes changed the cloud collection.
  const refreshedListing = await service.listWorkflows();
  if (!refreshedListing.success) {
    throw new Error(refreshedListing.error || 'Could not refresh cloud workflows');
  }
  remoteByFilename = new Map(
    refreshedListing.workflows.map((workflow) => [workflow.filename, workflow]),
  );
  localWorkflows = await loadAllWorkflows();
  const localByFilename = new Map(
    localWorkflows
      .filter((workflow) => workflow.cloud?.filename)
      .map((workflow) => [workflow.cloud!.filename, workflow]),
  );

  for (const remote of remoteByFilename.values()) {
    const cached = localByFilename.get(remote.filename);
    if (cached?.cloud?.dirty) continue;
    if (cached?.cloud?.etag && remote.etag && cached.cloud.etag === remote.etag) continue;
    try {
      const existing = localWorkflows.map((w) => ({ id: w.id, filename: w.cloud?.filename }));
      const parsed = await parseRemoteWorkflow(service, remote, cached, existing);
      // Adopting the file's id re-keys the cache entry; drop the row under the old id so the library shows one copy.
      if (cached && cached.id !== parsed.id) await removeWorkflowFromCache(cached.id);
      await cacheWorkflowFromCloud(parsed);
      result.downloaded += 1;
    } catch (error) {
      result.errors.push(`${remote.filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const remoteNames = new Set(remoteByFilename.keys());
  for (const cached of await loadAllWorkflows()) {
    if (!cached.cloud || cached.cloud.dirty || remoteNames.has(cached.cloud.filename)) continue;
    await removeWorkflowFromCache(cached.id);
  }

  emitCloudWorkflowsUpdated();
  return result;
};

let activeSync: Promise<CloudWorkflowSyncResult> | null = null;

export const syncCloudWorkflows = (serverUrl: string): Promise<CloudWorkflowSyncResult> => {
  if (!activeSync) {
    activeSync = syncImpl(serverUrl).finally(() => {
      activeSync = null;
    });
  }
  return activeSync;
};

