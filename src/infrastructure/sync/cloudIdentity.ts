/**
 * Cross-device identity of a cloud workflow.
 *
 * A file in ComfyUI's workflow directory carries its own id in `extra.comfy_mobile_cloud.workflow_id`. That id is what
 * chat sessions cite as their source or save target, so every device must agree on it: the local IndexedDB id follows
 * the file, not the other way round. Filenames only locate the file and may change.
 */
import type { IComfyJson } from '../../shared/types/app/IComfyJson';

export const CLOUD_SCHEMA = 2;

const ensureJsonExtension = (filename: string) => (filename.toLowerCase().endsWith('.json') ? filename : `${filename}.json`);

/** The server filename a display name maps to. Deterministic, so a retried save targets the same file. */
export const sanitizeCloudWorkflowFilename = (name: string): string => {
  const safeName = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a filename must not contain
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180);
  return ensureJsonExtension(safeName || 'Untitled Workflow');
};

export interface CloudFileMeta { schema?: number; workflow_id?: string; save_op_id?: string }

const cloudMeta = (content: unknown): CloudFileMeta | undefined => {
  const extra = (content as { extra?: { comfy_mobile_cloud?: unknown } } | undefined)?.extra;
  const meta = extra?.comfy_mobile_cloud;
  return meta && typeof meta === 'object' ? meta as CloudFileMeta : undefined;
};
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

export const readCloudWorkflowId = (content: unknown): string | undefined => {
  const id = cloudMeta(content)?.workflow_id;
  return validId(id) ? id : undefined;
};
export const readCloudSaveOpId = (content: unknown): string | undefined => {
  const id = cloudMeta(content)?.save_op_id;
  return validId(id) ? id : undefined;
};

/** Filename-derived fallback id for files that carry no id of their own (pre-schema-2 uploads, hand-written files). */
export const stableCloudId = (filename: string): string => {
  // Two independent 32-bit hashes keep IDs compact and route-safe while making a collision across a personal library
  // vanishingly small.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of new TextEncoder().encode(filename.normalize('NFC'))) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  return `cloud_${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
};

export interface CloudIdentityInput {
  /** Id this device already holds for the same filename, if any. */
  cachedId?: string;
  /** `workflow_id` read from the downloaded file. */
  fileWorkflowId?: string;
  filename: string;
  /** Every other local entry, so a duplicated file cannot steal an id that is already in use. */
  existing: Array<{ id: string; filename?: string }>;
}
export interface CloudIdentity {
  id: string;
  /** The file claims an id another file already owns (copied on the server). It keeps a filename-derived id and needs re-linking. */
  identityConflict: boolean;
}

/**
 * Order of preference: the id this device already uses → the id inside the file → a filename-derived id.
 * A cached entry adopts the file id when nobody else holds it, so devices converge after the first sync.
 */
export function resolveCloudWorkflowId({ cachedId, fileWorkflowId, filename, existing }: CloudIdentityInput): CloudIdentity {
  const others = existing.filter(w => w.filename !== filename && w.id !== cachedId);
  const taken = !!fileWorkflowId && others.some(w => w.id === fileWorkflowId);
  if (fileWorkflowId && !taken) return { id: fileWorkflowId, identityConflict: false };
  if (cachedId) return { id: cachedId, identityConflict: taken };
  return { id: stableCloudId(filename), identityConflict: taken };
}

/** The bytes written to the server: the graph plus display metadata plus the identity block. */
export function cloudFileContent(workflowJson: IComfyJson | undefined, meta: { name: string; description?: string; tags?: string[]; workflowId: string; saveOpId?: string }): IComfyJson {
  const content = JSON.parse(JSON.stringify(workflowJson || {}));
  content.extra = {
    ...(content.extra || {}),
    name: meta.name,
    description: meta.description,
    tags: meta.tags,
    comfy_mobile_cloud: { schema: CLOUD_SCHEMA, workflow_id: meta.workflowId, ...(meta.saveOpId ? { save_op_id: meta.saveOpId } : {}) },
  };
  return content;
}
