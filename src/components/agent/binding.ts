import type { Workflow } from '../../shared/types/app/IComfyWorkflow';
import type { SessionWorkflowRef } from '../../infrastructure/api/AgentApi';

export const LAST_TAB_KEY = 'comfy_mobile_last_tab';
export type TabPath = '/chats' | '/workflows' | '/outputs';
export const TAB_PATHS: TabPath[] = ['/chats', '/workflows', '/outputs'];

/** Suggestion chips prefill the composer with these; the assistant picks the template from the description. */
export const NEW_CHAT_PRESETS = {
  image: '生成一张 1024×1024 的图片：',
  video: '用 H3 生成一段 1 秒的短视频：',
} as const;

/** Id first; a workflow re-downloaded from cloud on another device has a different id but the same filename. */
export function resolveBoundWorkflow(ref: SessionWorkflowRef | undefined, workflows: Workflow[]): Workflow | undefined {
  if (!ref) return undefined;
  return workflows.find(w => w.id === ref.id) ?? (ref.filename ? workflows.find(w => w.cloud?.filename === ref.filename) : undefined);
}

/** Deterministic hash of a canvas: keys sorted so re-serialisation (cloud download, editor save) does not change it. */
export function hashCanvas(canvas: unknown): string {
  const text = JSON.stringify(canvas, (_key, value) => (value && typeof value === 'object' && !Array.isArray(value)) ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(k => [k, (value as Record<string, unknown>)[k]])) : value);
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0; }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** True when the library copy no longer matches what this session last mirrored/pushed. Unbound workflows never import. */
export function canvasChangedSinceMirror(workflow: Workflow, sessionId: string): boolean {
  if (!workflow.agent) return false;
  return workflow.agent.sessionId !== sessionId || hashCanvas(workflow.workflow_json) !== workflow.agent.mirroredHash;
}

export function chooseDefaultTab(lastTab: string | null, agentAvailable: boolean): TabPath {
  if (lastTab === '/chats' && !agentAvailable) return '/workflows';
  if (lastTab && (TAB_PATHS as string[]).includes(lastTab)) return lastTab as TabPath;
  return agentAvailable ? '/chats' : '/workflows';
}

export function sessionTitle(session: { preview?: string; workflow?: SessionWorkflowRef }, fallback: string): string {
  if (session.workflow) return session.workflow.name;
  return session.preview?.trim() || fallback;
}
