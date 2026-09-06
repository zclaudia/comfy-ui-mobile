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

/** True when the library copy was edited (canvas, cloud download) after the last mirror from the session. */
export function canvasChangedSinceMirror(workflow: Workflow): boolean {
  if (!workflow.agent || !workflow.modifiedAt) return false;
  return workflow.modifiedAt.toISOString() !== workflow.agent.mirroredAt;
}

export function chooseDefaultTab(lastTab: string | null, agentAvailable: boolean): TabPath {
  if (lastTab && (TAB_PATHS as string[]).includes(lastTab)) return lastTab as TabPath;
  return agentAvailable ? '/chats' : '/workflows';
}

export function sessionTitle(session: { name: string; preview?: string; workflow?: SessionWorkflowRef }, fallback: string): string {
  if (session.workflow) return session.workflow.name;
  return session.preview?.trim() || fallback;
}
