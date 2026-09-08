import type { Workflow } from '../../shared/types/app/IComfyWorkflow';
import type { LibrarySave, SourceRef } from '../../infrastructure/api/AgentApi';

export const LAST_TAB_KEY = 'comfy_mobile_last_tab';
export type TabPath = '/chats' | '/workflows' | '/outputs';
export const TAB_PATHS: TabPath[] = ['/chats', '/workflows', '/outputs'];

/** Suggestion chips prefill the composer with these; the assistant picks the template from the description. */
export const NEW_CHAT_PRESETS = {
  image: '生成一张 1024×1024 的图片：',
  video: '用 H3 生成一段 1 秒的短视频：',
} as const;

/** Library workflows are addressed across devices by `serverId + workflowId`; the server id is the normalised ComfyUI origin. */
export function serverIdOf(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** The library entry a session last saved into, if this device still holds it. Id first, then the cloud filename. */
export function resolveSavedTarget(save: LibrarySave | undefined, workflows: Workflow[]): Workflow | undefined {
  if (!save) return undefined;
  return workflows.find(w => w.id === save.workflowId) ?? workflows.find(w => w.cloud?.filename === save.filename);
}

export function chooseDefaultTab(lastTab: string | null, agentAvailable: boolean): TabPath {
  if (lastTab === '/chats' && !agentAvailable) return '/workflows';
  if (lastTab && (TAB_PATHS as string[]).includes(lastTab)) return lastTab as TabPath;
  return agentAvailable ? '/chats' : '/workflows';
}

/** Names new sessions get before anyone renames them; they must fall through to the preview. Keep in sync with `agentUI.新对话` (and the older `新工作流`). */
export const SESSION_NAME_PLACEHOLDERS = new Set(['新对话', 'New chat', '新しいチャット', '새 대화', '新工作流', 'New workflow', '新しいワークフロー', '새 워크플로']);

/** A name the user actually chose → the first message → the fallback. The source workflow's name is never the title. */
export function sessionTitle(session: { name?: string; preview?: string; sourceRef?: SourceRef }, fallback: string): string {
  const name = session.name?.trim();
  if (name && !SESSION_NAME_PLACEHOLDERS.has(name)) return name;
  return session.preview?.trim() || fallback;
}
